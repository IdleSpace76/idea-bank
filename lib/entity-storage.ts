import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { B2Storage } from "./b2-storage";
import { MAX_CLOUD_JSON_BYTES, StorageError, invalid, parseCloudSnapshot, revisionPattern, type CloudMedia } from "./cloud-library";
import { canonicalLibrary, contentId, entityKey, equal, flattenLibrary, keyParts, parseEntity, stable, type EntityChange, type EntityValue, type EntityIndex, type EntityRead, type EntityVersion } from "./entity-sync";
import { CatalogStorage } from "./catalog-storage";
import type { ScopedRead, SyncTarget } from "./scoped-types";
import { cachedStorageRead } from "./storage-read-cache";

type Manifest = { format: "idea-bank-index"; version: 2; revision: string; parents: string[]; index: EntityIndex; digest: string; legacy?: string };
type Graph = Map<string, { key: string; parents: string[]; legacy?: string }>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => { const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }; return ["NoSuchKey","NotFound"].includes(e?.name || "") || e?.$metadata?.httpStatusCode === 404; };
const uuids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 16 && value.every(id => typeof id === "string" && revisionPattern.test(id)) && new Set(value).size === value.length;
export class EntityStorage {
  readonly prefix: string;
  private manifests = new Map<string, Manifest>();
  private legacyParents = new Map<string,string[]>();
  constructor(readonly storage: B2Storage) { this.prefix = `${storage.prefix}/sync-v2`; }
  catalog() { return new CatalogStorage(this); }
  private versionKey(key: string, revision: string) { return `${this.prefix}/records/${hash(key)}/${revision}.json`; }
  private manifestKey(parents: string[], id: string, legacy?: string) { return `${this.prefix}/indexes/${legacy ? `${legacy}~` : ""}${parents.join("+") || "root"}_${id}.json`; }
  private async getJson(key: string): Promise<unknown | null> {
    try {
      const object = await this.storage.client.send(new GetObjectCommand({ Bucket: this.storage.settings.bucket, Key: key }));
      if (!object.Body || !object.ContentLength || object.ContentLength > MAX_CLOUD_JSON_BYTES) throw new StorageError(502,"INVALID_HISTORY","Облачная запись повреждена.");
      return JSON.parse(await object.Body.transformToString());
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private async putImmutable(key: string, value: unknown) {
    const body = stable(value);
    if (Buffer.byteLength(body) > MAX_CLOUD_JSON_BYTES) throw new StorageError(413,"LIBRARY_TOO_LARGE","Облачная запись превышает 3 МиБ.");
    const existing = await this.getJson(key);
    if (existing !== null) { if (!equal(existing,value)) throw new StorageError(409,"OPERATION_REUSED","Идентификатор операции уже использован."); return; }
    // The key and exact body are deterministic for a request, including simultaneous retries.
    await this.storage.client.send(new PutObjectCommand({ Bucket: this.storage.settings.bucket, Key: key, Body: body, ContentType: "application/json", ContentMD5: createHash("md5").update(body).digest("base64") }));
  }
  async graph(): Promise<Graph> {
    const graph: Graph = new Map(), prefix = `${this.prefix}/indexes/`;
    let token: string | undefined;
    do {
      const page = await this.storage.client.send(new ListObjectsV2Command({ Bucket: this.storage.settings.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents || []) {
        const match = /^(?:([a-f0-9-]{36})~)?(root|[a-f0-9+-]+)_([a-f0-9-]{36})\.json$/.exec(object.Key!.slice(prefix.length));
        const parents = match?.[2] === "root" ? [] : (match?.[2] || "").split("+");
        if (!match || !revisionPattern.test(match[3]) || (match[1] && !revisionPattern.test(match[1])) || !uuids(parents) || graph.has(match[3])) throw new StorageError(502,"INVALID_HISTORY","Индекс изменений повреждён.");
        graph.set(match[3], { key: object.Key!, parents, ...(match[1] ? {legacy:match[1]} : {}) });
        if (graph.size > 100000) throw new StorageError(507,"HISTORY_LIMIT","Достигнут лимит истории изменений.");
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw new StorageError(502,"INVALID_HISTORY","Не удалось прочитать индекс изменений.");
    } while (token);
    // Validate the DAG iteratively before using causal relationships to discard old heads.
    const states = new Map<string, number>();
    for (const id of graph.keys()) {
      const stack: [string,boolean][] = [[id,false]];
      while (stack.length) {
        const [current, exit] = stack.pop()!;
        if (exit) { states.set(current,2); continue; }
        if (states.get(current) === 2) continue;
        if (!graph.has(current) || states.get(current) === 1) throw new StorageError(502,"INVALID_HISTORY","Связи версий повреждены.");
        states.set(current,1); stack.push([current,true]);
        for (const parent of graph.get(current)!.parents) stack.push([parent,false]);
      }
    }
    return graph;
  }
  private heads(graph: Graph) {
    const parents = new Set([...graph.values()].flatMap(v => v.parents)), candidates = [...graph.keys()].filter(id => !parents.has(id));
    return candidates.filter(id => !candidates.some(other => id !== other && this.ancestor(id,other,graph))).sort();
  }
  private legacyAncestor(older: string, newer: string) {
    const pending=[newer], seen=new Set<string>();
    while(pending.length) { const id=pending.pop()!; if(id===older)return true; if(seen.has(id))continue; seen.add(id); pending.push(...(this.legacyParents.get(id)||[])); }
    return false;
  }
  private ancestor(older: string, newer: string, graph: Graph) {
    const pending = [newer], seen = new Set<string>(), legacy = graph.get(older)?.legacy;
    while (pending.length) { const id = pending.pop()!; if (id === older || (legacy && graph.get(id)?.legacy && (legacy === graph.get(id)!.legacy ? older.localeCompare(id) < 0 : this.legacyAncestor(legacy,graph.get(id)!.legacy!)))) return true; if (seen.has(id)) continue; seen.add(id); pending.push(...(graph.get(id)?.parents || [])); }
    return false;
  }
  private async manifest(id: string, graph: Graph): Promise<Manifest> {
    if (this.manifests.has(id)) return this.manifests.get(id)!;
    const entry = graph.get(id); if (!entry) throw new StorageError(409,"STALE_INDEX","Облачный индекс изменился. Повтори синхронизацию.");
    const value = await this.getJson(entry.key) as Manifest | null;
    if (!value || value.format !== "idea-bank-index" || value.version !== 2 || value.revision !== id || value.legacy !== entry.legacy || !equal(value.parents, entry.parents) || !value.index || typeof value.index !== "object" || Array.isArray(value.index) || !/^[a-f0-9]{64}$/.test(value.digest)) throw new StorageError(502,"INVALID_HISTORY","Индекс изменений повреждён.");
    for (const [key, revisions] of Object.entries(value.index)) { keyParts(key); if (!uuids(revisions) || !revisions.length || revisions.some(r => !this.ancestor(r,id,graph))) throw new StorageError(502,"INVALID_HISTORY","Неверные версии в индексе."); }
    this.manifests.set(id,value); return value;
  }
  private async index(heads: string[], graph: Graph): Promise<EntityIndex> {
    const result: EntityIndex = Object.create(null);
    for (const head of heads) for (const [key, versions] of Object.entries((await this.manifest(head,graph)).index)) result[key] = [...new Set([...(result[key] || []), ...versions])];
    const anchors = [...graph.entries()].filter(([id,entry]) => entry.legacy && heads.some(head => this.ancestor(id,head,graph)));
    for (const [key,versions] of Object.entries(result)) for (const [id,entry] of anchors) {
      if (Object.hasOwn((await this.manifest(id,graph)).index,key)) continue;
      let existed = versions.some(version => this.ancestor(version,id,graph));
      if (!existed) for (const [older,old] of anchors) if (older !== id && this.legacyAncestor(old.legacy!,entry.legacy!) && Object.hasOwn((await this.manifest(older,graph)).index,key)) { existed=true;break; }
      if (existed && !versions.includes(id)) versions.push(id);
    }
    for (const [key, versions] of Object.entries(result)) result[key] = versions.filter(id => !versions.some(other => other !== id && this.ancestor(id,other,graph))).sort();
    return result;
  }
  async version(key: string, revision: string): Promise<EntityVersion> {
    const value = await cachedStorageRead(this.storage,this.versionKey(key,revision),()=>this.loadVersion(key,revision));
    if (value) return value;
    {
      const graph=await this.graph(), entry=graph.get(revision);
      if (entry?.legacy && !Object.hasOwn((await this.manifest(revision,graph)).index,key)) {
        const previous: EntityValue[]=[];
        if (["idea","section"].includes(keyParts(key).kind)) for (const [id,old] of graph) if (id!==revision && old.legacy && this.legacyAncestor(old.legacy,entry.legacy)) {
          const manifest=await this.manifest(id,graph);
          for(const oldRevision of manifest.index[key]||[]) {
            const record=await this.getJson(this.versionKey(key,oldRevision)) as EntityVersion|null;
            if(record?.value) { const oldValue=parseEntity(key,record.value)!; if(!previous.some(v=>equal(v,oldValue)))previous.push(oldValue); }
          }
        }
        return {key,revision,value:null,...(previous.length?{previous:previous.slice(0,16)}:{})};
      }
    }
    throw new StorageError(502,"INVALID_HISTORY","Версия записи не найдена.");
  }
  /** Cache physical validated records only; version() assembles context-dependent legacy tombstones. */
  private async loadVersion(key: string, revision: string): Promise<EntityVersion | null> {
    const value = await this.getJson(this.versionKey(key,revision)) as EntityVersion | null;
    if (!value) return null;
    if (value.key !== key || value.revision !== revision) throw new StorageError(502,"INVALID_HISTORY","Версия записи не найдена.");
    const previous = value.previous?.map(v => parseEntity(key,v)).filter(v => v !== null) as EntityValue[] | undefined;
    return { key, revision, value: parseEntity(key,value.value), ...(previous?.length ? { previous } : {}) };
  }
  /** Import current legacy heads only; the original snapshot history remains available in v1. */
  async migrateLegacy() {
    const legacy = await this.storage.listRevisions();
    this.legacyParents = new Map([...legacy.revisions].map(([id,entry])=>[id,entry.parents]));
    if (!legacy.revisions.size) return;
    await this.putImmutable(`${this.prefix}/legacy-lock.json`, { format: "idea-bank-sync-v2" });
    const graph = await this.graph();
    for (const id of legacy.heads) {
      if ([...graph.values()].some(entry => entry.legacy === id)) continue;
      const entry = legacy.revisions.get(id)!;
      const pending = [...entry.parents], visited = new Set<string>(), ancestors = new Set<string>();
      while (pending.length) {
        const parent = pending.pop()!; if (visited.has(parent)) continue; visited.add(parent);
        const imported = [...graph.entries()].filter(([,entry]) => entry.legacy === parent).map(([revision]) => revision);
        if (imported.length) for (const revision of imported) ancestors.add(revision);
        else pending.push(...legacy.revisions.get(parent)!.parents);
      }
      const parents = [...ancestors].filter(parent => ![...ancestors].some(other => other !== parent && this.ancestor(parent,other,graph))).sort();
      if (!uuids(parents)) throw new StorageError(409,"INVALID_HISTORY","Слишком много веток старой истории.");
      const revision = this.identity(`legacy:${id}:${parents.join("+")}`);
      const snapshot = parseCloudSnapshot(await this.getJson(entry.key));
      if (snapshot.revision !== id || !equal(snapshot.parents,entry.parents)) throw new StorageError(502,"INVALID_HISTORY","Старая версия повреждена.");
      const library = canonicalLibrary(snapshot.library,snapshot.media), files = snapshot.media.map(file => ({ ...file,id:contentId(file) }));
      const values = flattenLibrary(library,[...new Map(files.map(file => [file.id,file])).values()]);
      const index = await this.index(parents,graph);
      const keys=[...new Set([...Object.keys(index),...Object.keys(values)])];
      for(let start=0;start<keys.length;start+=12) await Promise.all(keys.slice(start,start+12).map(async key=>{
        const value = values[key] || null, previous = await this.recovery(key,value,index[key] || []);
        await this.putImmutable(this.versionKey(key,revision),{key,revision,value,...(previous.length ? {previous} : {})}); index[key]=[revision];
      }));
      const manifest: Manifest={format:"idea-bank-index",version:2,revision,parents,index,legacy:id,digest:hash(`legacy:${id}`)};
      const key=this.manifestKey(parents,revision,id); await this.putImmutable(key,manifest); this.manifests.set(revision,manifest); graph.set(revision,{key,parents,legacy:id});
      await this.catalog().publish(revision,parents);
    }
  }
  async status() {
    const legacy=await this.storage.listRevisions(), graph=await this.graph();
    return {version:2,active:graph.size>0,requiresMigration:legacy.revisions.size>0&&graph.size===0};
  }
  async read(known: EntityIndex = {}, migrate = true): Promise<EntityRead> {
    if (migrate) await this.migrateLegacy();
    else { const legacy=await this.storage.listRevisions(); this.legacyParents=new Map([...legacy.revisions].map(([id,entry])=>[id,entry.parents])); }
    const graph = await this.graph(), heads = this.heads(graph), index = await this.index(heads,graph), records: EntityVersion[] = [];
    for (const [key, versions] of Object.entries(index)) if (!equal(known[key],versions)) for (const revision of versions) records.push(await this.version(key,revision));
    // Repair a frontier publication interrupted after the authoritative manifest was committed.
    for (const head of heads) await this.catalog().publish(head,graph.get(head)!.parents);
    return { heads, index, records };
  }
  /** Build a read projection once per frontier, without downloading block bodies. */
  async catalogIndex(frontier?: string[]): Promise<{ heads: string[]; index: EntityIndex }> {
    const legacy = await this.storage.listRevisions();
    this.legacyParents = new Map([...legacy.revisions].map(([id,entry]) => [id,entry.parents]));
    const graph = await this.graph();
    if (legacy.revisions.size && !graph.size) throw new StorageError(409,"MIGRATION_REQUIRED","Требуется переход на новую синхронизацию.");
    const candidates = frontier ?? this.heads(graph);
    if (!uuids(candidates) || candidates.some(id => !graph.has(id))) throw new StorageError(409,"STALE_INDEX","Облачный индекс изменился.");
    const heads = candidates.filter(id => !candidates.some(other => id !== other && this.ancestor(id,other,graph))).sort();
    return { heads, index: await this.index(heads,graph) };
  }
  /** Read one edit/conflict domain. Unrelated idea bodies never leave storage. */
  async readScoped(target: SyncTarget, includeIdeas: string[] = [],includeMedia:string[]=[]): Promise<ScopedRead> {
    if (!target || !["idea","section","section-tree"].includes(target.kind) || typeof target.id!=="string" || !target.id || target.id.length>200 || !Array.isArray(includeIdeas) || includeIdeas.length>10000 || includeIdeas.some(id=>typeof id!=="string" || !id || id.length>200)) return invalid();
    if(!Array.isArray(includeMedia) || includeMedia.length>10000 || includeMedia.some(id=>typeof id!=="string" || !/^[a-f0-9]{64}-[a-f0-9]{32}$/.test(id)))return invalid();
    const source=await this.catalogIndex(), selected=new Set<string>(), records=new Map<string,EntityVersion>();
    const load=async(key:string)=>{
      selected.add(key);
      const values=await Promise.all((source.index[key] || []).map(async revision=>{
        const identity=JSON.stringify([key,revision]);
        if(!records.has(identity))records.set(identity,await this.version(key,revision));
        return records.get(identity)!;
      }));return values;
    };
    const ideas=new Set(includeIdeas);
    if(target.kind==="idea")ideas.add(target.id);
    if(target.kind==="section")await load(entityKey("section",target.id));
    else {
      for(const key of Object.keys(source.index))if(keyParts(key).kind==="section")await load(key);
      if(target.kind==="section-tree") {
        await load(entityKey("section",target.id));
        const keys=Object.keys(source.index).filter(key=>keyParts(key).kind==="idea");
        for(let n=0;n<keys.length;n+=12)await Promise.all(keys.slice(n,n+12).map(async key=>{
          const values=await Promise.all(source.index[key].map(id=>this.version(key,id)));
          if(values.some(record=>[record.value,...(record.previous || [])].some(value=>value && "sectionId" in value && value.sectionId===target.id)))ideas.add(keyParts(key).ids[0]);
        }));
      }
      for(const id of ideas)await load(entityKey("idea",id));
      const blockKeys=Object.keys(source.index).filter(key=>{const part=keyParts(key);return part.kind==="block" && ideas.has(part.ids[0]);});
      for(let n=0;n<blockKeys.length;n+=12)await Promise.all(blockKeys.slice(n,n+12).map(load));
      const media=new Set<string>();
      for(const record of records.values())if(record.value){
        const value=record.value as {coverImage?:{id:string};media?:{id:string}[]};
        if(value.coverImage)media.add(value.coverImage.id);
        for(const file of value.media || [])media.add(file.id);
      }
      for(const id of media)await load(entityKey("media",id));
    }
    for(const id of includeMedia)await load(entityKey("media",id));
    return {target,heads:source.heads,index:Object.fromEntries([...selected].filter(key=>source.index[key]).map(key=>[key,source.index[key]])),records:[...records.values()]};
  }
  async save(input: unknown): Promise<{ revision: string }> {
    if (!input || typeof input !== "object") return invalid();
    const value = input as { operationId: string; heads: string[]; changes: EntityChange[] };
    if (!revisionPattern.test(value.operationId) || !uuids(value.heads) || !Array.isArray(value.changes) || !value.changes.length || value.changes.length > 10000) return invalid();
    const seen = new Set<string>();
    const changes = value.changes.map(change => { if (!change || typeof change.key !== "string" || seen.has(change.key) || !uuids(change.base)) return invalid(); seen.add(change.key); return { key: change.key, base: [...change.base].sort(), value: parseEntity(change.key,change.value) }; }).sort((a,b) => a.key.localeCompare(b.key));
    const parents = [...value.heads].sort(), digest = hash(stable({ parents, changes }));
    const revision = this.identity(`${value.operationId}:${digest}`);
    await this.migrateLegacy();
    await this.putImmutable(`${this.prefix}/legacy-lock.json`, { format: "idea-bank-sync-v2" });
    const graph = await this.graph();
    if (graph.has(revision)) { if ((await this.manifest(revision,graph)).digest !== digest) throw new StorageError(409,"OPERATION_REUSED","Идентификатор операции уже использован."); await this.catalog().publish(revision,parents); return { revision }; }
    const current = await this.index(this.heads(graph),graph), index = await this.index(parents,graph);
    for (const change of changes) {
      if (!equal(current[change.key] || [], change.base)) throw new StorageError(409,"STALE_INDEX","Запись изменилась на другом устройстве. Повтори синхронизацию.");
      if (!equal(index[change.key] || [],change.base)) return invalid("Базовые версии не соответствуют индексу.");
      if (keyParts(change.key).kind === "media" && change.value) await this.storage.verifyMedia(change.value);
    }
    // Validate attachment membership against the proposed index before publishing any record.
    const supplied = new Map(changes.map(c => [c.key,c.value]));
    for (const change of changes) if (change.value) {
      const kind = keyParts(change.key).kind;
      const v = change.value as unknown as { coverImage?: { id: string }; media?: { id: string; size: number; mime: string }[] };
      const assets = kind === "idea" ? (v.coverImage ? [v.coverImage] : []) : kind === "block" ? v.media || [] : [];
      for (const asset of assets) {
        const key = `media:${JSON.stringify([asset.id])}`;
        const metadata = supplied.has(key) ? supplied.get(key) : index[key]?.length === 1 ? (await this.version(key,index[key][0])).value : null;
        if (!metadata || keyParts(key).kind !== "media") return invalid("Сначала загрузи все вложения.");
        const file = metadata as CloudMedia, reference = asset as { id:string; size:number; mime:string };
        if (file.id !== reference.id || file.size !== reference.size || file.mime !== reference.mime) return invalid("Описание медиа не совпадает с библиотекой.");
        await this.storage.verifyMedia(metadata);
      }
    }
    const cache = new Map<string,EntityValue | null>();
    const get = async (key: string) => {
      if (supplied.has(key)) return supplied.get(key)!;
      if (!cache.has(key)) cache.set(key,current[key]?.length === 1 ? (await this.version(key,current[key][0])).value : null);
      return cache.get(key)!;
    };
    for (const change of changes) {
      const part = keyParts(change.key);
      if (change.value && part.kind === "idea") {
        const idea = change.value as { sectionId:string; blockIds:string[] };
        if (!await get(entityKey("section",idea.sectionId))) return invalid("Раздел идеи не найден.");
        for (const block of idea.blockIds) if (!await get(entityKey("block",part.ids[0],block))) return invalid("Блок идеи не найден.");
      }
      if (part.kind === "block") {
        const parent = await get(entityKey("idea",part.ids[0])) as { blockIds:string[] } | null;
        if (change.value ? !parent?.blockIds.includes(part.ids[1]) : parent?.blockIds.includes(part.ids[1])) return invalid("Порядок блоков не соответствует идее.");
      }
      if (!change.value && part.kind === "idea") for (const key of Object.keys(current)) {
        const child = keyParts(key);
        if (child.kind === "block" && child.ids[0] === part.ids[0] && await get(key)) throw new StorageError(409,"STALE_INDEX","Запись изменилась на другом устройстве. Повтори синхронизацию.");
      }
      if (!change.value && part.kind === "section") for (const key of Object.keys(current)) {
        if (keyParts(key).kind === "idea" && (await get(key) as {sectionId?:string}|null)?.sectionId === part.ids[0]) throw new StorageError(409,"STALE_INDEX","Запись изменилась на другом устройстве. Повтори синхронизацию.");
      }
    }
    for(let start=0;start<changes.length;start+=12) await Promise.all(changes.slice(start,start+12).map(async change=>{
      const previous = await this.recovery(change.key,change.value,change.base);
      await this.putImmutable(this.versionKey(change.key,revision), { key: change.key, revision, value: change.value, ...(previous.length ? { previous } : {}) }); index[change.key] = [revision];
    }));
    const manifest: Manifest = { format: "idea-bank-index", version: 2, revision, parents, index, digest };
    await this.putImmutable(this.manifestKey(parents,revision),manifest);
    await this.catalog().publish(revision,parents);
    return { revision };
  }
  private identity(value: string) {
    const bytes = Buffer.from(hash(value).slice(0,32),"hex"); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  private async recovery(key: string, value: EntityValue | null, parents: string[]) {
    const previous: EntityValue[] = [];
    if (value === null && ["section","idea"].includes(keyParts(key).kind)) for (const parent of parents) {
      const old = await this.version(key,parent);
      for (const candidate of old.value ? [old.value] : old.previous || []) if (!previous.some(v => equal(v,candidate))) previous.push(candidate);
    }
    return previous;
  }
  async download(key: string, revision: string) {
    if (keyParts(key).kind !== "media" || !revisionPattern.test(revision)) return invalid();
    const graph = await this.graph(); if (!graph.has(revision)) throw new StorageError(404,"NOT_FOUND","Вложение не найдено.");
    const version = await this.version(key,revision); if (!version.value) throw new StorageError(404,"NOT_FOUND","Вложение удалено.");
    return this.storage.signDownload(version.value as CloudMedia);
  }
}

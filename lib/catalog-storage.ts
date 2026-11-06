import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { MAX_CLOUD_JSON_BYTES, StorageError, invalid, revisionPattern, type CloudMedia } from "./cloud-library";
import { entityKey, equal, keyParts, stable, type EntityIndex } from "./entity-sync";
import { parseLibrary, summarizeIdea, type IdeaSummary, type Project, type Section, type TextBlock } from "./ideas";
import type { EntityStorage } from "./entity-storage";
import type { IdeaEditVersions } from "./scoped-types";
import { cachedStorageRead } from "./storage-read-cache";

type IdeaMetadata = IdeaSummary & { blockIds: string[] };
export type CatalogCard = { id: string; version: string; variants: (IdeaSummary | null)[]; conflicted: boolean };
export type CatalogSection = { id: string; variants: (Section | null)[]; conflicted: boolean };
type PageRef = { key: string; count: number };
type IdeaRef = { key: string; version: string };
type IdeaDescriptor = { id: string; version: string; metadata: string[]; sections: Record<string, string[]>; blocks: Record<string, string[]> };
type CatalogRoot = { format: "idea-bank-catalog"; version: 1; revision: string; heads: string[]; sections: CatalogSection[]; pages: PageRef[]; shards: Record<string, string>; mediaShards: Record<string, string>; sectionCounts: Record<string, number>; count: number };
export type CatalogPage = { revision: string; sections: CatalogSection[]; ideas: CatalogCard[]; nextCursor: string | null; total: number; sectionCounts: Record<string, number>; uninitialized: boolean };
export type CloudIdeaResult = { id: string; version: string; notModified: true } | { id: string; version: string; notModified: false; idea: Project; editBase:IdeaEditVersions };
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const missing = (error: unknown) => { const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }; return ["NoSuchKey", "NotFound"].includes(e?.name || "") || e?.$metadata?.httpStatusCode === 404; };
const conflict = (): never => { throw new StorageError(409, "IDEA_CONFLICT", "У идеи есть несовместимые версии. Разреши конфликт синхронизации."); };

/** Immutable read views. The small live frontier replaces history listing on ordinary reads. */
export class CatalogStorage {
  readonly prefix: string;
  private rootRead?:Promise<CatalogRoot>;
  constructor(private readonly entities: EntityStorage,private readonly source?:{heads:string[];index:EntityIndex}) { this.prefix = `${entities.prefix}/catalog-v1`; }
  private get storage() { return this.entities.storage; }
  private async get(key: string, cache = true): Promise<unknown | null> {
    if (cache && key.startsWith(`${this.prefix}/objects/`)) return cachedStorageRead(this.storage,key,()=>this.get(key,false));
    try {
      const object = await this.storage.client.send(new GetObjectCommand({ Bucket: this.storage.settings.bucket, Key: key }));
      if (!object.Body || !object.ContentLength || object.ContentLength > MAX_CLOUD_JSON_BYTES) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
      const text = await object.Body.transformToString();
      if (Buffer.byteLength(text) > MAX_CLOUD_JSON_BYTES) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
      const value = JSON.parse(text);
      if (key.startsWith(`${this.prefix}/objects/`) && hash(value) !== key.slice(`${this.prefix}/objects/`.length).replace(/\.json$/, "")) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
      return value;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private async exists(key: string) {
    try { await this.storage.client.send(new HeadObjectCommand({ Bucket: this.storage.settings.bucket, Key: key })); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  private async put(key: string, value: unknown) {
    const body = stable(value);
    if (Buffer.byteLength(body) > MAX_CLOUD_JSON_BYTES) throw new StorageError(413, "CATALOG_TOO_LARGE", "Запись индекса превышает 3 МиБ.");
    const existing = await this.get(key,false);
    if (existing !== null) {
      if (!equal(existing, value)) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
      return;
    }
    await this.storage.client.send(new PutObjectCommand({ Bucket: this.storage.settings.bucket, Key: key, Body: body, ContentType: "application/json", ContentMD5: createHash("md5").update(body).digest("base64") }));
  }
  private async content(value: unknown) {
    const key = `${this.prefix}/objects/${hash(value)}.json`;
    await this.put(key, value); return key;
  }
  private async object<T>(key: string): Promise<T> {
    const match = new RegExp(`^${this.prefix}/objects/([a-f0-9]{64})\\.json$`).exec(key);
    if (!match) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
    const value = await this.get(key);
    if (value === null || hash(value) !== match[1]) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
    return value as T;
  }
  /** Retirement survives late parent retries; cleanup is only an optimization, never the proof. */
  async publish(revision: string, parents: string[]) {
    if (!await this.exists(`${this.prefix}/retired/${revision}.json`)) await this.put(`${this.prefix}/tips/${revision}.json`, { revision });
    for (const parent of parents) {
      await this.put(`${this.prefix}/retired/${parent}.json`, { retired: true });
      try {
        const key = `${this.prefix}/tips/${parent}.json`;
        if (await this.exists(key)) await this.storage.client.send(new DeleteObjectCommand({ Bucket: this.storage.settings.bucket, Key: key }));
      }
      catch { /* The durable retirement marker still prevents a parent becoming current again. */ }
    }
  }
  private async frontier(): Promise<string[]> {
    const prefix = `${this.prefix}/tips/`, ids: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.storage.client.send(new ListObjectsV2Command({ Bucket: this.storage.settings.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents || []) {
        const id = object.Key?.slice(prefix.length).replace(/\.json$/, "");
        if (!id || !revisionPattern.test(id)) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
        if (!await this.exists(`${this.prefix}/retired/${id}.json`)) ids.push(id);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw new StorageError(502, "INVALID_CATALOG", "Индекс библиотеки повреждён.");
    } while (token);
    if (ids.length > 16) throw new StorageError(409, "TOO_MANY_BRANCHES", "Сначала объедини версии библиотеки через синхронизацию.");
    return ids.sort();
  }
  private root():Promise<CatalogRoot> {return this.rootRead ??= this.loadRoot();}
  private async loadRoot(): Promise<CatalogRoot> {
    let tips = this.source?.heads || await this.frontier();
    if (!tips.length) {
      const emptyKey = `${this.prefix}/views/${hash(["reader-2",[]])}.json`;
      // Existing v2 libraries need a read index, not a data migration. Never load their blocks here.
      const source = this.source || await this.entities.catalogIndex();
      for (const id of source.heads) await this.publish(id, []);
      tips = await this.frontier();
      if (!tips.length && !source.heads.length) {
        const root = await this.build(source);
        await this.put(emptyKey, { root: await this.content(root) });
        return root;
      }
      if (!tips.length) throw new StorageError(409, "CATALOG_BUSY", "Библиотека обновляется. Повтори запрос.");
    }
    const key = `${this.prefix}/views/${hash(["reader-2",tips])}.json`;
    return cachedStorageRead(this.storage,`projection:${key}`,async () => {
      const saved = await this.get(key) as { root?: string } | null;
      if (saved) return this.object<CatalogRoot>(saved.root || "");
      const root = await this.build(this.source || await this.entities.catalogIndex(tips));
      await this.put(key, { root: await this.content(root) });
      return root;
    });
  }
  private async build(source: { heads: string[]; index: EntityIndex }): Promise<CatalogRoot> {
    const { index } = source;
    const sections: CatalogSection[] = [], cards: CatalogCard[] = [];
    const shards = new Map<string, Record<string, IdeaRef>>();
    // Deliberately fetch only section/idea records. Block revision IDs suffice for content versions.
    const metadata = Object.entries(index).filter(([key]) => ["idea", "section"].includes(keyParts(key).kind));
    for (let start = 0; start < metadata.length; start += 12) await Promise.all(metadata.slice(start, start + 12).map(async ([key, revisions]) => {
      const part = keyParts(key);
      const records = await Promise.all(revisions.map(revision => this.entities.version(key, revision)));
      if (records.every(record => record.value === null)) return;
      if (part.kind === "section") {
        sections.push({ id: part.ids[0], variants: records.map(record => record.value as Section | null), conflicted: records.length > 1 });
        return;
      }
      const variants = records.map(record => record.value as IdeaMetadata | null), id = part.ids[0];
      const descriptor: IdeaDescriptor = { id, version: "", metadata: revisions, sections: Object.create(null), blocks: Object.create(null) };
      for (const idea of variants) if (idea) {
        descriptor.sections[idea.sectionId] = index[entityKey("section", idea.sectionId)] || [];
        for (const block of idea.blockIds) descriptor.blocks[block] = index[entityKey("block", id, block)] || [];
      }
      descriptor.version = hash({ id, metadata: descriptor.metadata, sections: descriptor.sections, blocks: descriptor.blocks });
      const shard = hash(id).slice(0, 2);
      if (!shards.has(shard)) shards.set(shard, Object.create(null));
      shards.get(shard)![id] = { version: descriptor.version, key: await this.content(descriptor) };
      cards.push({ id, version: descriptor.version, variants: variants.map(idea => idea ? summarizeIdea(idea) : null),
        conflicted: revisions.length > 1 || [...Object.values(descriptor.sections), ...Object.values(descriptor.blocks)].some(versions => versions.length !== 1) });
    }));
    sections.sort((a,b) => a.id.localeCompare(b.id));
    for (const card of cards) if (card.variants.some(idea => idea && !sections.some(section => section.id === idea.sectionId && section.variants.every(Boolean)))) card.conflicted = true;
    const updated = (card: CatalogCard) => Math.max(...card.variants.map(idea => idea ? Date.parse(idea.updatedAt) : 0));
    cards.sort((a,b) => updated(b) - updated(a) || a.id.localeCompare(b.id));
    const pages: PageRef[] = [];
    let batch: CatalogCard[] = [], bytes = 2;
    const flush = async () => { if (batch.length) pages.push({ key: await this.content(batch), count: batch.length }); batch = []; bytes = 2; };
    for (const card of cards) {
      const size = Buffer.byteLength(stable(card)) + 1;
      if (batch.length && (batch.length >= 24 || bytes + size > 256 * 1024)) await flush();
      batch.push(card); bytes += size;
    }
    await flush();
    const references: Record<string, string> = Object.create(null);
    for (const [shard, values] of shards) references[shard] = await this.content(values);
    const media = new Map<string, Record<string, string[]>>();
    for (const [key, versions] of Object.entries(index)) {
      const part = keyParts(key); if (part.kind !== "media") continue;
      const shard = hash(part.ids[0]).slice(0,2);
      if (!media.has(shard)) media.set(shard,Object.create(null));
      media.get(shard)![part.ids[0]] = versions;
    }
    const mediaShards: Record<string,string> = Object.create(null), sectionCounts: Record<string,number> = Object.create(null);
    for (const [shard, values] of media) mediaShards[shard] = await this.content(values);
    for (const card of cards) for (const id of new Set(card.variants.flatMap(idea => idea ? [idea.sectionId] : []))) sectionCounts[id] = (sectionCounts[id] || 0) + 1;
    return { format: "idea-bank-catalog", version: 1, revision: hash(source.heads), heads: source.heads, sections, pages, shards: references, mediaShards, sectionCounts, count: cards.length };
  }
  async readPage(options: { limit?: number; cursor?: string; sectionId?: string; query?: string } = {}): Promise<CatalogPage> {
    const limit = options.limit ?? 24, query = options.query?.trim().toLowerCase() || "";
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || query.length > 200 || (options.sectionId !== undefined && (!options.sectionId || options.sectionId.length > 200))) return invalid();
    let cursor: { revision: string; offset: number; sectionId?: string; query: string } | undefined;
    if (options.cursor) {
      try { if (options.cursor.length > 2048) return invalid(); cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()); } catch { return invalid(); }
      if (!cursor || !digestPattern.test(cursor.revision) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.query !== query || cursor.sectionId !== options.sectionId) return invalid();
    }
    const root = await this.root();
    if (cursor && cursor.revision !== root.revision) throw new StorageError(409, "STALE_CATALOG", "Список идей изменился. Загрузи его заново.");
    const offset = cursor?.offset ?? 0, ideas: CatalogCard[] = [];
    const filtered = !!(options.sectionId || query); let scanned = 0, matched = 0;
    const knownTotal = query ? undefined : options.sectionId ? root.sectionCounts[options.sectionId] || 0 : root.count;
    for (const ref of root.pages) {
      if (knownTotal === 0) break;
      if (!filtered && scanned + ref.count <= offset) { scanned += ref.count; matched += ref.count; continue; }
      const cards = await this.object<CatalogCard[]>(ref.key);
      for (const card of cards) {
        const matches = !filtered || card.variants.some(idea => idea && (!options.sectionId || idea.sectionId === options.sectionId) && (!query || `${idea.name}\n${idea.description}`.toLowerCase().includes(query)));
        if (matches) { if (matched >= offset && ideas.length < limit) ideas.push(card); matched++; }
      }
      scanned += ref.count;
      if (knownTotal !== undefined && ideas.length === limit) break;
    }
    const total = knownTotal ?? matched;
    const nextCursor = offset + ideas.length < total ? Buffer.from(JSON.stringify({ revision: root.revision, offset: offset + ideas.length, ...(options.sectionId ? { sectionId: options.sectionId } : {}), query })).toString("base64url") : null;
    return { revision: root.revision, sections: root.sections, ideas, nextCursor, total, sectionCounts: root.sectionCounts, uninitialized: !root.heads.length };
  }
  async readMedia(id: string) {
    if (!/^[a-f0-9]{64}-[a-f0-9]{32}$/.test(id)) return invalid();
    const root = await this.root(), key = root.mediaShards[hash(id).slice(0,2)];
    const shard = key ? await this.object<Record<string,string[]>>(key) : null;
    const versions = shard && Object.hasOwn(shard,id) ? shard[id] : [];
    if (versions.length > 1) return conflict();
    const file = versions.length ? (await this.entities.version(entityKey("media",id),versions[0])).value as CloudMedia | null : null;
    if (!file) throw new StorageError(404,"NOT_FOUND","Вложение не найдено.");
    return this.storage.signDownload(file);
  }
  async readIdea(id: string, knownVersion?: string, versionOnly = false): Promise<CloudIdeaResult | { id: string; version: string }> {
    if (!id || id.length > 200 || (knownVersion !== undefined && !digestPattern.test(knownVersion))) return invalid();
    const root = await this.root(), key = root.shards[hash(id).slice(0, 2)];
    const shard = key ? await this.object<Record<string, IdeaRef>>(key) : null;
    const ref = shard && Object.hasOwn(shard, id) ? shard[id] : null;
    if (!ref) throw new StorageError(404, "NOT_FOUND", "Идея не найдена.");
    if (versionOnly) return { id, version: ref.version };
    if (knownVersion === ref.version) return { id, version: ref.version, notModified: true };
    const descriptor = await this.object<IdeaDescriptor>(ref.key);
    const editIndex:EntityIndex={};
    const readOne = async (key: string, versions: string[]) => {
      if (versions.length !== 1) return conflict();
      const record = await this.entities.version(key, versions[0]);
      if (record.value === null) return conflict();
      editIndex[key]=versions;
      return record.value;
    };
    const metadata = await readOne(entityKey("idea", id), descriptor.metadata) as IdeaMetadata;
    const section = await readOne(entityKey("section", metadata.sectionId), descriptor.sections[metadata.sectionId] || []) as Section;
    const blocks: TextBlock[] = [];
    for (let start = 0; start < metadata.blockIds.length; start += 12) {
      blocks.push(...await Promise.all(metadata.blockIds.slice(start, start + 12).map(async block => await readOne(entityKey("block", id, block), descriptor.blocks[block] || []) as TextBlock)));
    }
    const idea = parseLibrary(JSON.stringify({ version: 1, sections: [section], projects: [{ ...summarizeIdea(metadata), blocks }] })).projects[0];
    return { id, version: ref.version, notModified: false, idea, editBase:{heads:root.heads,index:editIndex,section} };
  }
}

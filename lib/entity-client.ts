import { type Library, type Project, type Section, type TextBlock } from "./ideas";
import { canonicalLibrary, validateRead, contentId, flattenLibrary, assembleLibrary, mergeValue, equal, entityKey, keyParts, parseEntity, type EntityMap, type EntityIndex, type EntityValue, type EntityRead, type SyncCheckpoint, type MergeConflict, type EntityChange } from "./entity-sync";
import { libraryAssets, parseCloudSnapshot, parseCloudMedia, revisionPattern, type CloudMedia } from "./cloud-library";
import { readMeta, readLocalSnapshot, saveLocalLibrary, saveSyncOperation, isPristineStarter } from "./library-store";
import { request, transaction } from "./local-database";
import { cacheKey, type CacheState } from "./media-cache-store";
import { readMediaFile } from "./media-store";
import { readCloudState } from "./cloud-state";
import { hashMedia, signedUrl } from "./cloud-sync";
import { translate as t } from "./i18n";

class SyncError extends Error { constructor(message: string, public code = "", public status = -1) { super(t(message)); } }
async function api(path: string, body?: unknown, method = "POST"): Promise<any> {
  let response: Response;
  try { response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) }); }
  catch { throw new SyncError("Нет связи с облаком. Локальные идеи сохранены; повтори синхронизацию позже.","NETWORK",0); }
  const value = await response.json().catch(() => null);
  if (!response.ok) throw new SyncError(response.status === 401 ? "Сессия истекла. Сохрани правки и войди через GitHub снова." : value?.error?.message || "Не удалось выполнить облачный запрос.", value?.error?.code,response.status);
  if (!value) throw new SyncError("Неполный ответ истории облака."); return value;
}
type Operation = { scope: string; body: { operationId: string; heads: string[]; changes: EntityChange[] }; before: EntityMap; values: EntityMap };
export type EntityPlan = { scope: string; expected: Library; local: EntityMap; base: EntityMap; remote: EntityMap; recovery?: Record<string,EntityValue[]>; variants: Record<string, (EntityValue | null)[]>; read: EntityRead; sources: CloudMedia[]; first: boolean; resolveMode?: "merge" | "cloud"; resolvedChoices?: SyncChoices; completedOperation?: string; conflicts: MergeConflict[] };
export type SyncChoices = Record<string, number>;
export { validateRead } from "./entity-sync";
function subtree(key: string, values: EntityMap): string[] {
  const { kind, ids } = keyParts(key), result = [key];
  if (kind === "section") for (const [child,v] of Object.entries(values)) if (v && keyParts(child).kind === "idea" && (v as { sectionId: string }).sectionId === ids[0]) result.push(...subtree(child,values));
  if (kind === "idea") for (const child of Object.keys(values)) { const part = keyParts(child); if (part.kind === "block" && part.ids[0] === ids[0]) result.push(child); }
  return [...new Set(result)];
}
/** Return explicit per-record conflicts before touching local storage or publishing changes. */
export function resolvePlan(plan: EntityPlan, choices: SyncChoices = {}, mode: "merge" | "local" | "cloud" = "merge"): { values: EntityMap; conflicts: MergeConflict[] } {
  choices = { ...plan.resolvedChoices,...choices };
  const values: EntityMap = Object.create(null), conflicts: MergeConflict[] = [];
  const keys = new Set([...Object.keys(plan.base), ...Object.keys(plan.local), ...Object.keys(plan.read.index)]);
  for (const key of keys) {
    const local = plan.local[key] || null, variants = plan.variants[key] || [null];
    if (mode === "local") { values[key] = local; continue; }
    let remote = variants[0], failed = false;
    for (const value of variants.slice(1)) {
      // Concurrent cloud heads are not descendants of a device's own checkpoint.
      // Never treat one branch as their common ancestor and silently discard the other.
      if (keyParts(key).kind === "idea" && remote && value) {
        const { updatedAt: left, ...a } = remote as Omit<Project,"blocks">;
        const { updatedAt: right, ...b } = value as Omit<Project,"blocks">;
        if (equal(a,b)) remote = { ...remote,updatedAt: [left,right].sort().at(-1)! };
        else failed = true;
      } else if (!equal(remote,value)) failed = true;
    }
    const merged = mode === "cloud" ? { value: remote, conflict: false } : mergeValue(key,plan.base[key] || null,local,remote);
    const options = [local, ...variants];
    if (failed || merged.conflict) {
      if (choices[key] !== undefined && Number.isInteger(choices[key]) && choices[key] >= 0 && choices[key] < options.length) values[key] = options[choices[key]];
      else { values[key] = local; conflicts.push({ key, variants: options }); }
    } else values[key] = merged.value;
  }
  // Deleting an ancestor conflicts with a concurrent edit anywhere in its subtree.
  for (const key of keys) {
    const { kind } = keyParts(key); if (!["section","idea"].includes(kind)) continue;
    const local = plan.local[key] || null, remote = plan.remote[key] || null;
    const family = new Set([...subtree(key,plan.base), ...subtree(key,plan.local), ...subtree(key,plan.remote)]);
    const localChildEdit = [...family].some(child => child !== key && !equal(plan.local[child] || null,plan.base[child] || null));
    const remoteChildEdit = [...family].some(child => child !== key && !equal(plan.remote[child] || null,plan.base[child] || null));
    const structural = mode === "merge" && !!plan.base[key] && ((local === null && remote !== null && remoteChildEdit) || (remote === null && local !== null && localChildEdit));
    if (!structural) continue;
    const options = [local,...(plan.variants[key] || [null])];
    if (choices[key] === undefined) { if (!conflicts.some(c => c.key === key)) conflicts.push({ key, variants: options, structural: true }); continue; }
    const selected = choices[key] === 0 ? plan.local : plan.remote;
    for (const child of family) {
      const cloudFork = choices[key] > 0 && options[choices[key]] !== null && child !== key && (plan.variants[child]?.length || 0) > 1 && !plan.variants[child].every(v => equal(v,plan.variants[child][0]));
      if (cloudFork) continue;
      values[child] = selected[child] || null; const i = conflicts.findIndex(c => c.key === child); if (i >= 0) conflicts.splice(i,1);
    }
    values[key] = options[choices[key]];
  }
  for (let round = 0; round < 3; round++) for (const [child,value] of Object.entries(values)) {
    if (!value) continue;
    const part = keyParts(child);
    const parent = part.kind === "idea" ? entityKey("section",(value as { sectionId:string }).sectionId) : part.kind === "block" ? entityKey("idea",part.ids[0]) : null;
    if (!parent || values[parent] || conflicts.some(c => c.key === parent)) continue;
    const recover = [plan.local[parent],plan.base[parent],...(plan.recovery?.[parent] || [])].filter(Boolean) as EntityValue[];
    const options: (EntityValue | null)[] = [null,...recover.filter((v,i,a) => a.findIndex(x => equal(x,v)) === i)];
    const choice = choices[parent];
    if (choice === undefined || choice < 0 || choice >= options.length) { conflicts.push({key:parent,variants:options,structural:true}); continue; }
    values[parent] = options[choice];
    if (choice === 0) for (const key of new Set([...subtree(parent,values),...subtree(parent,plan.base)])) { values[key]=null; const i=conflicts.findIndex(c => c.key === key); if(i>=0)conflicts.splice(i,1); }
  }
  // A kept block stays attached to its idea; deleted blocks leave the ordering list.
  for (const [key,value] of Object.entries(values)) if (value && keyParts(key).kind === "idea") {
    const idea = value as Omit<Project,"blocks"> & { blockIds: string[] };
    const alive = Object.keys(values).filter(child => values[child] && keyParts(child).kind === "block" && keyParts(child).ids[0] === idea.id).map(child => keyParts(child).ids[1]);
    values[key] = { ...idea, blockIds: [...idea.blockIds.filter(id => alive.includes(id)), ...alive.filter(id => !idea.blockIds.includes(id)).sort()] };
  }
  return { values, conflicts };
}
export async function localMedia(library: Library, checkpoint: SyncCheckpoint | null): Promise<CloudMedia[]> {
  const files: CloudMedia[] = [];
  const cache=await readMeta<CacheState>(cacheKey)||{};
  const knownFiles=new Map(checkpoint?.files.map(file=>[file.id,file])||[]);
  const aliases=await readMeta<Record<string,CloudMedia>>("scoped-media-aliases") || {};
  for (const asset of libraryAssets(library).values()) {
    const alias=aliases[asset.id];
    if(alias && alias.size===asset.size && alias.mime===asset.mime && !await readMediaFile(asset.id)){files.push({...alias,id:asset.id});continue;}
    const candidate=knownFiles.get(asset.id);
    const known=candidate && contentId(candidate)===asset.id && candidate.size===asset.size && candidate.mime===asset.mime ? candidate : undefined;
    if(known && (cache[asset.id]?.scope===checkpoint?.scope || !await transaction(["media"],"readonly",tx=>request(tx.objectStore("media").getKey(asset.id))))){files.push(known);continue;}
    const blob = await readMediaFile(asset.id);
    if (!blob || blob.size !== asset.size) throw new SyncError(t("Не найден исходный файл «{0}». Облако не обновлено.", { 0: asset.name }));
    files.push({ id: asset.id, mime: asset.mime, size: blob.size, ...await hashMedia(blob) });
  }
  return files;
}
export async function inspectEntitySync(scope: string, library: Library, activate = false, shouldContinue:()=>boolean=()=>true): Promise<EntityPlan> {
  const snapshot = await readLocalSnapshot();
  if (!snapshot || !equal(snapshot.library,library)) throw new SyncError("В другой вкладке есть изменения. Обнови страницу перед синхронизацией.");
  const status=await api("/api/sync",undefined,"GET");
  if(status.requiresMigration && !activate) throw new SyncError("Требуется переход на новую синхронизацию.","MIGRATION_REQUIRED",409);
  const saved = await readMeta<SyncCheckpoint>("sync-v2"), checkpoint = saved?.scope === scope && saved.version === 2 ? saved : null;
  const sources = await localMedia(library,checkpoint), local = flattenLibrary(canonicalLibrary(library,sources),sources.map(f => ({ ...f,id: contentId(f) })));
  let base: EntityMap = checkpoint?.values || Object.create(null), first = !checkpoint, completedOperation: string | undefined;
  const pending = await readMeta<Operation>("sync-operation");
  if(!shouldContinue())throw new SyncError("Синхронизация приостановлена.","SYNC_PAUSED");
  if (pending && pending.scope !== scope) throw new SyncError("Настройки хранилища изменились. Заверши синхронизацию с прежним хранилищем.");
  if (pending) {
    try {
      await api("/api/sync",pending.body,"PUT"); base = pending.values; completedOperation = pending.body.operationId;
      for (const key of new Set([...Object.keys(pending.before), ...Object.keys(pending.values), ...Object.keys(local)])) if (equal(local[key] || null,pending.before[key] || null)) local[key] = pending.values[key] || null;
      first = false;
    } catch (error) {
      if (error instanceof SyncError && (error.code === "STALE_INDEX" || [400,413,415,422].includes(error.status))) {
        await saveSyncOperation(null,undefined,pending.body.operationId);
        if (error.code !== "STALE_INDEX") throw error;
      } else throw error;
    }
  }
  if (!checkpoint && !pending) {
    const legacy = await readCloudState(scope);
    if (legacy) {
      const raw = parseCloudSnapshot((await api(`/api/storage/library?revision=${legacy.revision}`,undefined,"GET")).snapshot);
      base = flattenLibrary(canonicalLibrary(raw.library,raw.media),raw.media.map(f => ({ ...f,id: contentId(f) }))); first = false;
    }
  }
  const read: EntityRead = await api("/api/sync",{ known: checkpoint?.index || {},activate });
  const remote = validateRead(read,checkpoint?.index || {},checkpoint?.values || {},checkpoint?.recovery || {});
  const plan: EntityPlan = { scope, expected: structuredClone(library), local, base, ...remote, read, sources, first, completedOperation, conflicts: [] };
  if (first && await isPristineStarter(library)) {
    plan.first = false;
    // Even an intentionally empty cloud library has heads; never seed over its deletions.
    if (read.heads.length) plan.resolveMode = "cloud";
  }
  plan.conflicts = resolvePlan(plan, {}, plan.resolveMode || "merge").conflicts;
  return plan;
}
export async function uploadNeeded(plan: EntityPlan, values: EntityMap, changes: EntityChange[], progress: (message: string) => void) {
  const needed = new Set<string>();
  for (const change of changes) if (change.value) {
    const kind = keyParts(change.key).kind, v = change.value as unknown as { coverImage?: { id: string }; media?: { id: string }[] };
    if (kind === "media") needed.add((change.value as CloudMedia).id);
    if (kind === "idea" && v.coverImage) needed.add(v.coverImage.id);
    if (kind === "block") for (const asset of v.media || []) needed.add(asset.id);
  }
  for (const id of needed) {
    if (plan.read.index[entityKey("media",id)]) continue;
    const file = parseCloudMedia(values[entityKey("media",id)]);
    const upload = await api("/api/storage/media/upload",file);
    if(upload.alreadyUploaded)continue;
    const source = plan.sources.find(f => contentId(f) === id), blob = source ? await readMediaFile(source.id) : await readMediaFile(id);
    if (!blob || !equal(await hashMedia(blob),{ sha256: file.sha256, md5: file.md5 })) throw new SyncError("Не найден исходный файл для синхронизации.");
    progress(t("Отправляем вложение…"));
    if (!upload.alreadyUploaded) {
      const response = await fetch(signedUrl(upload.url), { method: "PUT", headers: upload.headers, body: blob, credentials: "omit", signal: AbortSignal.timeout(15*60*1000) });
      if (!response.ok) throw new SyncError("Не удалось загрузить медиа в B2. Проверь связь и CORS хранилища. Локальная библиотека не изменена.","",response.status);
    }
  }
}
/** A stable persisted operation makes retries after a lost HTTP response idempotent. */
export async function applyEntitySync(plan: EntityPlan, choices: SyncChoices = {}, mode: "merge" | "local" | "cloud" = "merge", progress: (message: string) => void = () => {}, shouldContinue:()=>boolean=()=>true): Promise<{ library: Library; state: SyncCheckpoint } | { plan: EntityPlan }> {
  if(!shouldContinue())throw new SyncError("Синхронизация приостановлена.","SYNC_PAUSED");
  if (!equal((await readLocalSnapshot())?.library,plan.expected)) throw new SyncError("Библиотека изменилась в другой вкладке. Повтори синхронизацию.");
  let { values, conflicts } = resolvePlan(plan,choices,mode);
  if (conflicts.length) return { plan: { ...plan,first:false,resolvedChoices:{ ...plan.resolvedChoices,...choices },resolveMode: mode === "cloud" ? "cloud" : "merge", conflicts } };
  assembleLibrary(values); // Fail before a request if structural conflicts are unresolved.
  const changes: EntityChange[] = [];
  for (const key of new Set([...Object.keys(values), ...Object.keys(plan.read.index)])) {
    const value = values[key] || null;
    if (plan.read.index[key]?.length === 1 && equal(value,plan.remote[key]) || !plan.read.index[key] && value === null) continue;
    changes.push({ key,base: plan.read.index[key] || [],value });
  }
  if (changes.length || plan.read.heads.length > 1) {
    // Empty merges are unnecessary: per-record frontiers already converge on reads.
    if (changes.length) {
      await uploadNeeded(plan,values,changes,progress);
      const pending: Operation = { scope: plan.scope, body: { operationId: crypto.randomUUID(), heads: plan.read.heads, changes }, before: plan.local, values };
      if(!shouldContinue())throw new SyncError("Синхронизация приостановлена.","SYNC_PAUSED");
      await saveSyncOperation(pending,plan.expected,plan.completedOperation);
      try { await api("/api/sync",pending.body,"PUT"); plan = { ...plan,completedOperation: pending.body.operationId }; }
      catch (error) {
        if (error instanceof SyncError && (error.code === "STALE_INDEX" || [400,413,415,422].includes(error.status))) {
          await saveSyncOperation(null,undefined,pending.body.operationId);
          if (error.code === "STALE_INDEX") return { plan: await inspectEntitySync(plan.scope,plan.expected,false,shouldContinue) };
        }
        throw error;
      }
    }
  }
  const known = Object.fromEntries(Object.entries(plan.read.index).filter(([,versions]) => versions.length === 1));
  const read: EntityRead = await api("/api/sync",{ known }), next = validateRead(read,known,plan.remote,plan.recovery);
  const settled: EntityPlan = { ...plan, base: values,local: values,...next,read,first:false,resolvedChoices:{},conflicts:[] };
  const final = resolvePlan(settled);
  if (final.conflicts.length) return { plan: { ...settled,conflicts: final.conflicts } };
  values = final.values;
  // A concurrent disjoint save can require another merge; do not acknowledge it as uploaded.
  if (Object.keys(values).some(key => !(values[key] === null && !read.index[key]) && (read.index[key]?.length !== 1 || !equal(values[key],next.remote[key])))) return { plan: settled };
  const library = assembleLibrary(values), files: CloudMedia[] = [];
  for (const asset of libraryAssets(library).values()) {
    const file = parseCloudMedia(values[entityKey("media",asset.id)]);
    if (file.size !== asset.size || file.mime !== asset.mime) throw new SyncError("Описание медиа не совпадает с библиотекой.");
    files.push(file);
  }
  const state: SyncCheckpoint = { version:2,scope:plan.scope,index:read.index,values:next.remote,recovery:next.recovery,syncedAt:new Date().toISOString(),files };
  if(!shouldContinue())throw new SyncError("Синхронизация приостановлена.","SYNC_PAUSED");
  await saveLocalLibrary(library,plan.expected,{ remote:true,checkpoint:state,clearOperation:true,mediaAliases:new Map(plan.sources.map(file=>[file.id,contentId(file)])) });
  return { library,state };
}
export function conflictLabel(conflict: MergeConflict, plan: EntityPlan) {
  const parts = keyParts(conflict.key), value = plan.local[conflict.key] || plan.remote[conflict.key] || conflict.variants.find(Boolean);
  if (parts.kind === "block") return `${t("Блок")}: ${(value as TextBlock)?.heading || parts.ids[1]}`;
  if (parts.kind === "section") return `${t("Раздел")}: ${(value as Section)?.name || parts.ids[0]}`;
  return `${t("Идея")}: ${(value as { name?: string })?.name || parts.ids[0]}`;
}

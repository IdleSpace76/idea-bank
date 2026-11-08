import { translate as t } from "./i18n";
import { readLocalSnapshot, saveLocalLibrary } from "./library-store";
import { zip, unzip, type Zippable } from "fflate";
import { createId, parseLibrary, type Library, type MediaAsset,type Project } from "./ideas";
import {stable,flattenLibrary,validateRead,keyParts} from "./entity-sync";
import {queueScoped} from "./scoped-store";
import type {ScopedRead} from "./scoped-types";
import { projectMediaIds, removeMediaFiles,readMediaFile } from "./media-store";

import { getMediaFile } from "./media-cache";
import { localDiskEnabled } from "./disk-client";

export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 10000;
type ManifestFile = { id: string; path: string; size: number; sha256: string };
type Manifest = { format: "idea-bank-backup"; version: 1; createdAt: string; librarySha256: string; media: ManifestFile[] };
export type LibraryBackup = { library: Library; files: ReadonlyMap<string, Blob>; createdAt: string; totalBytes: number;hashes?:ReadonlyMap<string,string> };
export type ImportChoice="current"|"archive"|"both";
export type CloudImportBase={scope:string;read:ScopedRead};
export type BackupSource={library:Library;cloud?:CloudImportBase;release?:()=>Promise<void>};
export type LibraryImportPlan={backup:LibraryBackup;base:Library;cloud?:CloudImportBase;conflicts:{id:string;current:Project;incoming:Project}[];added:number;unchanged:number;sectionsAdded:number;copies:Map<string,string>;same:Set<string>;currentHashes:Map<string,string>;archiveHashes:Map<string,string>};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))).map(value => value.toString(16).padStart(2, "0")).join("");
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Includes covers and shared references once, rejecting ambiguous file identifiers. */
function collectAssets(library: Library): Map<string, MediaAsset> {
  const assets = new Map<string, MediaAsset>();
  for (const idea of library.projects) {
    for (const asset of [...(idea.coverImage ? [idea.coverImage] : []), ...idea.blocks.flatMap(block => block.media || [])]) {
      if (asset.mime === "image/svg+xml") throw new Error(t("Формат SVG не поддерживается: «{0}».", { 0: asset.name }));
      const previous = assets.get(asset.id);
      if (previous && (previous.mime !== asset.mime || previous.size !== asset.size || previous.kind !== asset.kind)) throw new Error(t("Несовместимые ссылки на файл «{0}». Экспорт остановлен.", { 0: asset.name }));
      assets.set(asset.id, asset);
    }
  }
  return assets;
}

/** Exports originals with JSON metadata and SHA-256 checksums; missing files abort export. */
export async function createLibraryBackup(library: Library, scope?: string,progress:(message:string)=>void=()=>{},readFile:(id:string)=>Promise<Blob|undefined>=id=>getMediaFile(id,scope)): Promise<Blob> {
  const snapshot = parseLibrary(JSON.stringify(library));
  const assets = collectAssets(snapshot);
  const json = new TextEncoder().encode(JSON.stringify(snapshot, null, 2));
  if (assets.size > MAX_ENTRIES - 3 || json.length + [...assets.values()].reduce((sum, asset) => sum + asset.size, 0) > MAX_BACKUP_BYTES) throw new Error(t("Для одного архива поддерживается до 512 МБ данных и 9 997 медиафайлов."));
  const entries: Zippable = { "library.json": [json, { level: 6 }] };
  const manifest: Manifest = { format: "idea-bank-backup", version: 1, createdAt: new Date().toISOString(), librarySha256: await digest(json), media: [] };
  const assetList=[...assets];let completed=0;
  progress(t("Добавляем вложения в архив: {0} из {1}",{0:completed,1:assets.size}));
  // A small parallel batch coalesces missing-media tickets; downloads still use two slots.
  for(let start=0;start<assetList.length;start+=4){const results=await Promise.allSettled(assetList.slice(start,start+4).map(async([id,asset],offset)=>{
    const blob = await readFile(id);
    if (!blob) throw new Error(t("Не найден файл «{0}». Полный архив не создан: восстанови файл или убери его из идеи.", { 0: asset.name }));
    if (blob.size !== asset.size) throw new Error(t("Размер файла «{0}» не совпадает с данными библиотеки. Экспорт остановлен.", { 0: asset.name }));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = (asset.name.split(/[\\/]/).pop() || "file").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 100);
    const path = `media/${String(start+offset+1).padStart(6, "0")}_${name}`;
    entries[path] = [bytes, { level: 0 }];
    manifest.media.push({ id, path, size: bytes.length, sha256: await digest(bytes) });
    progress(t("Добавляем вложения в архив: {0} из {1}",{0:++completed,1:assets.size}));
  }));const failed=results.find(result=>result.status==="rejected");if(failed?.status==="rejected")throw failed.reason;}
  manifest.media.sort((a,b)=>a.path.localeCompare(b.path));
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const instructions = new TextEncoder().encode(t("Резервная копия Idea Bank, версия 1\n\nlibrary.json — разделы, идеи, блоки и ссылки на медиа.\nmanifest.json — версия архива, дата и контрольные суммы SHA-256.\nmedia/ — исходные файлы; glTF содержит встроенные при загрузке ресурсы.\n\nДля восстановления открой Idea Bank > Локальная версия > Импортировать ZIP.\nАрхив содержит личные данные библиотеки. Храни его в безопасном месте.\n"));
  if (json.length + manifest.media.reduce((sum, file) => sum + file.size, 0) + manifestBytes.length + instructions.length > MAX_BACKUP_BYTES) throw new Error(t("Архив превышает ограничение в 512 МБ данных."));
  entries["manifest.json"] = [manifestBytes, { level: 6 }];
  entries["README.txt"] = instructions;
  progress(t("Упаковываем ZIP…"));
  const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(entries, { level: 0 }, (error, data) => error ? reject(error) : resolve(data)));
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

/** Validates the entire archive without changing browser storage. */
export async function readLibraryBackup(file: Blob): Promise<LibraryBackup> {
  if (!file.size || file.size > MAX_BACKUP_BYTES + 32 * 1024 * 1024) throw new Error(t("Выбери ZIP-архив Idea Bank размером до 544 МБ."));
  let total = 0, count = 0, problem = "";
  const seen = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    entries = await new Promise((resolve, reject) => unzip(bytes, { filter: entry => {
      total += entry.originalSize; count++;
      if (seen.has(entry.name)) problem ||= t("В архиве повторяются имена файлов.");
      seen.add(entry.name);
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || total > MAX_BACKUP_BYTES || count > MAX_ENTRIES) problem ||= t("Архив превышает ограничение: 512 МБ данных или 10 000 записей.");
      if (entry.name.length > 512 || ![0, 8].includes(entry.compression) || (entry.compression === 0 && entry.size !== entry.originalSize)) problem ||= t("В ZIP-архиве неверный размер файла или неподдерживаемое сжатие.");
      if (["manifest.json", "library.json"].includes(entry.name) && entry.originalSize > 16 * 1024 * 1024) problem ||= t("Описание библиотеки в архиве слишком большое.");
      return !problem && (["manifest.json", "library.json"].includes(entry.name) || /^media\/[^/\\]+$/u.test(entry.name));
    } }, (error, data) => problem ? reject(new Error(problem)) : error ? reject(error) : resolve(data)));
  } catch { throw new Error(problem || t("Не удалось открыть ZIP-архив. Проверь, что файл не повреждён.")); }
  if (!entries["manifest.json"] || !entries["library.json"]) throw new Error(t("Это не архив библиотеки Idea Bank: не найдены manifest.json и library.json."));
  let manifest: unknown;
  try { manifest = JSON.parse(decode(entries["manifest.json"])); } catch { throw new Error(t("Не удалось прочитать описание архива.")); }
  if (!record(manifest) || manifest.format !== "idea-bank-backup" || manifest.version !== 1 || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) || !validHash(manifest.librarySha256) || !Array.isArray(manifest.media)) throw new Error(t("Неподдерживаемая версия или неверное описание архива Idea Bank."));
  if (await digest(entries["library.json"]) !== manifest.librarySha256) throw new Error(t("Проверка целостности библиотеки не пройдена. Данные не изменены."));
  let library: Library;
  try { library = parseLibrary(decode(entries["library.json"])); } catch { throw new Error(t("Библиотека в архиве имеет несовместимый формат. Данные не изменены.")); }
  const assets = collectAssets(library), files = new Map<string, Blob>(), paths = new Set<string>();
  if (manifest.media.length !== assets.size) throw new Error(t("Список медиа в архиве не совпадает с библиотекой."));
  let totalBytes = entries["library.json"].length;
  for (const entry of manifest.media) {
    if (!record(entry) || typeof entry.id !== "string" || typeof entry.path !== "string" || !/^media\/[^/\\]+$/u.test(entry.path) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || !validHash(entry.sha256) || files.has(entry.id) || paths.has(entry.path)) throw new Error(t("В архиве неверное описание медиафайла."));
    const asset = assets.get(entry.id), bytes = entries[entry.path];
    if (!asset || !bytes || bytes.length !== entry.size || asset.size !== entry.size) throw new Error(t("В архиве отсутствует или повреждён файл «{0}».", { 0: asset?.name || entry.id }));
    if (await digest(bytes) !== entry.sha256) throw new Error(t("Проверка целостности файла «{0}» не пройдена.", { 0: asset.name }));
    files.set(entry.id, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: asset.mime })); paths.add(entry.path); totalBytes += bytes.length;
  }
  return { library, files, createdAt: manifest.createdAt, totalBytes,hashes:new Map(manifest.media.map(entry=>[entry.id,entry.sha256])) };
}

async function assetHash(asset:MediaAsset,hashes:Map<string,string>,file:()=>Promise<Blob|undefined>) {
  if(hashes.has(asset.id))return hashes.get(asset.id)!;
  const blob=await file(),hash=blob?await digest(new Uint8Array(await blob.arrayBuffer())):`missing:${asset.id}`;
  hashes.set(asset.id,hash);return hash;
}
/** Compare content, including attachment bytes, independently of timestamps and remapped file IDs. */
async function ideaSignature(idea:Project,hashes:Map<string,string>,file:(id:string)=>Promise<Blob|undefined>) {
  const asset=async(value:MediaAsset)=>({...value,id:await assetHash(value,hashes,()=>file(value.id))});
  return stable({...idea,id:undefined,updatedAt:undefined,coverImage:idea.coverImage?await asset(idea.coverImage):undefined,
    blocks:await Promise.all(idea.blocks.map(async block=>({...block,id:undefined,width:block.width || "full",textPosition:block.textPosition || "below",media:await Promise.all((block.media || []).map(asset))})))});
}
async function copyId(id:string,signature:string,salt=0) {
  const hash=await digest(new TextEncoder().encode(stable(["idea-bank-import-copy",id,signature,salt])));
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
/** Inspect without writing; an unresolved difference can never overwrite either version. */
export async function prepareLibraryImport(backup:LibraryBackup,current:Library,scope?:string,cloud?:CloudImportBase):Promise<LibraryImportPlan> {
  const base=parseLibrary(JSON.stringify(current)),incoming=parseLibrary(JSON.stringify(backup.library));
  const plan:LibraryImportPlan={backup:{...backup,library:incoming},base,conflicts:[],added:0,unchanged:0,sectionsAdded:incoming.sections.filter(section=>!base.sections.some(value=>value.id===section.id)).length,copies:new Map(),same:new Set(),currentHashes:new Map(),archiveHashes:new Map(backup.hashes)};
  if(cloud && cloud.scope===scope)plan.cloud=cloud;
  for(const asset of collectAssets(base).values())if(/^[a-f0-9]{64}-[a-f0-9]{32}$/.test(asset.id))plan.currentHashes.set(asset.id,asset.id.slice(0,64));
  const currentFile=async(id:string)=>{try{return await getMediaFile(id,scope);}catch{return undefined;}};
  for(const idea of incoming.projects) {
    const existing=base.projects.find(value=>value.id===idea.id);
    if(!existing){plan.added++;continue;}
    const signature=await ideaSignature(idea,plan.archiveHashes,async id=>backup.files.get(id));
    if(signature===await ideaSignature(existing,plan.currentHashes,currentFile)){plan.same.add(idea.id);plan.unchanged++;continue;}
    let candidate="",found=false;
    for(let salt=0;salt<=base.projects.length+incoming.projects.length;salt++) {
      candidate=await copyId(idea.id,signature,salt);
      if(incoming.projects.some(value=>value.id===candidate))continue;
      const previous=base.projects.find(value=>value.id===candidate);
      if(!previous)break;
      const comparable=previous.name===`${idea.name} imported`?{...previous,name:idea.name}:previous;
      if(signature===await ideaSignature(comparable,plan.currentHashes,currentFile)){found=true;break;}
    }
    if(found){plan.same.add(idea.id);plan.unchanged++;continue;}
    plan.copies.set(idea.id,candidate);plan.conflicts.push({id:idea.id,current:existing,incoming:idea});
  }
  return plan;
}
/** Commit selected additions/updates and their media atomically; never remove absent ideas. */
export async function importLibraryBackup(plan:LibraryImportPlan,choices:Record<string,ImportChoice>):Promise<Library> {
  const expected=plan.cloud?null:await readLocalSnapshot();
  if(expected && stable(expected.library)!==stable(plan.base))throw new Error(t("Библиотека изменилась в другой вкладке. Повтори восстановление, чтобы не потерять изменения."));
  const next=structuredClone(plan.base),selected:Project[]=[];
  for(const section of plan.backup.library.sections)if(!next.sections.some(value=>value.id===section.id))next.sections.push(structuredClone(section));
  for(const idea of plan.backup.library.projects) {
    if(plan.same.has(idea.id))continue;
    const position=next.projects.findIndex(value=>value.id===idea.id);
    const choice=position<0?"archive":choices[idea.id];
    if(!choice || !["current","archive","both"].includes(choice))throw new Error(t("Выберите вариант для каждой отличающейся идеи."));
    if(choice==="current")continue;
    const imported=structuredClone(idea);
    if(choice==="both") {
      imported.id=plan.copies.get(idea.id)!;
      imported.name+= " imported";
      if(!imported.id || next.projects.some(value=>value.id===imported.id))throw new Error(t("Не удалось подготовить копию идеи. Повторите импорт."));
      next.projects.push(imported);
    } else if(position<0)next.projects.push(imported);else next.projects[position]=imported;
    selected.push(imported);
  }
  if(!selected.length && !plan.sectionsAdded)return plan.base;
  const currentAssets=collectAssets(plan.base),available=new Map<string,string>();
  for(const [id,hash] of plan.currentHashes) {const asset=currentAssets.get(id);if(asset)available.set(stable([hash,asset.mime,asset.size,asset.kind]),id);}
  const files=new Map<string,Blob>(),replacements=new Map<string,string>(),used=new Set([...currentAssets.keys(),...plan.backup.files.keys()]);
  // Equal bytes may be displayed twice in one block; those frames must retain distinct IDs.
  const appearances=new Map<string,Project["blocks"]>(),assigned=new Map<Project["blocks"][number],Set<string>>();
  for(const idea of selected)for(const block of idea.blocks){assigned.set(block,new Set());for(const asset of block.media || [])appearances.set(asset.id,[...(appearances.get(asset.id) || []),block]);}
  for(const [id,asset] of collectAssets({...next,projects:selected})) {
    const blob=plan.backup.files.get(id);if(!blob || blob.size!==asset.size)throw new Error(t("Медиа для восстановления не прошли проверку."));
    const hash=await assetHash(asset,plan.archiveHashes,async()=>blob),key=stable([hash,asset.mime,asset.size,asset.kind]);
    let target=available.get(key);
    if(target && (appearances.get(id) || []).some(block=>assigned.get(block)!.has(target!)))target=undefined;
    if(!target){target=createId();while(used.has(target))target=createId();used.add(target);files.set(target,blob);available.set(key,target);}
    else if(!await readMediaFile(target))files.set(target,blob);
    replacements.set(id,target);
    for(const block of appearances.get(id) || [])assigned.get(block)!.add(target);
  }
  for(const idea of selected){if(idea.coverImage)idea.coverImage.id=replacements.get(idea.coverImage.id)!;for(const block of idea.blocks)for(const asset of block.media || [])asset.id=replacements.get(asset.id)!;}
  const checked=parseLibrary(JSON.stringify(next));
  try{
    if(plan.cloud){
      const {scope,read}=plan.cloud,local=flattenLibrary(checked);
      for(const [key,value] of Object.entries(validateRead(read,{},{}).remote))if(!Object.hasOwn(local,key))local[key]=keyParts(key).kind==="media"?value:null;
      await queueScoped(scope,read.target,read,local,0,undefined,files);
    }else await saveLocalLibrary(checked,expected?.library || null,{files});
  }
  catch(reason){if(localDiskEnabled() && reason instanceof Error)throw reason;if(reason instanceof Error && ["Сначала завершите синхронизацию и разрешите конфликты.","Библиотека изменилась в другой вкладке. Сохранение остановлено, чтобы не потерять изменения."].some(message=>t(message)===t(reason.message)))throw new Error(t(reason.message));throw new Error(t("Не удалось записать библиотеку: проверь свободное место и разрешения браузера. Прежняя библиотека сохранена."));}
  const kept=new Set(checked.projects.flatMap(projectMediaIds));
  if(!plan.cloud)void removeMediaFiles([...currentAssets.keys()].filter(id=>!kept.has(id))).catch(()=>{});
  return checked;
}

/** Stages files under fresh IDs; metadata is switched only after the media transaction succeeds. */
export async function restoreLibraryBackup(backup: LibraryBackup, current: Library): Promise<Library> {
  const expected = await readLocalSnapshot();
  if (expected && JSON.stringify(expected.library) !== JSON.stringify(current)) throw new Error(t("Библиотека изменилась в другой вкладке. Повтори восстановление, чтобы не потерять изменения."));
  const next = parseLibrary(JSON.stringify(backup.library));
  const oldIds = new Set(current.projects.flatMap(projectMediaIds));
  const staged = new Map<string, Blob>(), replacements = new Map<string, string>();
  for (const [id, asset] of collectAssets(next)) {
    const file = backup.files.get(id);
    if (!file || file.size !== asset.size) throw new Error(t("Медиа для восстановления не прошли проверку."));
    let fresh = createId(); while (oldIds.has(fresh) || staged.has(fresh)) fresh = createId();
    replacements.set(id, fresh); staged.set(fresh, file);
  }
  for (const idea of next.projects) {
    if (idea.coverImage) idea.coverImage.id = replacements.get(idea.coverImage.id)!;
    for (const block of idea.blocks) for (const asset of block.media || []) asset.id = replacements.get(asset.id)!;
  }
  try {
    await saveLocalLibrary(next, expected?.library || null, { files: staged });
  } catch (error) {
    if(localDiskEnabled() && error instanceof Error)throw error;
    throw new Error(t("Не удалось записать библиотеку: проверь свободное место и разрешения браузера. Прежняя библиотека сохранена."));
  }
  // Only references from the replaced library are removed; unknown/orphaned files stay untouched.
  void removeMediaFiles([...oldIds]).catch(() => {});
  return next;
}

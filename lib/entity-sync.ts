import { parseLibrary, type Library, type Project, type Section, type TextBlock } from "./ideas";
import { invalid, parseCloudMedia, revisionPattern, type CloudMedia } from "./cloud-library";

export type EntityValue = Section | (Omit<Project, "blocks"> & { blockIds: string[] }) | TextBlock | CloudMedia;
export type EntityMap = Record<string, EntityValue | null>;
export type EntityIndex = Record<string, string[]>;
export type EntityVersion = { key: string; revision: string; value: EntityValue | null; previous?: EntityValue[] };
export type SyncCheckpoint = { version: 2; scope: string; index: EntityIndex; values: EntityMap; syncedAt: string; files: CloudMedia[]; recovery?: Record<string,EntityValue[]> };
export type EntityChange = { key: string; base: string[]; value: EntityValue | null };
export type EntityRead = { heads: string[]; index: EntityIndex; records: EntityVersion[] };
export const entityKey = (kind: string, ...ids: string[]) => `${kind}:${JSON.stringify(ids)}`;
export const contentId = (file: Pick<CloudMedia, "sha256" | "md5">) => `${file.sha256}-${file.md5}`;
export const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
export function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export function keyParts(key: string): { kind: string; ids: string[] } {
  const split = key.indexOf(":"), kind = key.slice(0, split);
  let ids: unknown; try { ids = JSON.parse(key.slice(split + 1)); } catch { return invalid(); }
  if (!["section", "idea", "block", "media"].includes(kind) || !Array.isArray(ids) || ids.length !== (kind === "block" ? 2 : 1) || ids.some(id => typeof id !== "string" || !id || id.length > 200) || key !== entityKey(kind, ...ids)) return invalid();
  return { kind, ids };
}
/** Validate records independently; a tombstone retains its key and version. */
export function parseEntity(key: string, value: unknown): EntityValue | null {
  const { kind, ids } = keyParts(key);
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const v = value as Record<string, unknown>;
  if (v.id !== ids[ids.length - 1]) return invalid();
  if (kind === "media") { const file = parseCloudMedia(value); if (file.id !== contentId(file)) return invalid(); return file; }
  const section: Section = { id: "validation", name: "validation", description: "", icon: "folder" };
  if (kind === "section") { try { return parseLibrary(JSON.stringify({ version: 1, sections: [value], projects: [] })).sections[0]; } catch { return invalid(); } }
  const idea: Project = { id: "validation", name: "validation", description: "", sectionId: section.id, cover: "forest", blocks: [], updatedAt: "2026-01-01T00:00:00Z" };
  try {
    if (kind === "block") return parseLibrary(JSON.stringify({ version: 1, sections: [section], projects: [{ ...idea, blocks: [value] }] })).projects[0].blocks[0];
    if (!Array.isArray(v.blockIds) || v.blockIds.some(id => typeof id !== "string" || !id || id.length > 200) || new Set(v.blockIds).size !== v.blockIds.length || "blocks" in v) return invalid();
    const checked = parseLibrary(JSON.stringify({ version: 1, sections: [{ ...section, id: v.sectionId }], projects: [{ ...v, blocks: [] }] })).projects[0];
    const { blocks, ...rest } = checked;
    return { ...rest, blockIds: v.blockIds as string[] };
  } catch { return invalid(); }
}
export function flattenLibrary(library: Library, media: CloudMedia[] = []): EntityMap {
  const result: EntityMap = Object.create(null);
  for (const section of library.sections) result[entityKey("section", section.id)] = section;
  for (const idea of library.projects) {
    const { blocks, ...rest } = idea;
    result[entityKey("idea", idea.id)] = { ...rest, blockIds: blocks.map(block => block.id) };
    for (const block of blocks) result[entityKey("block", idea.id, block.id)] = block;
  }
  for (const file of media) result[entityKey("media", file.id)] = file;
  return result;
}
/** Never silently omit orphaned records or invent a parent after a concurrent deletion. */
export function assembleLibrary(values: EntityMap): Library {
  const sections: Section[] = [], projects: Project[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const { kind, ids } = keyParts(key);
    if (kind === "section") sections.push(value as Section);
    if (kind === "idea") {
      const { blockIds, ...rest } = value as Omit<Project, "blocks"> & { blockIds: string[] };
      const blocks = blockIds.map(id => values[entityKey("block", ids[0], id)]).filter(Boolean) as TextBlock[];
      if (blocks.length !== blockIds.length || !values[entityKey("section", rest.sectionId)]) throw new Error("Unresolved parent or block deletion");
      projects.push({ ...rest, blocks });
    }
    if (kind === "block") {
      const parent = values[entityKey("idea", ids[0])] as { blockIds?: string[] } | null;
      if (!parent?.blockIds?.includes(ids[1])) throw new Error("Unresolved orphaned block");
    }
  }
  sections.sort((a,b) => a.id.localeCompare(b.id)); projects.sort((a,b) => a.id.localeCompare(b.id));
  return parseLibrary(JSON.stringify({ version: 1, sections, projects }));
}
export function canonicalLibrary(library: Library, files: CloudMedia[]): Library {
  const result = structuredClone(library), replacements = new Map(files.map(file => [file.id, contentId(file)]));
  for (const idea of result.projects) for (const asset of [...(idea.coverImage ? [idea.coverImage] : []), ...idea.blocks.flatMap(block => block.media || [])]) {
    const id = replacements.get(asset.id); if (!id) return invalid("Не найдено описание вложения."); asset.id = id;
  }
  return result;
}

export type MergeConflict = { key: string; variants: (EntityValue | null)[]; structural?: boolean };
/** Three-way field merge keeps rich text/text together and treats timestamps as informational. */
export function mergeValue(key: string, base: EntityValue | null, local: EntityValue | null, remote: EntityValue | null): { value: EntityValue | null; conflict: boolean } {
  if (equal(local, remote) || equal(remote, base)) return { value: local, conflict: false };
  if (equal(local, base)) return { value: remote, conflict: false };
  if (!base || !local || !remote) return { value: local, conflict: true };
  const output: Record<string, unknown> = {}, a = base as unknown as Record<string, unknown>, b = local as unknown as Record<string, unknown>, c = remote as unknown as Record<string, unknown>;
  const fields = new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)]);
  if (keyParts(key).kind === "block") {
    const group = (v: Record<string, unknown>) => ({ text: v.text, richText: v.richText });
    const x = group(a), y = group(b), z = group(c);
    if (!equal(y,z) && !equal(y,x) && !equal(z,x)) return { value: local, conflict: true };
    Object.assign(output, equal(y,x) ? z : y); fields.delete("text"); fields.delete("richText");
  }
  for (const field of fields) {
    if (field === "updatedAt") { output[field] = [b[field], c[field]].sort().at(-1); continue; }
    if (equal(b[field],c[field]) || equal(c[field],a[field])) output[field] = b[field];
    else if (equal(b[field],a[field])) output[field] = c[field];
    else if (field === "blockIds" && Array.isArray(a[field]) && Array.isArray(b[field]) && Array.isArray(c[field])) {
      const old = a[field] as string[], left = b[field] as string[], right = c[field] as string[];
      const kept = old.filter(id => left.includes(id) && right.includes(id));
      if (!equal(left.filter(id => old.includes(id) && kept.includes(id)), kept) || !equal(right.filter(id => old.includes(id) && kept.includes(id)), kept)) return { value: local, conflict: true };
      output[field] = [...kept, ...new Set([...left, ...right].filter(id => !old.includes(id)).sort())];
    } else return { value: local, conflict: true };
  }
  return { value: JSON.parse(JSON.stringify(output)) as EntityValue, conflict: false };
}

function versionIds(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 16 && value.every(id => typeof id === "string" && revisionPattern.test(id)) && new Set(value).size === value.length; }
export function validateRead(value: EntityRead, known: EntityIndex, previous: EntityMap, oldRecovery: Record<string,EntityValue[]> = {}): { remote: EntityMap; recovery?: Record<string,EntityValue[]>; variants: Record<string,(EntityValue | null)[]> } {
  if (!value || !versionIds(value.heads) || !value.index || typeof value.index !== "object" || Array.isArray(value.index) || !Array.isArray(value.records)) throw new Error("Неполный ответ истории облака.");
  const records = new Map<string, EntityValue | null>(), recovery = { ...oldRecovery };
  for (const record of value.records) {
    const key = JSON.stringify([record.key,record.revision]);
    if (records.has(key) || !value.index[record.key]?.includes(record.revision)) throw new Error("Неполный ответ истории облака.");
    records.set(key, parseEntity(record.key,record.value));
    if (record.previous) { if (!Array.isArray(record.previous) || record.previous.length > 16) throw new Error("Неполный ответ истории облака."); recovery[record.key] = record.previous.map(value => parseEntity(record.key,value)).filter(Boolean) as EntityValue[]; }
  }
  const remote: EntityMap = Object.create(null), variants: Record<string,(EntityValue | null)[]> = Object.create(null);
  for (const [key, revisions] of Object.entries(value.index)) {
    keyParts(key); if (!versionIds(revisions) || !revisions.length) throw new Error("Неполный ответ истории облака.");
    variants[key] = revisions.map(id => {
      const identity = JSON.stringify([key,id]);
      if (records.has(identity)) return records.get(identity)!;
      if (revisions.length === 1 && equal(revisions,known[key]) && Object.hasOwn(previous,key)) return previous[key];
      throw new Error("Неполный ответ истории облака.");
    });
    remote[key] = variants[key][0];
  }
  return { remote, variants, recovery };
}

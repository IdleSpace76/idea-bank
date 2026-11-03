import { translate as t } from "./i18n";
import { createMD5, createSHA256, sha256 } from "hash-wasm";
import { createId, parseLibrary, STORAGE_KEY, type Library } from "./ideas";
import { libraryAssets, parseCloudSnapshot, type CloudMedia, type CloudSnapshot } from "./cloud-library";
import { CLOUD_STATE_KEY, readCloudState, publishCloudDownload, type CloudState } from "./cloud-state";
import { readMediaFile, saveMediaFiles, removeMediaFiles, projectMediaIds } from "./media-store";

export type SyncPlan = { scope: string; expectedRaw: string | null; library: Library; state: CloudState | null; heads: string[]; snapshots: CloudSnapshot[]; action: "upload" | "download" | "review" | "equal"; };
type Progress = (message: string) => void;
class CloudError extends Error { constructor(message: string, public code = "", public revisions: string[] = []) { super(t(message)); } }

async function api(path: string, init?: RequestInit): Promise<any> {
  let response: Response;
  try { response = await fetch(`/api/storage/${path}`, { ...init, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(65000) }); }
  catch { throw new CloudError(t("Нет связи с облаком. Локальные идеи сохранены; повтори синхронизацию позже.")); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new CloudError(response.status === 401 ? t("Сессия истекла. Сохрани правки и войди через GitHub снова.") : data?.error?.message || t("Не удалось выполнить облачный запрос."), data?.error?.code, data?.error?.revisions || []);
  if (!data) throw new CloudError(t("Некорректный ответ облака."));
  return data;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function unchanged(plan: SyncPlan) { if (localStorage.getItem(STORAGE_KEY) !== plan.expectedRaw) throw new CloudError(t("Библиотека изменилась в другой вкладке. Повтори синхронизацию.")); }
function signedUrl(value: unknown): string {
  if (typeof value !== "string") throw new CloudError(t("Не удалось получить ссылку на медиа."));
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(url.hostname) || url.username || url.password) throw new CloudError(t("Получен неверный адрес медиа."));
  return value;
}

/** Hash one Blob incrementally, keeping memory independent of the total library size. */
export async function hashMedia(blob: Blob) {
  const [sha, md5] = await Promise.all([createSHA256(), createMD5()]); sha.init(); md5.init();
  const reader = blob.stream().getReader();
  try { while (true) { const part = await reader.read(); if (part.done) break; sha.update(part.value); md5.update(part.value); } }
  finally { reader.releaseLock(); }
  return { sha256: sha.digest("hex"), md5: md5.digest("hex") };
}

/** Compare the device baseline with every cloud head; never guess a winner for conflicts. */
export async function inspectCloud(scope: string, library: Library): Promise<SyncPlan> {
  const expectedRaw = localStorage.getItem(STORAGE_KEY), state = readCloudState(scope);
  if (expectedRaw !== null && JSON.stringify(parseLibrary(expectedRaw)) !== JSON.stringify(library)) throw new CloudError(t("В другой вкладке есть изменения. Обнови страницу перед синхронизацией."));
  let heads: string[], snapshots: CloudSnapshot[];
  try {
    const result = await api("library");
    const snapshot = result.snapshot ? parseCloudSnapshot(result.snapshot) : null;
    heads = result.heads; snapshots = snapshot ? [snapshot] : [];
  } catch (error) {
    if (!(error instanceof CloudError) || error.code !== "CONFLICT" || !error.revisions.length || error.revisions.length > 16) throw error;
    heads = error.revisions;
    snapshots = await Promise.all(heads.map(async id => parseCloudSnapshot((await api(`library?revision=${encodeURIComponent(id)}`)).snapshot)));
  }
  if (!Array.isArray(heads) || heads.length !== snapshots.length || snapshots.some(snapshot => !heads.includes(snapshot.revision))) throw new CloudError(t("Неполный ответ истории облака."));
  const localChanged = !state || state.baseline !== await sha256(JSON.stringify(library));
  const remoteChanged = !state || heads.length !== 1 || heads[0] !== state.revision;
  let action: SyncPlan["action"] = "review";
  if (state && heads.length === 1) action = !remoteChanged ? (localChanged ? "upload" : "equal") : !localChanged ? "download" : "review";
  // A first transfer, including to an empty bucket, always requires explicit review.
  const plan = { scope, expectedRaw, library: structuredClone(library), state, heads, snapshots, action };
  unchanged(plan);
  return plan;
}

/** Upload only missing content-addressed files; publish metadata after every file succeeded. */
export async function uploadCloud(plan: SyncPlan, progress: Progress): Promise<CloudState> {
  unchanged(plan);
  const files: CloudMedia[] = [], assets = [...libraryAssets(plan.library).values()];
  for (const [index, asset] of assets.entries()) {
    progress(t("Проверяем и отправляем медиа {0} из {1}…", { 0: index + 1, 1: assets.length }));
    const blob = await readMediaFile(asset.id);
    if (!blob || blob.size !== asset.size) throw new CloudError(t("Не найден исходный файл «{0}». Облако не обновлено.", { 0: asset.name }));
    const media = { id: asset.id, mime: asset.mime, size: blob.size, ...await hashMedia(blob) };
    const upload = await api("media/upload", json("POST", media));
    if (!upload.alreadyUploaded) {
      try {
        const response = await fetch(signedUrl(upload.url), { method: "PUT", headers: upload.headers, body: blob, credentials: "omit", signal: AbortSignal.timeout(15 * 60 * 1000) });
        if (!response.ok) throw new Error();
      } catch { throw new CloudError(t("Не удалось загрузить медиа в B2. Проверь связь и CORS хранилища. Локальная библиотека не изменена.")); }
    }
    files.push(media);
  }
  unchanged(plan); progress(t("Сохраняем библиотеку в облаке…"));
  const { snapshot } = await api("library", json("PUT", { baseRevisions: plan.heads, library: plan.library, media: files }));
  const saved = parseCloudSnapshot(snapshot);
  const state: CloudState = { version: 1, scope: plan.scope, revision: saved.revision, baseline: await sha256(JSON.stringify(plan.library)), syncedAt: new Date().toISOString(), files };
  // If another tab edited while the request was in flight, its edits stay local and remain dirty.
  localStorage.setItem(CLOUD_STATE_KEY, JSON.stringify(state));
  return state;
}

async function downloadMedia(snapshot: CloudSnapshot, media: CloudMedia): Promise<Blob> {
  const signed = await api(`media/download?revision=${encodeURIComponent(snapshot.revision)}&id=${encodeURIComponent(media.id)}`);
  let response: Response;
  try { response = await fetch(signedUrl(signed.url), { credentials: "omit", signal: AbortSignal.timeout(15 * 60 * 1000) }); }
  catch { throw new CloudError(t("Не удалось скачать медиа из B2. Проверь связь и CORS хранилища.")); }
  if (!response.ok || !response.body) throw new CloudError(t("Облако не вернуло файл. Прежняя библиотека сохранена."));
  const [sha, md5] = await Promise.all([createSHA256(), createMD5()]); sha.init(); md5.init();
  const chunks: Uint8Array<ArrayBuffer>[] = [], reader = response.body.getReader(); let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > media.size) { await reader.cancel(); throw new CloudError(t("Размер скачанного файла не совпадает с библиотекой.")); }
      sha.update(part.value); md5.update(part.value); chunks.push(new Uint8Array(part.value));
    }
  } finally { reader.releaseLock(); }
  if (size !== media.size || sha.digest("hex") !== media.sha256 || md5.digest("hex") !== media.md5) throw new CloudError(t("Скачанный файл не прошёл проверку целостности. Прежняя библиотека сохранена."));
  return new Blob(chunks, { type: media.mime });
}

/** Stage media under fresh local IDs; replace the device library only after all checks finish. */
export async function downloadCloud(plan: SyncPlan, chosen: CloudSnapshot, progress: Progress): Promise<{ library: Library; state: CloudState }> {
  unchanged(plan);
  let snapshot = chosen;
  if (plan.heads.length > 1) {
    // The explicit user choice resolves branches; other snapshots remain in history.
    snapshot = parseCloudSnapshot((await api("library", json("PUT", { baseRevisions: plan.heads, library: chosen.library, media: chosen.media }))).snapshot);
  }
  const next = structuredClone(snapshot.library), replacements = new Map<string, string>(), staged: string[] = [], files: CloudMedia[] = [];
  const cached = new Map((plan.state?.files || []).map(file => [`${file.sha256}-${file.md5}`, file]));
  try {
    for (const [index, media] of snapshot.media.entries()) {
      progress(t("Получаем медиа {0} из {1}…", { 0: index + 1, 1: snapshot.media.length }));
      const old = cached.get(`${media.sha256}-${media.md5}`);
      let blob = old ? await readMediaFile(old.id) : undefined;
      if (blob) { const hash = await hashMedia(blob); if (blob.size !== media.size || hash.sha256 !== media.sha256 || hash.md5 !== media.md5) blob = undefined; }
      blob ||= await downloadMedia(snapshot, media);
      const id = createId(); replacements.set(media.id, id); staged.push(id);
      await saveMediaFiles(new Map([[id, blob]])); files.push({ ...media, id });
      unchanged(plan);
    }
    for (const idea of next.projects) {
      if (idea.coverImage) idea.coverImage.id = replacements.get(idea.coverImage.id)!;
      for (const block of idea.blocks) for (const asset of block.media || []) asset.id = replacements.get(asset.id)!;
    }
    const state: CloudState = { version: 1, scope: plan.scope, revision: snapshot.revision, baseline: await sha256(JSON.stringify(next)), syncedAt: new Date().toISOString(), files };
    progress(t("Сохраняем библиотеку на устройстве…"));
    publishCloudDownload(plan.expectedRaw, JSON.stringify(next), state);
    void removeMediaFiles(plan.library.projects.flatMap(projectMediaIds).filter(id => !staged.includes(id))).catch(() => {});
    return { library: next, state };
  } catch (error) {
    await removeMediaFiles(staged).catch(() => {});
    if (error instanceof DOMException && ["QuotaExceededError", "SecurityError", "UnknownError"].includes(error.name)) throw new CloudError(t("Не удалось сохранить медиа или библиотеку на устройстве. Проверь свободное место и разрешения браузера. Прежняя библиотека сохранена."));
    throw error;
  }
}

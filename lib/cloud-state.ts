import { STORAGE_KEY } from "./ideas";
import type { CloudMedia } from "./cloud-library";
import { parseCloudMedia, revisionPattern } from "./cloud-library";

export const CLOUD_STATE_KEY = "idea-bank.cloud.v1";
export type CloudState = { version: 1; scope: string; revision: string; baseline: string; syncedAt: string; files: CloudMedia[] };
type Journal = { journal: true; targetRaw: string; next: CloudState; previous: CloudState | null };

/** Recover an interrupted two-key commit before another local edit can change its meaning. */
export function prepareLocalSave(): CloudState | null {
  const raw = localStorage.getItem(CLOUD_STATE_KEY);
  if (!raw) return null;
  let value: CloudState | Journal;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  if ("journal" in value && value.journal === true) {
    const selected = localStorage.getItem(STORAGE_KEY) === value.targetRaw ? value.next : value.previous;
    if (selected) localStorage.setItem(CLOUD_STATE_KEY, JSON.stringify(selected)); else localStorage.removeItem(CLOUD_STATE_KEY);
    return selected;
  }
  return value as CloudState;
}

export function readCloudState(scope: string): CloudState | null {
  const state = prepareLocalSave();
  if (!state || state.scope !== scope) return null;
  if (state.version !== 1 || typeof state.revision !== "string" || !revisionPattern.test(state.revision) || typeof state.baseline !== "string" || !/^[a-f0-9]{64}$/.test(state.baseline) || typeof state.syncedAt !== "string" || !Number.isFinite(Date.parse(state.syncedAt)) || !Array.isArray(state.files)) return null;
  try { state.files.forEach(parseCloudMedia); } catch { return null; }
  return state;
}

/** Media are already staged. A journal makes both metadata writes recoverable after quota/crash. */
export function publishCloudDownload(expectedRaw: string | null, targetRaw: string, state: CloudState) {
  const previous = prepareLocalSave();
  if (localStorage.getItem(STORAGE_KEY) !== expectedRaw) throw new Error("Библиотека изменилась в другой вкладке. Повтори синхронизацию.");
  const previousRaw = localStorage.getItem(CLOUD_STATE_KEY);
  localStorage.setItem(CLOUD_STATE_KEY, JSON.stringify({ journal: true, targetRaw, next: state, previous } satisfies Journal));
  try { localStorage.setItem(STORAGE_KEY, targetRaw); }
  catch (error) {
    try { if (previousRaw === null) localStorage.removeItem(CLOUD_STATE_KEY); else localStorage.setItem(CLOUD_STATE_KEY, previousRaw); } catch { /* Journal selects the unchanged previous library on recovery. */ }
    throw error;
  }
  try { localStorage.setItem(CLOUD_STATE_KEY, JSON.stringify(state)); } catch { /* Journal selects next; the next local edit must settle it first. */ }
}

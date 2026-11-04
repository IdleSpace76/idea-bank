import type { CloudMedia } from "./cloud-library";
import { parseCloudMedia, revisionPattern } from "./cloud-library";
import { readMeta, readLocalSnapshot, saveLocalLibrary } from "./library-store";
import { parseLibrary } from "./ideas";
export const CLOUD_STATE_KEY = "idea-bank.cloud.v1";
export type CloudState = { version: 1; scope: string; revision: string; baseline: string; syncedAt: string; files: CloudMedia[] };

export async function readCloudState(scope: string): Promise<CloudState | null> {
  const state = await readMeta<CloudState>("cloud");
  if (!state || state.scope !== scope || state.version !== 1 || typeof state.revision !== "string" || !revisionPattern.test(state.revision) || typeof state.baseline !== "string" || !/^[a-f0-9]{64}$/.test(state.baseline) || !Number.isFinite(Date.parse(state.syncedAt)) || !Array.isArray(state.files)) return null;
  try { state.files.forEach(parseCloudMedia); } catch { return null; }
  return state;
}
export async function publishCloudDownload(expectedRaw: string | null, targetRaw: string, state: CloudState) {
  const current = await readLocalSnapshot();
  if ((current ? JSON.stringify(current.library) : null) !== expectedRaw) throw new Error("Библиотека изменилась в другой вкладке. Повтори синхронизацию.");
  await saveLocalLibrary(parseLibrary(targetRaw), current?.library || null, { remote: true, cloud: state });
}

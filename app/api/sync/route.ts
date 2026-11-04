import { storageEndpoint, readStorageBody } from "@/lib/storage-api";
import { EntityStorage } from "@/lib/entity-storage";
import { invalid, StorageError, revisionPattern } from "@/lib/cloud-library";
import { keyParts, type EntityIndex } from "@/lib/entity-sync";
import { saveAndNotify } from "@/lib/sync-events-server";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  return storageEndpoint(request, false, storage => new EntityStorage(storage).status());
}
export async function POST(request: Request) {
  return storageEndpoint(request, true, async storage => {
    const value = await readStorageBody(request) as { known?: EntityIndex; activate?: boolean };
    if (!value || !value.known || typeof value.known !== "object" || Array.isArray(value.known) || Object.keys(value.known).length > 50000) return invalid();
    for (const [key, versions] of Object.entries(value.known)) { keyParts(key); if (!Array.isArray(versions) || versions.length > 16 || versions.some(id => !revisionPattern.test(id))) return invalid(); }
    const service=new EntityStorage(storage);
    if ((await service.status()).requiresMigration && value.activate !== true) throw new StorageError(409,"MIGRATION_REQUIRED","Требуется переход на новую синхронизацию.");
    return service.read(value.known);
  });
}
export async function PUT(request: Request) {
  return storageEndpoint(request, true, async storage => {
    const value=await readStorageBody(request), service=new EntityStorage(storage);
    if (!value || typeof value !== "object" || !("operationId" in value) || !("changes" in value)) return invalid();
    if ((await service.status()).requiresMigration) throw new StorageError(409,"MIGRATION_REQUIRED","Требуется переход на новую синхронизацию.");
    return saveAndNotify(() => service.save(value));
  });
}

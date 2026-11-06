import {storageEndpoint,readStorageBody} from "@/lib/storage-api";
import {EntityStorage} from "@/lib/entity-storage";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:Request) {
  return storageEndpoint(request,true,async storage=>new EntityStorage(storage).readReaderBatch(await readStorageBody(request)));
}

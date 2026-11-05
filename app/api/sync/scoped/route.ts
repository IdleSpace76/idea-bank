import { storageEndpoint,readStorageBody } from "@/lib/storage-api";
import { EntityStorage } from "@/lib/entity-storage";
import { saveAndNotify } from "@/lib/sync-events-server";
import type { SyncTarget } from "@/lib/scoped-types";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request: Request) {
  return storageEndpoint(request,true,async storage=>{
    const input=await readStorageBody(request) as {target:SyncTarget;includeIdeas?:string[];includeMedia?:string[]};
    return new EntityStorage(storage).readScoped(input?.target,input?.includeIdeas,input?.includeMedia);
  });
}
export async function PUT(request: Request) {
  return storageEndpoint(request,true,async storage=>{
    const input=await readStorageBody(request);
    return saveAndNotify(()=>new EntityStorage(storage).save(input));
  });
}

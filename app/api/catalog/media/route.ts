import { storageEndpoint } from "@/lib/storage-api";
import { EntityStorage } from "@/lib/entity-storage";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  return storageEndpoint(request,false,storage => new EntityStorage(storage).catalog().readMedia(new URL(request.url).searchParams.get("id") || ""));
}

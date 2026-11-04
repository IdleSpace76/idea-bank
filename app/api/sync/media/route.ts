import { storageEndpoint } from "@/lib/storage-api";
import { EntityStorage } from "@/lib/entity-storage";
export const runtime = "nodejs";
export async function GET(request: Request) {
  return storageEndpoint(request, false, storage => {
    const url = new URL(request.url);
    return new EntityStorage(storage).download(url.searchParams.get("key") || "", url.searchParams.get("revision") || "");
  });
}

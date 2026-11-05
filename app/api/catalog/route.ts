import { storageEndpoint } from "@/lib/storage-api";
import { EntityStorage } from "@/lib/entity-storage";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  return storageEndpoint(request, false, storage => new EntityStorage(storage).catalog().readPage({
    limit: query.has("limit") ? Number(query.get("limit")) : undefined,
    cursor: query.get("cursor") ?? undefined,
    sectionId: query.get("sectionId") ?? undefined,
    query: query.get("q") ?? undefined,
  }));
}

import { storageEndpoint } from "@/lib/storage-api";
import { createSyncEventToken } from "@/lib/sync-events-server";

export const runtime = "nodejs";

/** Use the existing owner and exact-Origin gates; never accept capabilities from the caller. */
export async function POST(request: Request) {
  return storageEndpoint(request, true, async () => createSyncEventToken());
}

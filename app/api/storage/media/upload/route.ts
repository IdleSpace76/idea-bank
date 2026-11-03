import { readStorageBody, storageEndpoint } from "@/lib/storage-api";

export const runtime = "nodejs";
export async function POST(request: Request) {
  return storageEndpoint(request, true, async storage => storage.createUpload(await readStorageBody(request)));
}

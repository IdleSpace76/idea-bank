import { readStorageBody, storageEndpoint } from "@/lib/storage-api";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  return storageEndpoint(request, false, storage => storage.readLibrary(new URL(request.url).searchParams.get("revision") || undefined));
}
export async function PUT(request: Request) {
  return storageEndpoint(request, true, async storage => storage.saveLibrary(await readStorageBody(request)));
}

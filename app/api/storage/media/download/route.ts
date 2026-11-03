import { storageEndpoint } from "@/lib/storage-api";
import { StorageError } from "@/lib/cloud-library";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return storageEndpoint(request, false, storage => {
    const query = new URL(request.url).searchParams;
    const revision = query.get("revision"), id = query.get("id");
    if (!revision || !id) throw new StorageError(400, "INVALID_DATA", "Нужны версия библиотеки и ID вложения.");
    return storage.createDownload(revision, id);
  });
}

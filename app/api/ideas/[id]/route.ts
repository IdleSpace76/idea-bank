import { storageEndpoint } from "@/lib/storage-api";
import { EntityStorage } from "@/lib/entity-storage";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const known = request.headers.get("if-none-match")?.replace(/^"|"$/g, "");
  const versionOnly = new URL(request.url).searchParams.get("versionOnly") === "1";
  let version: string | undefined, notModified = false;
  const response = await storageEndpoint(request, false, async storage => {
    const result = await new EntityStorage(storage).catalog().readIdea(id, known, versionOnly);
    version = result.version;
    notModified = "notModified" in result && result.notModified;
    return result;
  });
  if (response.status !== 200 || !version) return response;
  response.headers.set("ETag", `"${version}"`);
  return notModified ? new Response(null, { status: 304, headers: response.headers }) : response;
}

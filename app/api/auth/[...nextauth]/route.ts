import { Auth } from "@auth/core";
import { ownerAuthConfig } from "@/auth";
import { readAuthSettings } from "@/lib/auth-settings";

export const runtime = "nodejs";
async function handle(request: Request) {
  const settings = readAuthSettings();
  if (settings.mode !== "github") return Response.json({ error: "Authentication unavailable" }, { status: settings.mode === "local" ? 404 : 503 });
  // Preserve the configured origin: NextRequest normalizes 127.0.0.1 to localhost.
  // OAuth callback and token exchange must use the exact same registered address.
  const incoming = new URL(request.url);
  const canonical = new URL(incoming.pathname + incoming.search, process.env.AUTH_URL!);
  return Auth(new Request(canonical, request), ownerAuthConfig());
}
export { handle as GET, handle as POST };

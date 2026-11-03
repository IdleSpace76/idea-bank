import { IdeaBank } from "@/components/idea-bank";
import { getOwnerSession } from "@/auth";
import { readAuthSettings } from "@/lib/auth-settings";
import { AuthScreen } from "@/components/auth-screen";
import { readB2Settings } from "@/lib/b2-storage";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const settings = readAuthSettings();
  if (settings.mode === "local") return <IdeaBank />;
  if (settings.mode === "invalid") return <AuthScreen configurationError={settings.error} />;
  const session = await getOwnerSession();
  if (session) {
    let cloudScope: string | undefined;
    try { const b2 = readB2Settings(); cloudScope = createHash("sha256").update(`${session.user?.id}:${b2.endpoint}:${b2.bucket}`).digest("hex"); } catch { /* Local library remains available until B2 is configured. */ }
    return <IdeaBank account={session.user?.name || "GitHub"} cloudScope={cloudScope} />;
  }
  const { error } = await searchParams;
  return <AuthScreen error={error} />;
}

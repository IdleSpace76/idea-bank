import { IdeaBank } from "@/components/idea-bank";
import { getOwnerSession } from "@/auth";
import { readAuthSettings } from "@/lib/auth-settings";
import { loginWithGitHub } from "./auth-actions";
import { readB2Settings } from "@/lib/b2-storage";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const settings = readAuthSettings();
  if (settings.mode === "local") return <IdeaBank />;
  if (settings.mode === "invalid") return <main className="auth-screen"><section className="auth-card"><h1>Вход не настроен</h1><p>{settings.error}</p><p>Исправь серверные переменные по инструкции docs/github-login.md.</p></section></main>;
  const session = await getOwnerSession();
  if (session) {
    let cloudScope: string | undefined;
    try { const b2 = readB2Settings(); cloudScope = createHash("sha256").update(`${session.user?.id}:${b2.endpoint}:${b2.bucket}`).digest("hex"); } catch { /* Local library remains available until B2 is configured. */ }
    return <IdeaBank account={session.user?.name || "GitHub"} cloudScope={cloudScope} />;
  }
  const { error } = await searchParams;
  return <main className="auth-screen"><section className="auth-card"><span className="brand-mark">i.</span><h1>Твой банк идей</h1><p>Войти может только владелец этой копии приложения.</p>{error && <p role="alert">{error === "AccessDenied" ? "Этот GitHub-аккаунт не является владельцем." : "Не удалось войти. Попробуй ещё раз или проверь настройки GitHub App."}</p>}<form action={loginWithGitHub}><button className="primary-button" type="submit">Войти через GitHub</button></form><p className="auth-note">После настройки B2 библиотеку можно синхронизировать между устройствами по кнопке.</p></section></main>;
}

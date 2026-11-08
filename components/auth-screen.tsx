"use client";

import { loginWithGitHub } from "@/app/auth-actions";
import { LanguagePicker, useI18n } from "./language-picker";

export function AuthScreen({ configurationError, error,agentReturn }: { configurationError?: string; error?: string;agentReturn?:string }) {
  const { t } = useI18n();
  const problem = configurationError?.match(/^Не заполнены: (.+)\.$/);
  return <main className="auth-screen"><section className="auth-card"><div className="auth-language"><LanguagePicker /></div>{configurationError ? <><h1>{t("Вход не настроен")}</h1><p>{problem ? t("Не заполнены: {0}.", { 0: problem[1] }) : t(configurationError)}</p><p>{t("Исправь серверные переменные по инструкции docs/github-login.md.")}</p></> : <><span className="brand-mark">i.</span><h1>{t("Твой банк идей")}</h1><p>{t("Войти может только владелец этой копии приложения.")}</p>{error && <p role="alert">{t(error === "AccessDenied" ? "Этот GitHub-аккаунт не является владельцем." : "Не удалось войти. Попробуй ещё раз или проверь настройки GitHub App.")}</p>}<form action={loginWithGitHub}>{agentReturn && <input type="hidden" name="agentReturn" value={agentReturn} />}<button className="primary-button" type="submit">{t("Войти через GitHub")}</button></form><p className="auth-note">{t("После настройки B2 библиотека синхронизируется между устройствами автоматически.")}</p></>}</section></main>;
}

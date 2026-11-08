/** Reads server configuration without exposing credential values in errors. */
export function readAuthSettings(env: Record<string, string | undefined> = process.env) {
  const mode = env.IDEA_BANK_AUTH_MODE?.trim() || "local";
  if (mode === "local") return { mode: "local" as const };
  if (mode !== "github") return { mode: "invalid" as const, error: "IDEA_BANK_AUTH_MODE должен быть local или github." };
  const required = ["AUTH_URL", "AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "IDEA_BANK_OWNER_ID"] as const;
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) return { mode: "invalid" as const, error: `Не заполнены: ${missing.join(", ")}.` };
  try {
    const url = new URL(env.AUTH_URL!);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new Error();
  } catch { return { mode: "invalid" as const, error: "AUTH_URL должен быть HTTPS-адресом сайта без пути; HTTP разрешён только для localhost." }; }
  if (env.AUTH_SECRET!.length < 32 || !/^[1-9]\d*$/.test(env.IDEA_BANK_OWNER_ID!)) return { mode: "invalid" as const, error: "Нужны AUTH_SECRET длиной от 32 символов и числовой IDEA_BANK_OWNER_ID." };
  return { mode: "github" as const, ownerId: env.IDEA_BANK_OWNER_ID!, secret: env.AUTH_SECRET!, clientId: env.AUTH_GITHUB_ID!, clientSecret: env.AUTH_GITHUB_SECRET! };
}

/** Re-check the stable GitHub ID on every session read, including after an owner change. */
export function isOwner(id: unknown, ownerId: string) { return typeof id === "string" && id === ownerId; }
/** Only the two agent flows may resume after sign-in; arbitrary return URLs stay blocked. */
export function agentReturnPath(raw:unknown,origin:string){
  if(typeof raw!=="string" || raw.length>24000)return "/";
  try{const value=new URL(raw,origin);return value.origin===origin && ["/api/mcp/oauth/authorize","/mcp/upload"].includes(value.pathname)?`${value.pathname}${value.search}${value.hash}`:"/";}catch{return "/";}
}

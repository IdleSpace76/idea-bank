import NextAuth, { type NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import { isOwner, readAuthSettings } from "@/lib/auth-settings";

export function ownerAuthConfig(): NextAuthConfig {
  const settings = readAuthSettings();
  if (settings.mode !== "github") throw new Error("GitHub authentication is not configured.");
  return {
    secret: settings.secret,
    basePath: "/api/auth",
    trustHost: true, // AUTH_URL is mandatory and fixes the canonical origin.
    session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
    pages: { signIn: "/", error: "/" },
    providers: [GitHub({
      clientId: settings.clientId, clientSecret: settings.clientSecret,
      checks: ["pkce", "state"],
      authorization: { params: { scope: "" } }, // GitHub App permissions, not OAuth App scopes.
      userinfo: {
        url: "https://api.github.com/user",
        async request({ tokens }: { tokens: { access_token?: string } }) {
          const response = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "Idea-Bank" }, cache: "no-store" });
          if (!response.ok) throw new Error("GitHub profile request failed.");
          return response.json();
        },
      },
      profile(profile) { return { id: String(profile.id), name: profile.login, email: null, image: null }; },
    })],
    callbacks: {
      signIn({ account, profile }) { return account?.provider === "github" && isOwner(String(profile?.id ?? ""), settings.ownerId); },
      jwt({ token, account }) {
        if (account) token.sub = account.provider === "github" ? account.providerAccountId : "";
        // Provider access/refresh tokens are deliberately not persisted in the session.
        return token;
      },
      session({ session, token }) {
        session.user.id = isOwner(token.sub, settings.ownerId) ? token.sub! : "";
        return session;
      },
      redirect({ url, baseUrl }) { return url === baseUrl || url === `${baseUrl}/` ? url : `${baseUrl}/`; },
    },
  };
}

export const { auth, signIn, signOut } = NextAuth(ownerAuthConfig);

/** Shared server-side gate for the page and future private data endpoints. */
export async function getOwnerSession() {
  const settings = readAuthSettings();
  if (settings.mode !== "github") return null;
  const session = await auth();
  return isOwner(session?.user?.id, settings.ownerId) ? session : null;
}

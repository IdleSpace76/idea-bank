"use server";

import { signIn, signOut } from "@/auth";
import { readAuthSettings,agentReturnPath } from "@/lib/auth-settings";

export async function loginWithGitHub(form?:FormData) {
  if (readAuthSettings().mode !== "github") throw new Error("GitHub authentication is unavailable.");
  await signIn("github", { redirectTo: agentReturnPath(form?.get("agentReturn"),new URL(process.env.AUTH_URL!).origin) });
}

export async function logout() {
  if (readAuthSettings().mode !== "github") throw new Error("GitHub authentication is unavailable.");
  await signOut({ redirectTo: "/" });
}

"use server";

import { signIn, signOut } from "@/auth";
import { readAuthSettings } from "@/lib/auth-settings";

export async function loginWithGitHub() {
  if (readAuthSettings().mode !== "github") throw new Error("GitHub authentication is unavailable.");
  await signIn("github", { redirectTo: "/" });
}

export async function logout() {
  if (readAuthSettings().mode !== "github") throw new Error("GitHub authentication is unavailable.");
  await signOut({ redirectTo: "/" });
}

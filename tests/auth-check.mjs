import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { encode } from "next-auth/jwt";
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = await readFile(new URL("../lib/auth-settings.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { readAuthSettings, isOwner } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const secret = "test-session-secret-for-isolated-auth-check-only";
assert.equal(readAuthSettings({}).mode, "local");
assert.equal(readAuthSettings({ IDEA_BANK_AUTH_MODE: "typo" }).mode, "invalid");
assert.equal(readAuthSettings({ IDEA_BANK_AUTH_MODE: "github" }).mode, "invalid");
const valid = { IDEA_BANK_AUTH_MODE: "github", AUTH_SECRET: secret, AUTH_GITHUB_ID: "test-client", AUTH_GITHUB_SECRET: "test-client-secret", IDEA_BANK_OWNER_ID: "12345", AUTH_URL: "https://example.org" };
assert.equal(readAuthSettings(valid).mode, "github");
for (const url of ["http://example.org", Object.assign(new URL("https://example.org"), { username: "test", password: "test" }).href, "https://example.org/path", "https://example.org?next=evil"]) assert.equal(readAuthSettings({ ...valid, AUTH_URL: url }).mode, "invalid");
assert.equal(isOwner("12345", "12345"), true);
assert.equal(isOwner("67890", "12345"), false);

async function withServer(mode, run) {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, ...valid, AUTH_URL: origin, IDEA_BANK_AUTH_MODE: mode, B2_S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com", B2_REGION: "eu-central-003", B2_BUCKET_NAME: "example-test-bucket", B2_KEY_ID: "fixture-key", B2_APPLICATION_KEY: "fixture-secret" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-4000); });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Isolated test server exited before startup.");
      try { await fetch(origin); ready = true; break; } catch { await delay(100); }
    }
    assert.ok(ready, "Isolated server starts");
    await run(origin);
  } finally {
    child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  }
}

await withServer("github", async origin => {
  const anonymous = await (await fetch(origin)).text();
  assert.ok(anonymous.includes("Sign in with GitHub"));
  assert.ok(!anonymous.includes("Opening your library"), "Anonymous response does not include the library");
  const cookieName = "authjs.session-token";
  async function sessionCookie(sub) {
    return `${cookieName}=${await encode({ secret, salt: cookieName, token: { sub, name: "Owner fixture" }, maxAge: 60 })}`;
  }
  const ownerCookie = await sessionCookie("12345");
  for (const [path, method] of [["library", "GET"], ["library", "PUT"], ["media/upload", "POST"], ["media/download", "GET"]]) {
    const response = await fetch(`${origin}/api/storage/${path}`, { method });
    assert.equal(response.status, 401, "Storage requires the owner");
    assert.ok(response.headers.get("cache-control").includes("no-store"));
    assert.equal((await fetch(`${origin}/api/storage/${path}`, { method, headers: { Cookie: await sessionCookie("67890") } })).status, 401, "Other accounts cannot access storage");
  }
  const write = (path, body, extra = {}) => fetch(`${origin}/api/storage/${path}`, { method: path === "library" ? "PUT" : "POST", headers: { Cookie: ownerCookie, Origin: origin, "Content-Type": "application/json", ...extra }, body });
  assert.equal((await write("library", "{}", { Origin: "https://example.org" })).status, 403, "Foreign origin is denied before storage access");
  assert.equal((await write("library", "{}", { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await write("library", "{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await write("library", "{" )).status, 400);
  assert.equal((await write("library", "{}" )).status, 400);
  assert.equal((await write("media/upload", "{}" )).status, 400);
  assert.equal((await write("library", '"' + "x".repeat(3 * 1024 * 1024) + '"')).status, 413, "Oversized JSON is bounded before parsing");
  assert.equal((await fetch(`${origin}/api/storage/library?revision=bad`, { headers: { Cookie: ownerCookie } })).status, 400);
  assert.equal((await fetch(`${origin}/api/storage/media/download`, { headers: { Cookie: ownerCookie } })).status, 400);
  const owner = await (await fetch(origin, { headers: { Cookie: ownerCookie } })).text();
  assert.ok(owner.includes("Sign out") && owner.includes("Opening your library"), "Owner sees library and logout");
  const other = await (await fetch(origin, { headers: { Cookie: await sessionCookie("67890") } })).text();
  assert.ok(other.includes("Sign in with GitHub") && !other.includes("Opening your library"), "Different owner is denied");
  const tampered = await (await fetch(origin, { headers: { Cookie: `${ownerCookie}tampered` } })).text();
  assert.ok(tampered.includes("Sign in with GitHub"), "Tampered session is denied");
  const csrfResponse = await fetch(`${origin}/api/auth/csrf`);
  const { csrfToken } = await csrfResponse.json();
  const cookies = csrfResponse.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  const signIn = await fetch(`${origin}/api/auth/signin/github`, { method: "POST", redirect: "manual", headers: { Cookie: cookies, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" }, body: new URLSearchParams({ csrfToken, callbackUrl: "/" }) });
  const authorization = new URL((await signIn.json()).url);
  assert.equal(authorization.origin, "https://github.com");
  assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/github`);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("state"));
  assert.ok(!authorization.searchParams.get("scope"), "No repository/email OAuth scopes requested");
  const session = await (await fetch(`${origin}/api/auth/session`, { headers: { Cookie: ownerCookie } })).json();
  assert.equal(session.user.id, "12345");
  assert.ok(!JSON.stringify(session).includes(secret));
  const signOut = await fetch(`${origin}/api/auth/signout`, { method: "POST", redirect: "manual", headers: { Cookie: `${cookies}; ${ownerCookie}`, "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" }, body: new URLSearchParams({ csrfToken, callbackUrl: "/" }) });
  assert.ok(signOut.headers.getSetCookie().some(cookie => cookie.startsWith(`${cookieName}=;`) && cookie.includes("Max-Age=0")), "Logout expires session cookie");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(origin);
      await page.getByRole("button", { name: "Sign in with GitHub" }).waitFor();
      await page.locator(".language-trigger").click();
      await page.getByRole("menuitemradio", { name: "RU · Русский", exact: true }).click();
      await page.getByRole("button", { name: "Войти через GitHub", exact: true }).waitFor();
      await page.locator(".language-trigger").click();
      await page.getByRole("menuitemradio", { name: "EN · English", exact: true }).click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Login fits viewport");
      await context.addCookies([{ name: cookieName, value: ownerCookie.slice(cookieName.length + 1), url: origin, httpOnly: true, sameSite: "Lax" }]);
      await page.reload();
      await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Owner header with language switch fits ${viewport.width}px viewport`);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByRole("button", { name: "Sign in with GitHub" }).waitFor();
      assert.ok(!(await context.cookies()).some(cookie => cookie.name === cookieName), "Browser server action clears owner session");
      await context.close();
    }
  } finally { await browser.close(); }
});

await withServer("invalid-mode", async origin => {
  const page = await (await fetch(origin)).text();
  assert.ok(page.includes("Sign-in is not configured") && !page.includes("Opening your library"));
  assert.equal((await fetch(`${origin}/api/auth/session`)).status, 503);
});

await withServer("local", async origin => {
  const page = await (await fetch(origin)).text();
  assert.ok(page.includes("Opening your library") && !page.includes("Sign in with GitHub"));
  assert.equal((await fetch(`${origin}/api/auth/session`)).status, 404);
});
console.log("Auth checks passed: configuration, owner gate, PKCE/state, session tampering, logout and local mode. OAuth exchange with GitHub needs real App credentials.");

# GitHub sign-in

[Русский](../github-login.md) · [English](github-login.md)

Access to the cloud library is restricted to one GitHub account. GitHub App and environment settings are described in sections 3–7 of the [deployment guide](deployment.md).

## Authentication modes

| Mode | Purpose |
| --- | --- |
| `IDEA_BANK_AUTH_MODE=local` | No account required; library and attachments are stored on disk |
| `IDEA_BANK_AUTH_MODE=github` | Sign-in restricted to `IDEA_BANK_OWNER_ID`; cloud storage also requires B2 settings |

Public websites must use `github`. If its settings are incomplete, the library remains inaccessible.

When no mode is specified, `local` is used. The standard `dev` and `start` commands read environment variables, including `.env.local`; `.env.example` is only a template. Deploying to Vercel does not automatically enable `github`.

Use `npm run dev` to check GitHub sign-in on a computer. `npm run local`, `local:start`, and `runIdeaBank.cmd` force the disk-based local version without sign-in. Its library is transferred to the website through ZIP.

## Sessions and browser data

A session lasts up to 7 days. Signing out ends the session but does not delete that browser's cache, drafts, or pending upload queue. Changing `AUTH_SECRET` invalidates existing sessions.

Sign-in does not encrypt browser data: anyone with access to the same browser profile can access it. Confirmed cloud records are stored in B2; the browser retains cached data and pending changes. These sync automatically while the application is open. When a session expires, uploads pause until sign-in; local changes are retained.

## Agent sign-in through MCP

Optional cloud MCP uses the same GitHub App, a separate `/api/mcp/oauth/callback`, and separate tokens with read or write permissions. Signing in through the browser alone does not grant an agent access. The owner authorizes the connection. Client registration and MCP token validation do not access B2. [Connection and revocation](mcp.md#connecting-a-cloud-library).

## Sign-in errors

| Error | What to check |
| --- | --- |
| “Sign-in is not configured” | Authentication variables and a server restart or Redeploy |
| `AccessDenied` | The account's numeric GitHub `id` in `IDEA_BANK_OWNER_ID` |
| Callback error | Matching domain and `/api/auth/callback/github` in the GitHub App and `AUTH_URL` |
| GitHub App authorization error | Client ID and Client secret from the same App, rather than App ID or PEM |

# Working with Idea Bank

[Русский](AGENTS.md) · [English](AGENTS.en.md)

This is the English translation of the repository's `AGENTS.md`. The Russian file remains the default instruction entry point.

Idea Bank is a personal idea library built with Next.js, React, and TypeScript. The local version (`npm run local`) stores SQLite and attachments in `data` inside the application folder. The cloud version uses GitHub for sign-in, Vercel for the application, and private Backblaze B2 storage for the library and media. Transfer data between versions through ZIP. Each cloud instance has one owner.

## Deploy only when requested

Read the [agent workflow](docs/en/agent-deployment.md), then the [setup guide](docs/en/deployment.md). Perform available actions yourself and involve the owner only when their sign-in, consent, or an unavailable action is required. Do not start deployment during routine code work.

The user's instructions and workspace rules define authorization boundaries. Respect permission already granted; do not ask again for every action within an approved step.

## Code and data

- Check Git status before making changes. Preserve other people's edits and working settings.
- Never print secrets from `.env.local`, hosting settings, or tool responses. Do not place them in code, chat, or reports.
- Never publish the owner's library or attachments. The starter example and documentation screenshots are not private owner data.
- Do not replace the library, select the initial sync source, or resolve conflicts without the owner's decision.
- Public cloud sites require `IDEA_BANK_AUTH_MODE=github`. The `local` mode is for local use.
- `local`, `local:start`, and `runIdeaBank.cmd` force disk mode; `dev` and `start` use environment settings. Do not use local launchers to test GitHub sign-in. `github` without B2 does not confirm cloud library setup. Do not connect the disk data folder to cloud sync: transfers use ZIP at the owner's request.
- Local STDIO and cloud HTTP MCP connections are independent. Implementing MCP does not authorize changing client settings, connecting a library, or signing in without the owner's request. Before manually copying `data`, stop the web server and all local MCP processes using that library.

## Checks

MCP is documented in [docs/en/mcp.md](docs/en/mcp.md). Agent changes go through `LocalAgentBackend` or `CloudAgentBackend`, preserving version checks and replay receipts. Do not connect private libraries to integration tests. Main checks: `test:mcp`, `test:mcp-auth`; after building, `test:mcp-http`. `test:mcp-codex` separately launches a real Codex client using its existing sign-in and consumes its usage allowance. Cloud MCP is disabled without `IDEA_BANK_MCP_ENABLED=true`; application secrets are not passed to the client.

For disk mode, use `test:disk-storage`, `test:local-launch`, `test:disk-api`, and `test:local-migration`. `test:disk-api` and `test:local-migration` require a build and select isolated ports and temporary folders without using the owner's `data`.

Run commands from the root containing `package.json`:

```sh
npm ci
npm run typecheck
npm run build
npm run source:check
```

Run `npm ci` for the first installation, dependency changes, or a Node.js version change affecting the native SQLite driver. Depending on the change, use `test:auth`, `test:storage`, `test:catalog`, `test:reader`, `test:sync`, `test:scoped-sync`, `test:auto-sync`, and `test:sync-events`. `test:sync` checks migration and compatibility; `test:auto-sync` and `test:scoped-sync` check the queue and events. Browser tests use Microsoft Edge. Do not use owner data or occupy a running application's port without agreement.

`test:e2e` contains scenarios for the earlier browser-based local store and requires adaptation for SQLite. It does not replace the disk suites above. Its `PLAYWRIGHT_BASE_URL` selects a server but does not isolate the data folder. Do not run the full suite against the owner's disk library.

After changing reads, writes, caching, or sync, run `npm run test:requests` after building. Preserve the budgets in [docs/en/b2-storage.md](docs/en/b2-storage.md): local navigation and form opening without cloud requests, uploads limited to changes, one batch per event, and one reconciliation after normal reconnection. Do not remove version checks, retries after lost responses, or conflict resolution to reduce requests.

For documentation, check links and commands against the project. Report verified results and unverified areas separately; a successful build alone does not confirm sign-in or sync.

Russian documentation remains the primary version. When changing content, update its English counterpart: `README.en.md`, `AGENTS.en.md`, or the corresponding file in `docs/en/`. Commands, variable names, and technical limits must match in both languages.

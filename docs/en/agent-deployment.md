# Deployment with an AI agent

[Русский](../agent-deployment.md) · [English](agent-deployment.md)

This workflow is for an agent asked to deploy a personal Idea Bank instance. The agent performs available technical work and guides the owner through actions requiring their participation.

Service fields, commands, and variables are defined in the [deployment guide](deployment.md). Use it as the primary settings reference. If a service's interface has changed, consult its official documentation. Do not guess unknown values.

## 1. Establish the starting state

Read workspace rules and `AGENTS.md`. Check `git status`, the repository URL, `package.json`, `.env.example`, and installed dependencies. Do not print `.env.local`.

Use available tools to identify existing resources: fork, Vercel project, sign-in GitHub App, and B2 bucket. A missing account connection does not mean resources do not exist. Ask the owner before creating duplicates.

Briefly state the current step, planned configuration, and required owner participation. Follow the agreed workflow. If permission covers only one step, finish it and agree on the next.

Default to personal Vercel Hobby and B2 without a card, paid add-ons, or domain purchases. Check current free-use terms before creating resources. If a service requires a payment method, stop that step and inform the owner: deployment approval does not authorize spending.

## 2. Choose the available tools

Prefer connected service tools, then an authorized CLI or an available browser. An extra plugin is not required if existing tools can perform the task.

Configure services within the user's authorization. When an action is unavailable, prepare exact field values and give the owner one short step. Verify the result after their response and continue.

Registration, sign-in, two-factor authentication, CAPTCHA, and permission grants remain with the owner when their participation is required. Do not request passwords, verification codes, or access to someone else's account. Do not promise to bypass service restrictions.

For each manual step, provide:

- The page and button.
- Field values and permissions.
- The expected success indicator.
- What to report back without revealing secrets.

Do not present the entire setup as several long lists at once. Do not repeat completed steps.

## 3. Prepare the repository and storage

Follow sections 1 and 2 of the [guide](deployment.md).

Use the owner's fork or existing copy. Do not change Git remotes or push to the developer's original repository. Preserve the working folder and local settings. Install dependencies if needed; check types and build.

Distinguish modes: `npm run local`, `npm run local:start`, and `runIdeaBank.cmd` force SQLite in the application folder; `npm run dev` and `npm start` use environment variables, including `.env.local`, and can check GitHub sign-in. The default mode is `local`; `github` must be set explicitly. Do not start another server on an occupied port. Transfer local and cloud libraries through ZIP using the [instructions](local-migration.md); never move or delete existing data automatically. Do not publish `data` or a custom `IDEA_BANK_DATA_DIR`.

Create or verify a private B2 bucket with encryption and version retention. Restrict the key to that bucket and grant the permissions needed for objects and CORS. Do not use a master key. Do not change retention policies or delete existing objects.

## 4. Configure owner sign-in

Follow sections 3 and 4 of the guide. The owner's GitHub App handles Idea Bank sign-in; Vercel's GitHub integration retrieves source code. Keep these connections separate.

Verify Client ID, Client secret, and the owner's numeric GitHub ID. App ID, username, and `node_id` are not substitutes. Private keys and PEM files are not required for this sign-in flow. Do not request repository access for the sign-in App.

Use `.env.example` only as a template. Extend an existing `.env.local` without overwriting working values. Generate session secrets cryptographically and send them directly to a protected destination without logging or printing them in chat.

If tools cannot transfer secrets securely, ask the owner to fill in `.env.local` or Vercel variables themselves. Obtain confirmation, not the values. Secrets must not appear in command arguments, terminal history, screenshots, Git, or `NEXT_PUBLIC_*` client variables.

## 5. Deploy the application

Follow sections 5–7 of the guide.

Before the first public deployment, set `IDEA_BANK_AUTH_MODE=github` for Production and Preview. Never publish in `local` mode, even temporarily for diagnosis.

Verify the Vercel project owner, repository, production branch, root folder, and Next.js preset. Vercel needs access only to the selected fork. Continue an existing project's setup rather than creating a duplicate.

After the first build, find the permanent production domain in project settings. Use it for `AUTH_URL`, the GitHub App callback, and CORS. An individual deployment URL is not suitable for permanent configuration.

Transfer all variables from the section 7 table to Production and verify their presence without exposing values. Create a separate production `AUTH_SECRET`. Do not automatically copy working secrets into Preview: it must remain inaccessible until configured separately.

Do not transfer `IDEA_BANK_DATA_DIR` to Vercel or run `local`/`local:start` there. Working GitHub sign-in without all valid `B2_*` settings is not a complete cloud instance. Separately verify sync availability and reading from B2.

After changing variables, create a production deployment and wait for Ready. Do not change the owner's other projects or domains.

If the owner chose change notifications, follow the [Ably setup](deployment.md#change-notifications-optional). Use Free without a card, a separate application, and a Publish/Subscribe key restricted to `idea-bank:sync:*`. Store it only in Production as Sensitive `ABLY_API_KEY`, not Preview or public variables. Keep the key out of chat, command arguments, and logs. If secure transfer is unavailable, the owner enters it in Vercel. Ably does not store the library; notifications contain only versions and changed-record IDs. Batches reconcile against the local checkpoint; do not introduce periodic catalog or full-idea reads. B2 fallback checks run every 10 minutes, including without Ably.

## 6. Configure CORS

Follow section 8 of the guide. Use the existing `storage:cors`: without `--apply`, it checks settings; with `--apply`, it adds an origin to the application rule while preserving other rules and private access.

Provide production `AUTH_URL` only for the command. If the process already has that variable, save and restore its value in `finally`; otherwise, remove it afterward. Do not replace the local address in `.env.local` for this operation.

Check again without `--apply`. Do not make the bucket public or allow all origins to work around an error.

## 7. Verify with the owner

Follow sections 9 and 10 of the guide. Report agent checks separately from owner confirmations.

| Check | Expected result |
| --- | --- |
| Production deployment | Ready, correct repository and branch |
| Permanent HTTPS address | Application opens without a connection error |
| No active session | Library is inaccessible; sign-in is available |
| Owner sign-in | Library opens; sign-out and sync are available |
| Access control | `IDEA_BANK_OWNER_ID` matches the owner, mode is `github`, `test:auth` passes |
| B2 and CORS | Bucket is private; the rule allows the exact production origin |
| Initial connection | A clean device retrieved the cloud library automatically; the owner selected a legacy browser source if required |
| Incremental loading | A clean second device received sections and initial cards; scrolling loads more, opening an idea loads blocks; closed ideas are not downloaded in full |
| Cache and offline access | Repeated navigation uses cache without a new request; events and fallback checks load updates in the background. Offline, a viewed idea is marked as a cached copy, and an unavailable idea requires a connection |
| Automatic sync | A saved edit uploaded without pressing Sync and arrived on the first device after returning to it |
| Ably notifications, if configured | Two visible tabs on different devices receive an agreed edit without refocusing or manual checks; the key is not exposed to the browser |
| Upload state | Shows “Saved to cloud” after checking, with no unresolved conflict or sign-in request |

Do not run tests against the working library. Use isolated test data for code checks. Check sign-in by a different GitHub account only with an authorized test account; otherwise, report it as unverified.

Before transferring existing ideas, suggest a ZIP backup. Transfer a disk library only through explicit export and import; the cloud website's browser cache is not its source. A clean cloud device retrieves B2 data automatically; if the cloud library is uninitialized, the application saves the starter Example. The owner chooses a legacy browser source, library replacement, and conflict versions after reviewing the data. Do not upload the starter Example over an existing cloud library. Use an agreed small edit or example to check transfers while preserving owner materials.

For an existing legacy-format cloud library, follow the [upgrade section](b2-storage.md#data-safety-and-legacy-library-upgrades). Save a ZIP and update every device first. Do not activate migration, choose a source, or resolve conflicts for the owner. Older builds cannot write after the upgrade.

Code checks: `typecheck`, `build`, `test:auth`, `test:storage`, `test:catalog`, `test:reader`, `test:sync`, `test:scoped-sync`, `test:sync-events`, `test:auto-sync`, `source:check`. After changing requests, run `test:requests` against a completed build; it checks B2/HTTP budgets, the broker, reconnection, and clearing on isolated data. Disk storage and launch use `test:disk-storage` and `test:local-launch`; after building, run `test:disk-api` and `test:local-migration`. These browser suites choose temporary folders and ports. The old `test:e2e` does not replace them; its restrictions are in `AGENTS.md`. Mark real OAuth, B2, and phone workflows as verified only after observing them.

If the agent cannot access the phone, give the owner the website address and a short check sequence. Do not report deployment as fully verified until unavailable actions are confirmed.

## Optional MCP connection

Connect agent access only at the owner's request, to the library they selected, following the [MCP contract](mcp.md). Implementing MCP does not automatically authorize changing client settings, adding a connection, or signing in. Local and cloud connections are independent; configuring one does not require the other. If cloud MCP was not requested, skip its flag, callback, and checks.

Cloud access requires `IDEA_BANK_MCP_ENABLED=true` and the extra GitHub App callback `/api/mcp/oauth/callback`, preserving the website callback. For local STDIO, provide the full Node.js path, a file URL for the `tsx` loader (`file:///C:/.../node_modules/tsx/dist/loader.mjs`), and the full path to `scripts/mcp-local.mts`. A plain Windows path does not work with `--import`; launching must work from another working directory. Explicitly restrict `--allow-files`. Local MCP does not need a web server; `--app-url` only controls links. Never direct local MCP to the cloud.

Use `list_sections` and `search_ideas` to select IDs, and `get_idea` before editing. After a lost response, keep the same `operation_id`, `version`, and arguments. `CONFLICT` requires another read and review; never blindly retry an old edit with a newer version. An image in chat is not an accessible original: check a path or `download_url`, otherwise prepare an upload page. Do not poll upload status. Respect client approvals; success requires a tool response and verification of saved data.

MCP checks: `test:mcp`, `test:mcp-auth`; after building, `test:mcp-http` and `test:requests`. They use isolated data and do not confirm real cloud sign-in. `test:mcp-codex` separately uses the existing Codex sign-in and usage allowance, temporary data, and configuration limited to that run. A mobile agent is not required to verify agent edits. Check real cloud OAuth/B2 only within the owner's request and report it as verified only after observing the result. Stop all web and MCP processes using a library before manually copying `data`.

## 8. Hand over the result

Report the permanent website address, configured services, completed checks, and remaining actions. Do not include secrets, library contents, or signed B2 links.

Explain upload status and automatic sync while the application is open. State that closed tabs do not sync, pending changes remain only on the device, and offline access is limited to cached ideas and attachments. Clearing site data does not remove cloud records or the disk `data` folder. Export gathers the entire saved library and attachments; import merges it with the archive and asks about differing versions. Confirmed cloud clearing retrieves records and attachment descriptions without downloading originals. Link to [backups](../../README.en.md#backups) and [local library transfers](local-migration.md).

When stopping, leave a short record of completed work and the next step without secrets, so work can resume without repeating setup. For an error, identify the step, safe error text, and a check procedure. If permission or owner action is required, explain the specific reason.

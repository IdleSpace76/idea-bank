# Disk storage in the local version

[Русский](../local-storage.md) · [English](local-storage.md)

In `local` mode, sections, ideas, drafts, and attachments are saved in SQLite and files on disk. Earlier browser data is transferred through ZIP using the [migration guide](local-migration.md); nothing is migrated or deleted automatically. The cloud website uses a [different storage mechanism](b2-storage.md).

## Launching

`npm run local` starts the local server; `npm run local:start` runs a previously built application. `runIdeaBank.cmd` installs missing dependencies and opens the browser. All three force `local` for the process without changing `.env.local`. `dev` and `start` use the configured mode and remain available for checking cloud authentication.

The server binds to `127.0.0.1` and defaults to port 3000. Pass another port with `--port`. The quick launcher reuses only an instance from the same application folder with the same data folder. If another application occupies the port, choose another port or stop that server.

```sh
npm run local -- --port 3001
```

Settings can be provided in `.env.local` or the process environment. `.env.example` is not applied automatically.

| Variable | Purpose |
| --- | --- |
| `IDEA_BANK_AUTH_MODE` | Defaults to `local`; `github` enables owner sign-in and cloud operation when B2 is configured |
| `IDEA_BANK_DATA_DIR` | Optional disk library folder; defaults to `./data` |

The local launcher overrides only the process mode. `IDEA_BANK_DATA_DIR` is still used. Disk mode does not need `AUTH_*`, `B2_*`, or `ABLY_API_KEY`. Vercel disables the disk API; configure a public site with `github` using the [deployment guide](deployment.md).

## Data folder

`readDiskSettings` in `lib/disk-settings.ts` defaults to `data` inside the application folder on all platforms. For an application in `D:\IdeaAppBank`, this is `D:\IdeaAppBank\data`. The folder can move with the application.

The optional `IDEA_BANK_DATA_DIR` accepts a relative path such as `./data` or an absolute path to another folder. Relative paths resolve from the application's working directory (`process.cwd()`). Standard npm and `runIdeaBank.cmd` launches use the application root.

The entire `data` folder, including attachments, is excluded from Git and source archives. Transfer a library using ZIP export or by moving the application folder with `data`. Before manually copying data, stop the web server and local MCP processes using that library. Copy the whole folder, including SQLite's auxiliary files.

Clearing browser data does not delete the disk library. The browser retains interface settings such as language and theme. If you choose a custom `IDEA_BANK_DATA_DIR`, keep it outside published source files.

## Local API and interface

Routes under `app/api/local` work only in `local` mode outside Vercel. They validate the loopback address, `Host`, `Origin`, and `Sec-Fetch-Site` before opening storage. Writes require the application's exact origin in `Origin`. Requests from another website or in `github` mode are rejected.

The JSON part of a write request is limited to 3 MiB. New attachments are sent separately in a multipart request and saved with the record changes.

| Route | Purpose |
| --- | --- |
| `GET /api/local/status` | Launcher instance identity without opening SQLite |
| `GET /api/local/events` | Revision stream for changes from another process, without periodic SQLite polling |
| `GET /api/local/library?state=1` | Revision and initialization state |
| `GET /api/local/catalog` | Cards without blocks, search, pages, and counts |
| `GET /api/local/ideas/:id` | One idea with a consistent library revision |
| `POST /api/local/library` | Changed records and attachments in one operation |
| `GET/HEAD /api/local/media/:id` | Files, including HTTP Range for video and audio |
| `GET /api/local/library` | Complete library for explicit ZIP operations |
| `GET/POST/DELETE /api/local/drafts/:id` | Read, autosave, or discard a draft |
| `GET/POST /api/local/backup` | ZIP snapshot and file protection until reading finishes |
| `POST /api/local/example` | Add the built-in idea if absent |
| `POST /api/local/reset` | Confirmed removal of all ideas, sections, and drafts |

`disk-client.ts` keeps open data in page memory. Forms use loaded cards; editing a title or cover does not require reading blocks. Saving sends only changes, and its response updates counts. Media uses the local file route. Local mode does not call B2, Ably, or the cloud queue.

Writes are protected by the library revision shown to the user. Changes from another window produce a conflict instead of being overwritten. Requests include a stable operation ID; SQLite retains the last 256 replay receipts. If a response is lost, retrying the same content returns the result of the completed operation. A new idea's date and ID are preserved when a form is retried.

The folder contains:

- `library.sqlite` and SQLite auxiliary files: sections, idea cards, blocks, attachment references, and drafts;
- `media/`: immutable attachments named by SHA-256;
- `temporary/`: unfinished attachment writes.

User filenames and IDs are not used as filesystem paths. Identical attachment content is stored as one file. SQLite databases and auxiliary files are excluded from Git and checked during source packaging.

## Agent access to the disk library

`npm run mcp:local` starts a STDIO server for an MCP client. `LocalAgentBackend` uses the same SQLite transactions, versions, and replay receipts as the web application. The agent does not need a running web server. [Connect Codex](mcp.md#connecting-a-local-library).

On an open local page, `/api/local/events` sends a new revision after a filesystem notification. One watcher serves subscribers; SQLite is not polled periodically. A hidden page closes the stream and receives the current revision when shown again. Drafts and conflict checks are preserved.

## Module contract

`DiskLibraryStore` in `lib/disk-library.ts` opens only through an explicit `open` call. Importing the module does not create a database. Cloud `github` mode and Vercel are rejected. A new database is empty; Example creation is separate.

| Method | Purpose |
| --- | --- |
| `readPage` | Cards without blocks, search, sections, and idea counts |
| `readIdea`, `readIdeaSnapshot` | One idea's content; the API gets a consistent library revision |
| `readMedia` | Validated attachment file reference |
| `readSnapshot` | Complete consistent library for ZIP |
| `commit` | Section and idea changes with a version check |
| `readDraft`, `saveDraft`, `removeDraft` | Draft with its own version and attachment references |

Cards and blocks are stored separately: catalog reads do not load block text. `commit` writes the supplied changes without rewriting unchanged ideas. Deleting a section deletes its ideas and blocks. Moving an idea and deleting its previous section can share a transaction.

SQLite uses WAL, foreign keys, and `synchronous=FULL`. The library revision is checked before file preparation and again inside the write transaction. A stale write returns `STALE_WRITE`. The client must offer conflict resolution rather than overwrite the newer version.

Drafts have independent versions. Saving them does not change the library revision. Saving blocks removes the corresponding draft in the same transaction; a newer draft from another window is retained. Deleting an idea or section removes its drafts. Discarding a draft leaves a tombstone version so a delayed autosave cannot restore it. Deleting and recreating an idea changes its lifecycle ID.

Draft restoration retrieves text and attachment references without downloading every file into the browser. Repeated autosaves do not resend existing attachments. Small text requests use `keepalive` on page close; completion is indicated by “Draft saved on this device”.

ZIP includes saved ideas and media, without unfinished drafts. Import merges libraries, retains ideas absent from the archive, and requires a choice for differing versions. When keeping both, the copy receives the suffix `imported`. Identical images within a block keep separate frames even if their bytes share a disk file. The Example button checks the server for the idea and adds built-in files without reading the entire library. Opening a clear-library confirmation does not read idea bodies or media.

## Attachment writes and process interruption

`DiskMediaStore.prepare` in `lib/disk-media.ts` accepts bytes, a `Blob`, or a stream. It writes the full file to the temporary folder, checks the size, computes SHA-256, and flushes it to disk. The file then receives its permanent name. Only afterward does the SQLite transaction save references to it.

A stream error removes its temporary file. After a process crash, SQLite rolls back an unfinished transaction and the previous library remains available. `collectGarbage` removes unused files after delete operations and at startup, considering idea, draft, and active-operation references. Unknown filenames are not deleted.

A temporary reference with the writing process's PID is saved before publishing a new file. Garbage collection checks these references under a SQLite lock, preventing deletion between file publication and metadata commit. References from exited processes are cleared; temporary files belonging to a running process are retained. ZIP protection lasts until released or expired, including across server restarts.

ZIP export and inspection obtain a consistent snapshot and temporarily protect its files against deletion from another window. Protection is released afterward, renewed once a minute only while reading, and expires after 15 minutes without renewal. No constant cleanup polling is performed.

An unknown, damaged, or newer-version database is never replaced with an empty one. The schema version is stored in SQLite. The current schema is `3`; migrations from `1` and `2` preserve the library and add lifecycle versions and attachment protection.

## Checks

```sh
npm run test:disk-storage
npm run test:local-launch
npm run build
npm run test:disk-api
npm run test:local-migration
npm run test:requests
```

Disk checks use separate temporary folders under `.cache`, real SQLite files, and synthetic attachments. They cover persistence after restart, catalog pages, search, concurrent changes, drafts, interrupted streams, and forced exit during a transaction. API and interface checks run on a separate local server in wide and narrow browser windows, including lost responses and a new browser profile. Migration checks cover older browser formats, original data preservation, missing attachments, and ZIP import to disk. `test:requests` separately checks cloud budgets against synthetic B2. The owner's library and real cloud services are not used.

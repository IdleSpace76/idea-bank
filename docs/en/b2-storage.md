# Cloud storage and sync

[Русский](../b2-storage.md) · [English](b2-storage.md)

In cloud mode (`IDEA_BANK_AUTH_MODE=github` with B2 configured), text and media share private Backblaze B2 storage. Storage and CORS setup are described in the [deployment guide](deployment.md). The disk-based [local version](local-storage.md) does not use B2, Ably, or the queue described here. Transfers between versions use [ZIP](local-migration.md).

## Automatic sync

Saving writes changes to IndexedDB together with the upload queue. After 1.2 seconds, background upload starts. Once the cloud version is saved, Ably notifies other devices. Events contain a version and changed-record IDs without text or files. Older events containing only a version ID are also accepted.

A fallback check runs every 10 minutes, including without Ably. A check also runs on opening the application and reconnecting. Ordinary focus changes do not trigger another read if the last check was less than 10 minutes ago. After network recovery, the application waits up to 1.5 seconds for the broker subscription, then performs one batch reconciliation for missed changes. If the broker is unavailable, reconciliation runs after that wait; a later broker connection may require an additional check. Local data remains visible. Temporary storage failures trigger retries with increasing intervals up to 5 minutes.

Creating an idea or section saves locally without a preliminary cloud request. Saving unchanged data does not update the idea's date or make cloud requests. After background upload, confirmed changes update cached cards and counts in the same transaction that clears the queue. A tab's own notifications do not trigger another cloud read.

After deleting an idea, a partially filled saved page remains visible without a request to restore its former card count. More cards load on scrolling; open dialogs pause automatic list loading.

New checks and incoming updates are deferred during editing, import, and export. Sync resumes afterward. Tabs in one browser share a lock to avoid concurrent uploads. Hidden tabs close their subscription and pause periodic checks. Closed tabs do not sync.

[Configuring Ably](deployment.md#change-notifications-optional) does not change storage or conflict resolution. The browser receives a 15-minute subscribe-only token for one channel. The Ably key stays on the server. A notification failure does not cancel a B2 save: the next check detects the missed change.

A new device automatically retrieves sections and the first card page. Clearing site data triggers the same retrieval; cache clearing does not upload deletions. If the cloud library does not exist, the starter Example is saved in B2. An intentionally empty cloud library remains empty.

If a personal library from an older cloud version remains in the browser, the owner selects a source. Saving that library clears the untouched-starter flag. Automatically created Example records alone do not block cloud import; personal changes and pending uploads do. After connection, record versions and previous sync state determine direction. Device clocks do not decide the winning version.

| Changes | Action |
| --- | --- |
| Local only | Upload changed records |
| Cloud only | Update cards and the open idea; check other ideas when opened |
| Independent idea, block, or field edits | Merge |
| Incompatible record edits, deletion versus modification | Owner selects versions |
| Identical data | Check versions without transferring record content |

Status appears in the top bar. For a conflict, open the sync menu, compare record versions, and apply your choices. Sign in again if the session expires. **Sync** starts a manual check.

## Idea loading and local cache

The initial batch retrieves sections, the first 24 cards, and sidebar data. When opening an idea directly by URL, it includes that idea. A saved version stays visible during background checks. Search and scrolling load only missing pages; repeated navigation uses the local cache.

`/api/reader/batch` compares the device checkpoint with the current index. The response includes changed cards, sections, and block records for already loaded ideas. Unchanged blocks and content from closed ideas are not retransmitted. Version comparison also recovers missed broker events. The batch and new checkpoint are saved in one local transaction. A delayed response cannot replace a newer local acknowledgement.

Saving uploads changes for the selected idea or section. The response includes the current version of that scope, including concurrent changes, so no separate read is needed afterward. Section deletion accounts for every idea in that section. Ably notifications update the catalog and open idea without downloading closed ideas' content.

After an upload, its acknowledgement updates the cache without downloading the catalog again. Other tabs wait for the shared write to finish and use its acknowledgement from IndexedDB. If the response is lost or local saving is incomplete, an ordinary request checks the event. Concurrent card, idea, and media-link requests are batched. Files load separately as they become visible, with at most two concurrent downloads; signed links are reused until expiry.

An opened idea includes its records' base versions. Block and property editors reuse a suitable local copy without a request before editing. A section also reuses its saved base when it matches visible data. Draft restoration and explicit conflict review request the current version. Existing idea or section edits are sent directly with base versions, which the server checks before writing. A stale base causes retrieval of current data followed by normal merging and conflict resolution. New attachment hashes are computed locally before the single preliminary version request; missing files upload separately. Existing files are not downloaded again for a text edit.

Repeated update signals are combined. Tabs in one browser share the ten-minute fallback check and a single batch for each broker event, then update their interfaces from the local cache. An event is considered handled only after the server confirms its version and the batch is saved locally. New events do not wait for the fallback interval. A successful batch resets that interval; reconnection and manual sync check immediately. A valid Ably token is reused when returning to a tab until it expires. After a B2 access or quota rejection, automatic requests pause for five minutes; manual sync can retry sooner. Saved data stays visible with a cloud-unavailable indicator, and the queue is retained.

The server uses one index snapshot for an entire batch. The catalog reuses unchanged parts of the last completed version, including after several saves without opening the list. It verifies that the base belongs to the current history; without a suitable base, it rebuilds the catalog. Media-link requests use the completed catalog without reading history. Immutable objects, including version indexes, are cached per server instance: up to 8 MiB of JSON and 256 objects for no longer than five minutes. Concurrent reads are combined; successfully written objects enter the cache immediately. Errors and missing objects are not cached. Checks before new-object writes remain direct; repeated checks for one media file or legacy migration marker are combined within an HTTP request. A new Vercel instance starts with an empty cache.

The IndexedDB card and text cache is limited to 32 MiB, 20 catalog pages, and 20 idea entries, including edit bases. The pending upload queue is stored separately and is not evicted by cache limits. These limits apply to cloud mode. The local disk library uses SQLite and files without a browser cache quota.

Block drafts with available attachments are saved separately from the cache and queue after a one-second typing pause. They are not uploaded or included in saved-library ZIP backups. Restoration requires a user choice; changed blocks are compared first. Saving an idea or explicitly cancelling removes its draft. Clearing site data also removes drafts.

Files load when their previews first enter the visible area, with at most two concurrent downloads per tab. Scrolling does not discard a loaded preview. The server verifies library membership and signs a link without a separate HEAD request to the file. Downloads are checked against SHA-256, MD5, and size. Attachment existence checks before writes are retained. Media-link requests respect the shared pause after a B2 rejection.

The confirmed cloud file cache is limited to 128 MiB. The least recently used copies are removed when full. A file larger than that limit can be viewed without caching it. Pending originals are excluded from eviction and require additional free space.

Offline access is limited to saved pages, ideas, and attachments, marked as offline copies. Evicted data requires a connection to view again. ZIP export deliberately downloads the entire library and missing originals; if a file cannot be retrieved, no complete archive is produced.

Cache limits do not cap total application memory: an open idea, displayed cards, and ZIP operations also consume memory. The server retains a shared version index whose size and catalog construction are limited by JSON size and hosting resources. Incremental loading does not remove these limits.

## Data safety and legacy library upgrades

Media uploads precede publication of references. Record versions and indexes are stored as separate immutable objects. A retry after a lost response reuses the saved operation ID. Received records, the queue, and the sync checkpoint are committed in one local transaction; a stale tab cannot overwrite newer data.

When upgrading an older cloud version, legacy browser data is migrated into IndexedDB. The old localStorage and media database remain unchanged as backups; their size does not count toward the new cache limit. Do not clear site data to perform migration. This is not a disk migration: use the [separate instructions](local-migration.md) for the earlier local version.

For an already synced library, the read catalog is built automatically without transferring every idea's text to the device. After a successful catalog read, the confirmed full local copy and checkpoint are released. A pending queue or unfinished operation prevents this cleanup. The original legacy backup is not imported again. An unuploaded local library first goes through existing source selection and sync.

ZIP export and preview retrieve a complete record snapshot in one request while preserving the current screen and reader mode. They do not create a full local replica. Export uses local files and retrieves missing ones; link requests are combined into small batches. Archive progress is shown in the backup dialog.

**Load Example** creates the prepared idea with an image and 3D model through the regular save queue. An existing Example remains unchanged. If its presence is not known locally, the application checks only for that idea without loading blocks or the entire library.

ZIP merges into current data. Differing idea versions require a choice; matching ones are skipped. With **Keep both**, the archive copy receives `imported` and is recognized on later imports. In cloud mode, ZIP and Example atomically add changes and original attachments to the current queue. Ideas appear immediately and upload in the background without replacing a complete local copy. Confirmed content remains in the bounded idea cache. Pending changes prevent application of a stale plan; other-device changes are checked through cloud versions. Local imports use one transaction that verifies the library has not changed since preview.

Clear confirmation opens without loading data. After confirmation, one request retrieves records and attachment descriptions, then queues deletion of every idea and section. Background upload uses one operation with acknowledgement in its response. Lost responses retry the same operation; conflicting other-device changes require the owner's choice. Original media is not downloaded. A compatible clear path remains available during an unfinished legacy migration.

To upgrade an existing cloud library:

1. Save a ZIP backup and update the application on every device.
2. Open sync and select **Upgrade sync protocol**.
3. If asked for a source library, review the data and choose.
4. Open the updated application on other devices and check that changes arrive.

Migration does not delete older snapshots or media. Older application versions can no longer write afterward. Do not roll back to an old build to continue syncing.

Cloud objects are stored under:

- `idea-bank/v1/sync-v2/records/`: versions of sections, ideas, blocks, and media descriptions;
- `idea-bank/v1/sync-v2/indexes/`: change indexes;
- `idea-bank/v1/sync-v2/catalog-v1/`: derived catalog, card pages, and idea-version references;
- `idea-bank/v1/media/`: original attachments;
- `idea-bank/v1/revisions/`: legacy snapshots.

History and cloud attachments are not cleaned up automatically. Do not enable deletion rules for them. History does not replace a separate [ZIP backup](../../README.en.md#backups).

Signed links last 5 minutes and allow unauthenticated file access until expiry. Do not publish them. B2 keys stay on the server.

## Technical limits

| Data | Limit |
| --- | --- |
| B2 JSON object or JSON request | 3 MiB, excluding media |
| Changes in one upload | 10,000 records |
| New-format history | 100,000 indexes |
| Parents of a merged version | 16 |
| One media file | 1 GiB |
| Cloud file cache | 128 MiB |
| Card and text cache | 32 MiB, up to 20 pages and 20 idea entries |

Large file transfers do not resume from the interruption point. Service limits and available browser storage also affect capacity.

## MCP

The optional Streamable HTTP endpoint `/api/mcp` uses the same record storage and Ably events. It is disabled without `IDEA_BANK_MCP_ENABLED=true` and requires separate agent authorization. Initialization, tool listing, and access checks do not read B2. Search retrieves cards; selected idea content and originals are requested separately. Writes send only changes while preserving retry and conflict protection. Local STDIO does not call this route. [Contract and setup](mcp.md).

## API

The routes below require an owner session. POST and PUT require an `Origin` matching `AUTH_URL`; responses use `private, no-store`. Cloud MCP uses a separate Bearer token under the contract above.

| Request | Purpose |
| --- | --- |
| `GET /api/sync` | Read format state without changing it |
| `POST /api/reader/batch` | Batch cards, viewed-idea changes, and media links against a checkpoint |
| `GET /api/catalog?limit=24&cursor=...&sectionId=...&q=...` | Sections, counts, card page, and continuation cursor |
| `GET /api/ideas/<id>` | One idea; `If-None-Match` permits `304` without a body |
| `GET /api/catalog/media?id=<id>` | Signed attachment link without a complete local checkpoint |
| `POST /api/sync/scoped` | `{target, includeIdeas?, includeMedia?}`: idea/section versions or a library snapshot for ZIP and clearing |
| `PUT /api/sync/scoped` | `{operationId, heads, changes, readBack?}`: changes and confirmed versions in one response |
| `POST /api/sync/events/token` | Owner subscription token or `{enabled:false}` if Ably is not configured |
| `POST /api/sync` | `{known}`: versions and changed records; `{activate: true, known}` permits legacy migration |
| `PUT /api/sync` | `{operationId, heads, changes}`: changes with base record versions |
| `GET /api/sync/media?key=<key>&revision=<uuid>` | Signed attachment link |
| `POST /api/storage/media/upload` | Upload parameters `{id, sha256, md5, size, mime}` |

A stale write base returns `409 STALE_INDEX`; required migration returns `409 MIGRATION_REQUIRED`. After migration, the legacy `PUT /api/storage/library` rejects writes with `409 CLIENT_UPGRADE_REQUIRED`. Older snapshot read routes remain available for migration.

Use the returned method and headers for media uploads. B2 checks `Content-MD5`; SHA-256 is used for addressing and client file validation. The server does not download attachments to recompute SHA-256.

After `npm run build`, `npm run test:requests` checks request budgets using synthetic B2 and isolated browsers:

| Scenario | Checked budget |
| --- | --- |
| Repeated navigation over loaded pages | 0 HTTP requests |
| Opening idea/section creation or delete/clear confirmations | 0 cloud requests |
| Opening idea properties | 0 record requests; the base is prepared on save, and cover preview loads as needed |
| Exporting a text cloud library or previewing ZIP | 1 snapshot request without switching readers; files load separately as needed |
| Adding Example | 0 requests if already known locally; otherwise 1 presence check and regular background creation upload |
| Saving unchanged data | 0 HTTP requests |
| Normal edit with a known base | 1 PUT without a preliminary POST |
| Own save with two open windows | 0 extra read batches |
| Other-device event with two open windows | 1 shared read batch |
| Normal network and Ably recovery | 1 read batch |
| New attachment | 1 preliminary version request, a file upload request, and 1 change PUT |
| Clearing 40 new-format ideas | 1 version request + 1 change PUT, without downloading originals |
| Signing an allowed file link | 0 B2 requests for signing itself |
| Editing text and date of an idea with one block, cold server cache | 8 GET + 2 HEAD without downloading written versions again |

An application HTTP request may perform several B2 operations. The last budget counts only GET and HEAD; history checks, version publication, and original downloads also consume operations. Browser checks include desktop, phone, idle time, reconnection, lost responses, and conflicts. Actual daily usage also depends on device count, library history, and service retries.

Other checks without a working library: `npm run test:catalog`, `npm run test:reader`, `npm run test:sync`, `npm run test:scoped-sync`, `npm run test:auto-sync`, and `npm run test:storage`. Disk checks are listed in the [local reference](local-storage.md#checks). A real B2 check (`npm run test:storage -- --live --browser`) creates temporary objects under `idea-bank-check/<uuid>/` and requires separate agreement. Interrupted runs may leave temporary objects behind.

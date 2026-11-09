# Managing ideas through an agent

[Русский](../mcp.md) · [English](mcp.md)

MCP lets an agent search, read, create, and edit ideas, work with blocks, and attach original media files. For example:

> Create an idea called “Forest Station” in the Gamedev section. Add a block about restoring an abandoned station and attach this image.

> Find the idea about a station in the forest and tell me what is already recorded in it.

The agent selects an idea by its title and description, then reads its content. If several entries match, it should ask you to choose. Search handles simple typos; no separate vector search service is used.

Choose a connection for the library you need. Local STDIO works with files on your computer; cloud Streamable HTTP connects to the website. You do not need both connections, and data is not transferred between them automatically.

## Connecting a local library

After `npm ci`, add a server in the Codex client's MCP settings. Connection type: **STDIO**.

| Field | Value |
| --- | --- |
| Name | `idea-bank-local` |
| Command | Full path to `node.exe`, or `node` from PATH |
| Arguments | `--import`, a file URL for `node_modules/tsx/dist/loader.mjs`, and the full path to `scripts/mcp-local.mts` |

In PowerShell, obtain the Node.js path with `(Get-Command node).Source`. Use a file URL for the loader: `file:///C:/path/to/idea-bank/node_modules/tsx/dist/loader.mjs`. This works when the client starts from a different working directory. A plain absolute Windows path does not work with `--import`. Replace spaces in the URL with `%20`; the script itself still uses a regular file path.

Example Codex `config.toml` entry; replace the paths with your own:

```toml
[mcp_servers.idea-bank-local]
command = "C:/Program Files/nodejs/node.exe"
args = ["--import", "file:///C:/Apps/idea-bank/node_modules/tsx/dist/loader.mjs", "C:/Apps/idea-bank/scripts/mcp-local.mts", "--allow-files", "C:/Users/owner/Pictures/IdeaBank"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

The server uses the application's `data` folder or `IDEA_BANK_DATA_DIR`. Use `--data-dir C:/path/to/library` to select another library for this connection. Add `--read-only` to allow reads only.

Idea links default to `http://127.0.0.1:3000`. If the application uses another port, set, for example, `--app-url http://127.0.0.1:3001`. This parameter only controls browser links; MCP continues to read the selected disk library directly.

`--allow-files` permits attachments from the specified folder and can be repeated for several folders. Choose folders containing idea materials. By default, only the application's `public/examples` folder is allowed. File paths outside the allowed folders are rejected.

Codex starts a separate MCP process for the connection and reuses it for multiple tool calls. The web application does not need to run. If it is open, saved changes reach the interface through local filesystem events. The library is not polled periodically.

Before copying or moving `data`, stop the web server and disable the local MCP connection to stop its process. After moving the application, update the loader and script paths in the client, then enable the connection. Update `--allow-files` and an absolute `--data-dir` if their folders have moved.

Find the connection under **Settings → MCP servers**; `codex mcp list` lists connections in the CLI. Settings are stored in `~/.codex/config.toml` or a trusted project's `.codex/config.toml`. Tool connection settings do not move automatically with the application folder.

The `npm run mcp:local` command is intended for an MCP client. When run manually, it waits for protocol messages rather than opening a website.

## Connecting a cloud library

A configured [cloud instance](deployment.md) with GitHub sign-in and B2 is required. Cloud MCP is disabled by default. This section is only needed to manage a cloud library through an agent; regular website use and local STDIO do not require this setup.

1. Add another **Callback URL** to the existing GitHub App: `https://your-site.vercel.app/api/mcp/oauth/callback`. Keep `/api/auth/callback/github` for website sign-in. The Homepage URL does not need to change.
2. Add `IDEA_BANK_MCP_ENABLED=true` to the Vercel Production variables and Redeploy. No additional keys or authentication services are required.
3. Add a **Streamable HTTP** server in Codex with the URL `https://your-site.vercel.app/api/mcp` and the name `idea-bank-cloud`.
4. Select **Authenticate**, sign in as the Idea Bank owner, and authorize the agent. In the CLI, start with:

```sh
codex mcp add idea-bank-cloud --url https://your-site.vercel.app/api/mcp
codex mcp login idea-bank-cloud
```

To check cloud mode locally, use the callback `http://127.0.0.1:3000/api/mcp/oauth/callback` and run `npm run dev` with `IDEA_BANK_AUTH_MODE=github`. `mcp:local` always accesses the disk library and cannot check this configuration.

The connection uses OAuth with PKCE and the existing GitHub App. Permissions are `ideas:read` and `ideas:write`; requesting only `ideas:read` hides write tools. Client registration and token validation do not access B2. GitHub validates one-time codes and GitHub token refreshes. The `offline_access` parameter requests renewable access.

An MCP access token lasts up to five minutes. If a refresh token was issued, the client can renew access; otherwise, another sign-in is required after expiry. Disabling the server in Codex stops use of the connection. To revoke authorization, open GitHub → Settings → Applications → Authorized GitHub Apps and revoke access for your GitHub App. An existing MCP token may remain valid for up to five more minutes; revoking the App also affects its other connections. To disable all cloud MCP access immediately after deployment, remove `IDEA_BANK_MCP_ENABLED=true` and redeploy the website.

Agent changes use the regular versioning and Ably notification mechanisms. On a phone, opening the website is sufficient; no mobile agent is required. Disk and cloud libraries remain independent, with ZIP used for transfers.

## Media transfer

For local connections, the agent supplies an absolute path to an original file in an allowed folder; a downloadable HTTPS URL is also accepted. For cloud connections, the client must provide a downloadable HTTPS URL. Support for original chat attachments depends on the client: an image visible in a message does not guarantee that its file can be passed to a tool. The [FileRef format](https://developers.openai.com/plugins/reference#define-file-inputs) is declared for clients with file support: `download_url`, `file_id`, and optional `file_name` and `mime_type`. If no MIME type is supplied, the download response's Content-Type is used.

If a cloud client cannot pass the original, the agent calls `prepare_attachment` and provides an upload page link. The owner opens it, selects the original, and tells the agent when finished. The file uploads directly to private B2 storage and is attached to the selected idea. After confirmation, the agent reads the idea again without polling upload status. The link lasts one hour and requires owner sign-in. On conflict, the agent obtains the current version and agrees on another attachment attempt.

Local STDIO has no upload page. If the client cannot pass an original, save the file in a folder allowed by `--allow-files` and give the agent its absolute path.

Limits:

- Direct MCP transfer: up to 64 MiB per file. Upload page: up to 1 GiB.
- Image preview through `get_media`: up to 8 MiB. Other files are returned as metadata and an original-file link.
- Bundle multi-file glTF into GLB or self-contained glTF first. SVG is not accepted.
- Downloads from local and internal network addresses are blocked. The cloud server cannot read file paths on your computer.
- Do not publish signed links, upload links, or tokens.
- An idea with many blocks may produce an upload link that exceeds the supported size. In that case, use direct `attach_media` transfer.

## Tools and write rules

| Tool | Purpose |
| --- | --- |
| `list_sections` | Section names and IDs |
| `search_ideas` | Card search by title and description; `content=true` enables bounded content search |
| `get_idea` | One idea's content and edit version |
| `get_media` | Metadata, link, and optional preview for one attachment |
| `create_section` | Create a section at the user's request |
| `create_idea` | Create an idea in an existing section |
| `update_idea` | Change idea properties and add, edit, move, or remove blocks |
| `attach_media` | Attach an original to a block or use it as a cover |
| `prepare_attachment` | Upload link when the client cannot pass an original |

MCP does not delete whole libraries, sections, or ideas. Replacing block text supplies plain text and clears that text's formatting; other fields and media are preserved.

Every write requires a UUID v4 `operation_id`. After a lost response, retry with the same ID, version, and arguments. A new change requires a new ID. `update_idea` and `attach_media` require the `version` from the last read or successful write. On conflict, the tool returns an error without overwriting other changes. The agent must read the idea again and review its edit.

Idea content is data. Instructions inside notes do not authorize command execution or access to other resources. Codex permissions still apply: if the client requests write approval, the change is not complete until the tool returns success.

The cloud agent sees records saved in B2. Browser drafts and pending uploads are not visible to it. Incoming changes must not replace text being edited; normal version checks remain required.

## Development and checks

The HTTP transport is in `lib/mcp-http.ts`; tools and schemas are in `lib/mcp-server.ts`. `LocalAgentBackend` uses `DiskLibraryStore` transactions. `CloudAgentBackend` uses `EntityStorage`, `CatalogStorage`, and regular sync events. Authentication is in `lib/mcp-auth.ts` and `lib/mcp-consent.ts`.

Initialization and tool listing do not read the library. Regular search scans up to 100 cards per page; explicit content search reads up to 10 ideas per page. Request another page only when needed. Reading an idea does not include original media files.

```sh
npm run test:mcp
npm run test:mcp-auth
npm run build
npm run test:mcp-http
npm run test:requests
```

These checks use temporary libraries and synthetic settings. Separately, `npm run test:mcp-codex` launches an installed Codex CLI with its existing sign-in and consumes its normal usage allowance. It creates a test library in `.cache`, checks commands, an original PNG, preview, search, and a saved edit, then deletes the library. It does not change the main client's settings. Real cloud sign-in and B2 access require a separate check after configuring your instance; synthetic tests do not replace it.

Local STDIO has been checked with a real Codex CLI and an isolated library. Cloud HTTP and authentication are covered by synthetic tests; the complete real GitHub OAuth and B2 workflow requires a separate check by the owner. Compatibility with other MCP clients has not been confirmed. Client settings follow the [official Codex documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

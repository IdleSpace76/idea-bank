# A personal Idea Bank on Vercel and Backblaze B2

[Русский](../deployment.md) · [English](deployment.md)

Set up a personal website with GitHub sign-in and sync through Backblaze B2. Only the owner's account can access it.

## Prerequisites

- Personal accounts on [GitHub](https://github.com), [Vercel](https://vercel.com), and [Backblaze B2](https://www.backblaze.com/sign-up/cloud-storage).
- Node.js LTS, Git, and a local repository copy with dependencies installed.

Choose Vercel Hobby for personal, non-commercial use. To avoid charges, do not add a payment card. Before signing up, check the current free allowances and terms for [Vercel](https://vercel.com/docs/plans/hobby) and [B2](https://www.backblaze.com/cloud-storage/pricing).

## 1. Copy the repository

Select **Fork** on the [repository page](https://github.com/IdleSpace76/idea-bank). Open **Code** in your own fork and copy its HTTPS URL.

```sh
git clone https://github.com/YOUR_GITHUB_LOGIN/idea-bank.git
cd idea-bank
npm ci
```

Replace `YOUR_GITHUB_LOGIN` with your username.

For use without cloud services, run `npm run local`: data is stored in the application folder. Transfers to the website use ZIP as described in the [migration guide](local-migration.md). The remaining steps configure the cloud version.

## 2. Private B2 storage

In Backblaze, open **B2 Cloud Storage → Buckets → Create a Bucket**.

| Field | Selection |
| --- | --- |
| Bucket Name | A unique name such as `idea-bank-yourname` (replace `yourname`) |
| Files in Bucket / Bucket Type | **Private** |
| Default Encryption | **Enable** |
| Object Lock | **Disable** |

Save the **Bucket Name** and **S3 Endpoint**. For example, `s3.eu-central-003.backblazeb2.com` has the region `eu-central-003` and the full endpoint `https://s3.eu-central-003.backblazeb2.com`.

Keep file version retention enabled. Do not configure automatic deletion of library snapshots or media.

### Storage access key

Open **Application Keys → Add a New Application Key**:

- **Name of Key:** for example, `idea-bank-app`.
- **Allow access to Bucket(s):** only the bucket you created.
- **Type of Access:** **Read and Write**.
- **Allow List All Bucket Names:** leave disabled; the application does not need to list other buckets.
- **File name prefix** and **Duration:** leave empty.

Select **Create New Key**. Save **keyID** and **applicationKey** for `B2_KEY_ID` and `B2_APPLICATION_KEY`. The secret is shown only when created; do not use the master key.

The key also needs `readBuckets` and `writeBuckets` to configure CORS. [Application key permissions](https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys).

## 3. GitHub App for authentication

Create a GitHub App for Idea Bank sign-in. Vercel's repository connection is configured separately in step 5.

Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**. [Direct link](https://github.com/settings/apps/new).

| Field | Value |
| --- | --- |
| GitHub App name | A unique name: `idea-bank-yourname` (replace `yourname`) |
| Homepage URL | `http://127.0.0.1:3000`; replace with the website address after deployment |
| Callback URL / Redirect URI | `http://127.0.0.1:3000/api/auth/callback/github` |
| Webhook → Active | Disable |
| Permissions | Keep GitHub's required defaults |
| Where can this GitHub App be installed? | **Only on this account** |

Do not enable Device Flow, Setup URL, or extra permissions.

Create the application, save its **Client ID**, and generate a **Client secret** with **Generate a new client secret**. App ID and a PEM file are not needed.

Open `https://api.github.com/users/YOUR_GITHUB_LOGIN`. Use the **id** field for `IDEA_BANK_OWNER_ID`, rather than `node_id` or the username.

[GitHub App registration reference](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

## 4. Cloud-mode settings on your computer

If `.env.local` does not exist yet, create it from the template in the repository root.

This step lets you check cloud settings from your computer. A separate disk library needs neither `.env.local` nor accounts: `npm run local` is sufficient.

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

macOS / Linux:

```sh
cp .env.example .env.local
```

Generate a random session secret:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Fill in `.env.local`, replacing the placeholders:

```dotenv
IDEA_BANK_AUTH_MODE=github
AUTH_URL=http://127.0.0.1:3000
AUTH_SECRET=RANDOM_SESSION_SECRET
AUTH_GITHUB_ID=GITHUB_APP_CLIENT_ID
AUTH_GITHUB_SECRET=GITHUB_APP_CLIENT_SECRET
IDEA_BANK_OWNER_ID=YOUR_NUMERIC_GITHUB_ID
B2_S3_ENDPOINT=https://s3.YOUR_REGION.backblazeb2.com
B2_REGION=YOUR_REGION
B2_BUCKET_NAME=YOUR_PRIVATE_BUCKET_NAME
B2_KEY_ID=YOUR_B2_KEY_ID
B2_APPLICATION_KEY=YOUR_B2_APPLICATION_KEY
```

Use the command's output for `AUTH_SECRET` and the GitHub secret for `AUTH_GITHUB_SECRET`. Keep keys only in `.env.local` and server-side Vercel variables, without the `NEXT_PUBLIC_` prefix. Do not publish them.

To check sign-in, run `npm run dev`, open `http://127.0.0.1:3000`, and sign in through GitHub. `local` and `local:start` cannot check this setup because they force disk mode without sign-in. Do not substitute `localhost` for `127.0.0.1`: the address must match the callback.

## 5. Import the fork into Vercel

In Vercel, select **Create New → Project** or **Import Project** and connect GitHub. If **Install Vercel** appears, choose **Only select repositories** and select only your `idea-bank` fork.

Check the import form:

| Setting | Value |
| --- | --- |
| Team / Plan | Personal workspace, **Hobby** |
| Repository | Your fork |
| Production Branch | `main`, unless you changed the branch name |
| Root Directory | `./` |
| Framework / Application Preset | **Next.js** |
| Build / Install / Output | Standard Next.js settings |

Before **Create Project / Deploy**, open **Environment Variables** and add:

```dotenv
IDEA_BANK_AUTH_MODE=github
```

Set this for Production and Preview. Add the other values after obtaining the permanent domain. Do not publish a personal instance in `local` mode: it has no owner authentication.

Deploy and wait for **Ready**. “Sign-in is not configured” is expected at this point; the remaining variables are added in step 7.

Find the main production domain under **Settings → Domains**, for example:

```text
https://YOUR-SITE.vercel.app
```

Use the project's permanent domain rather than an individual build's temporary address.

[Importing GitHub projects into Vercel](https://vercel.com/docs/git/vercel-for-github).

## 6. Connect the GitHub App to the website

Return to your GitHub App settings:

1. Set **Homepage URL** to `https://YOUR-SITE.vercel.app`.
2. Use **Add redirect URI / Add callback URL** to add:

   ```text
   https://YOUR-SITE.vercel.app/api/auth/callback/github
   ```

3. Save the changes.

You can keep the local callback for checking cloud mode with `npm run dev`. Disk launches through `runIdeaBank.cmd` or `npm run local` do not need a callback.

## 7. Vercel server variables

Open the Vercel project → **Settings → Environment Variables**. Add these variables for **Production**:

| Variable | Value |
| --- | --- |
| `IDEA_BANK_AUTH_MODE` | Already set to `github` |
| `AUTH_URL` | `https://YOUR-SITE.vercel.app`, without a path or trailing `/` |
| `AUTH_SECRET` | A new random secret generated with the same Node.js command |
| `AUTH_GITHUB_ID` | Your GitHub App's Client ID |
| `AUTH_GITHUB_SECRET` | That App's Client secret |
| `IDEA_BANK_OWNER_ID` | Your GitHub account's numeric ID |
| `B2_S3_ENDPOINT` | S3 Endpoint with `https://` |
| `B2_REGION` | Region from that endpoint |
| `B2_BUCKET_NAME` | Private bucket name |
| `B2_KEY_ID` | That bucket key's keyID |
| `B2_APPLICATION_KEY` | applicationKey |
| `ABLY_API_KEY` | Optional notification key; see below |
| `IDEA_BANK_MCP_ENABLED` | Optional: `true` for cloud agent access; disabled by default |

For secrets, select **Sensitive / Secret** if available.

`IDEA_BANK_DATA_DIR` is not needed in Vercel: it uses B2 and disables the disk API. `github` enables owner authentication; successful sign-in alone does not confirm B2 setup.

Use a separate production `AUTH_SECRET`. Do not add secrets to Preview without configuring its domain, callback, and CORS; leave only `github` mode enabled there.

[How Vercel applies environment variables](https://vercel.com/docs/environment-variables).

### Change notifications (optional)

Ably sends notifications between open devices. Text and media remain in B2. Without Ably, sync checks for updates every 10 minutes.

1. Create an [Ably](https://ably.com/sign-up) account on **Free**. No card is required; do not enable a paid plan. [Current terms](https://ably.com/docs/platform/pricing/free).
2. Create an `idea-bank` application in the dashboard. Open **API Keys** and create an `idea-bank-sync` key.
3. Allow only **Publish** and **Subscribe** on `idea-bank:sync:*`. Message history, Presence, and other resources are not needed.
4. Copy the full `appId.keyId:secret` key into the Vercel project's `ABLY_API_KEY`, for **Production** only, as **Sensitive**. To check cloud mode through `npm run dev`, you can also add it to `.env.local`.
5. Redeploy and refresh the pages on your devices.

Do not place the key in Git, client code, or a variable prefixed with `NEXT_PUBLIC_`. The browser receives a temporary subscribe-only token for its library's channel.

With a working subscription, updates arrive as events and are fetched in batches against the device checkpoint. Repeated navigation uses the local cache. A fallback check runs every 10 minutes, including when notifications are unavailable. Hidden tabs pause their subscription and periodic checks.

## 8. Configure CORS for media uploads

CORS allows the browser to transfer media between your website and B2.

Open a terminal in the local application folder. The script reads B2 keys from `.env.local`; supply the production address only for this command.

PowerShell:

```powershell
$ideaBankPreviousUrl = $env:AUTH_URL
try {
  $env:AUTH_URL = "https://YOUR-SITE.vercel.app"
  npm run storage:cors -- --apply
} finally {
  if ($null -eq $ideaBankPreviousUrl) { Remove-Item Env:AUTH_URL -ErrorAction SilentlyContinue }
  else { $env:AUTH_URL = $ideaBankPreviousUrl }
}
```

macOS / Linux:

```sh
AUTH_URL=https://YOUR-SITE.vercel.app npm run storage:cors -- --apply
```

The script adds the website origin while preserving other rules and private access. Without `--apply`, it only checks settings.

To check cloud mode through `npm run dev`, repeat the command without the temporary variable. Another port or `localhost` needs a separate rule. The disk version does not need B2 CORS.

## 9. Apply settings and check sign-in

In Vercel, open **Deployments**, then the latest production deployment's menu → **Redeploy**. Editing variables does not update an existing deployment automatically.

Wait for **Ready**, open the main website address, and sign in through GitHub. The library and sync controls should become available. Change the interface language using the globe menu.

## 10. Transfer the library and check a phone

If your ideas are in the disk-based local version, export a ZIP there and import it on the published website using the [transfer instructions](local-migration.md#transfers-between-local-and-cloud-versions). Save edited ideas before export. There is no automatic connection to the `data` folder.

On the cloud website, open the sync menu in the top bar and wait for **Saved to cloud**. If upgrading an earlier browser library and asked to select a source, review the data and select the desired version. An older cloud format has a separate [upgrade procedure](b2-storage.md#data-safety-and-legacy-library-upgrades).

On the phone:

1. Open the same main HTTPS address. Your computer's `127.0.0.1` address does not work here.
2. Sign in with the same GitHub account.
3. Wait for sections and the first cards. More cards load as you scroll; idea content loads when opened. A clean device retrieves B2 data automatically. If personal data from an older browser version remains, review it and save a ZIP before choosing a source.
4. Check the text and open a few attachments; they load when viewed. Make and save a small edit. Wait for **Saved to cloud**, return to the computer, and confirm that the edit arrived without pressing Sync.

Further changes sync automatically; conflicts require selecting versions of individual records. Clearing site data does not delete B2 records. Changing the website address does not transfer browser cache or pending changes.

In an open tab, disconnect the network and open a previously viewed idea: it should be marked as an offline copy. An idea without a local copy requires a connection. After reconnection, versions are checked again.

## Agent access (optional)

To connect Codex to the cloud library, enable `IDEA_BANK_MCP_ENABLED=true`, add `/api/mcp/oauth/callback` to the existing GitHub App, and connect the client's `/api/mcp` URL. Keep the website sign-in callback. [MCP setup and permissions](mcp.md#connecting-a-cloud-library).

If the agent uses only the local library, skip this step: it uses a separate [STDIO connection](mcp.md#connecting-a-local-library). The cloud website continues working without MCP.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `Missing script: local` or `Missing script: dev` | Open the terminal in the folder containing `package.json`. |
| Vercel build ends with Error | Open Build Logs. Check Root Directory `./`, the Next.js preset, and a Node.js version compatible with `package.json`. |
| “Sign-in is not configured” after setting variables | Were they added to **Production** in the correct project? Was **Redeploy** run afterward? |
| Sign-in works but sync shows “On this device” | Check all `B2_*` variables and Redeploy. Sign-in and storage are configured separately. |
| GitHub rejects the callback | Check the exact production domain and path, and Client ID and Client secret from the same GitHub App. |
| `AccessDenied` | `IDEA_BANK_OWNER_ID` must contain the owner's `id`, rather than username or `node_id`. |
| Text works but media does not load | Check the production origin in CORS, key permissions, and B2 fields. Repeat CORS setup for the exact address. |
| CORS script fails | Check that the key belongs to the correct bucket, has `readBuckets`/`writeBuckets`, `.env.local` is filled in, and B2 is reachable. |
| The phone shows an empty library | Check the address, account, initial source choice if applicable, and upload status on the first device. |
| Changes wait for upload | Finish editing or importing. After a network error, wait for retry; after session expiry, sign in again. |
| Updates arrive only on returning to the application or after a delay | Check Production `ABLY_API_KEY`, redeployment, Publish/Subscribe on `idea-bank:sync:*`, and device access to Ably. Tabs must be visible; unfinished drafts defer incoming updates. |
| A conflict exists | Open the sync menu, compare record versions, and apply your choices. |
| Ideas disappeared after clearing browser data | Sign in and retrieve the cloud copy, or restore a ZIP. Clearing site data removes cache, drafts, and pending changes, but does not affect the disk `data` folder. |
| `ERR_CONNECTION_CLOSED`, website does not open | Try another network or mobile data. If the address works only through a proxy, configure access to that domain on the device; do not disable HTTPS verification. |

To report an error, provide a description, the step, and the error text without secrets. Do not attach `.env.local`, keys, private library ZIPs, or temporary signed attachment URLs.

Reference: [GitHub sign-in](github-login.md), [storage and sync](b2-storage.md).

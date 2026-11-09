# Moving a library to the local version

[Русский](../local-migration.md) · [English](local-migration.md)

The local version saves data in the application's `data` folder. The earlier browser library and the cloud website remain separate sources. Transfers use ZIP files.

## If the earlier local version is still running

1. Save any ideas being edited. Unfinished drafts are not included in ZIP backups.
2. Select **Export ZIP** in the backup dialog and save the archive.
3. Stop the application and update the source code.
4. Run `npm ci`, then `npm run local`. On Windows, you can open `runIdeaBank.cmd`.
5. Open backups, select **Import ZIP**, and confirm the import.

## If the application has already been updated

Open it in the same browser at the same address used by the earlier version. The backup dialog will offer **Export old browser library**. Save the ZIP, then import it with the regular **Import ZIP** button.

Export reads saved ideas and attachments without changing the old library. Drafts remain in the old store. If an attachment is missing, export reports it and stops.

Browser data belongs to a specific origin. `http://127.0.0.1:3000` and `http://localhost:3000`, as well as different ports, have separate stores. The standard launcher uses `http://127.0.0.1:3000`. If you previously used a different port, run `npm run local -- --port 3001` with that port number. If browser data has already been deleted, you will need an earlier ZIP backup or a cloud copy.

## Transfers between local and cloud versions

Export a ZIP from the source version and import it into the destination. Before exporting from the cloud website, wait for sync to finish. The local version does not connect to B2 or automatically upload data to the website.

Create a cloud library ZIP on the website itself. The old browser library export button is for the earlier local store; a partial cloud website cache does not replace a complete archive.

Import merges libraries. Ideas absent from the ZIP remain in place; matching ideas are skipped. For differing versions, choose the current version, the archive version, or both. When keeping both, the imported copy receives the suffix `imported`.

For a complete replacement, first save a backup, then confirm **Clear your head** and import the desired ZIP. Clearing removes every idea and section, including Example.

## Moving the application folder

Stop the web server and disable local MCP connections using the library, then move the entire application folder together with `data`. With default settings, the new data location is selected automatically. An absolute `IDEA_BANK_DATA_DIR` keeps data at the specified path. On another computer or after changing Node.js versions, run `npm ci` to install a compatible SQLite driver.

MCP settings are stored separately in the client. After moving the application, update the absolute loader and script paths; update `--allow-files` and `--data-dir` if needed. [Connection parameters](mcp.md#connecting-a-local-library).

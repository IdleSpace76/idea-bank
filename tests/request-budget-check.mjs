// Synthetic B2 and isolated browser profiles only. Run after npm run build.
for(const name of ["storage-read-cache-check","storage-request-budget-check","reader-batch-check","optimistic-sync-check","shared-reader-check","scoped-controller-check","sync-events-client-check","scoped-sync-check","lazy-reader-check","migration-check"]) {
  await import(`./${name}.mjs`);
}
console.log("Request budget suite passed: cold/warm storage, navigation, no-op and real saves, attachments, own/foreign broker events, shared tabs, offline recovery and idle request counts.");

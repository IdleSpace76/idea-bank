// Exercise the current controller rather than the retired full-replica UI.
await import("./cloud-access-check.mjs");
await import("./storage-api-check.mjs");
await import("./scoped-controller-check.mjs");
await import("./optimistic-sync-check.mjs");
await import("./scoped-creation-check.mjs");
await import("./reader-batch-check.mjs");
await import("./sync-events-check.mjs");
await import("./sync-events-client-check.mjs");
await import("./scoped-sync-check.mjs");

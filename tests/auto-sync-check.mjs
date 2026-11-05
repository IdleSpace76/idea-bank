// Exercise the current controller rather than the retired full-replica UI.
await import("./sync-events-check.mjs");
await import("./sync-events-client-check.mjs");
await import("./scoped-sync-check.mjs");

import type { Realtime } from "ably";

type Callbacks = { onRevision: (revision: string,keys?:string[]) => void; onConnection: (ready: boolean) => void };
type Credentials = { enabled: true; channel: string; token: string; expiresAt: number };

/** Owns one optional subscription. Notifications are hints; storage remains authoritative. */
export class SyncEventsClient {
  private client: Realtime | null = null;
  private stopped = true;
  private generation = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private connecting = false;
  private ready = false;
  private disabledUntil = 0;
  constructor(private callbacks: Callbacks) {}
  private setReady(ready: boolean) {
    if (this.ready === ready) return;
    this.ready = ready; this.callbacks.onConnection(ready);
  }
  private active(generation: number) { return !this.stopped && generation === this.generation; }
  private async credentials(): Promise<Credentials | null> {
    const request = new AbortController(); this.request = request;
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const response = await fetch("/api/sync/events/token", { method: "POST", credentials: "same-origin", cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Sync notifications unavailable");
      const value = await response.json();
      if (value?.enabled === false) return null;
      if (value?.enabled !== true || typeof value.channel !== "string" || !/^idea-bank:sync:[a-f0-9]{64}$/.test(value.channel) || typeof value.token !== "string" || !value.token || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) throw new Error("Invalid notification credentials");
      return value;
    } finally { clearTimeout(timeout); if (this.request === request) this.request = null; }
  }
  private scheduleRetry(delay = 60000) {
    if (this.stopped || document.visibilityState === "hidden" || navigator.onLine === false) return;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, delay);
  }
  private async connect() {
    if (this.stopped || this.connecting || this.client || document.visibilityState === "hidden" || navigator.onLine === false) return;
    if (Date.now() < this.disabledUntil) { this.scheduleRetry(this.disabledUntil - Date.now()); return; }
    const generation = this.generation; this.connecting = true;
    try {
      const initial = await this.credentials();
      if (!this.active(generation)) return;
      if (!initial) { this.disabledUntil = Date.now() + 300000; this.scheduleRetry(300000); return; }
      const { Realtime } = await import("ably");
      if (!this.active(generation)) return;
      let first: Credentials | null = initial;
      const client = new Realtime({ autoConnect: false, logLevel: 0, authCallback: (_params, callback) => {
        void (async () => {
          const credentials = first || await this.credentials(); first = null;
          if (!this.active(generation) || !credentials || credentials.channel !== initial.channel) throw new Error("Sync notifications unavailable");
          callback(null, credentials.token);
        })().catch(() => callback("Sync notifications unavailable", null));
      } });
      this.client = client;
      const channel = client.channels.get(initial.channel);
      const update = () => {
        if (!this.active(generation)) return;
        this.setReady(client.connection.state === "connected" && channel.state === "attached");
        if (client.connection.state === "failed" || channel.state === "failed") {
          this.suspend(); this.scheduleRetry();
        }
      };
      client.connection.on(update); channel.on(update);
      void channel.subscribe("library-changed", message => {
        if (!this.active(generation)) return;
        const data = message.data;
        if ((data?.version === 1 || data?.version===2 && Array.isArray(data.keys) && data.keys.length<=128 && data.keys.every((key:unknown)=>typeof key==="string" && key.length<=500)) && typeof data.revision === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.revision)) this.callbacks.onRevision(data.revision,data.version===2?data.keys:undefined);
      }).catch(() => { if (this.active(generation)) { this.suspend(); this.scheduleRetry(); } });
      client.connect();
    } catch { if (this.active(generation)) { this.setReady(false); this.scheduleRetry(); } }
    finally { if (this.active(generation)) this.connecting = false; }
  }
  private suspend = () => {
    this.generation++; this.connecting = false;
    this.request?.abort(); this.request = null;
    if (this.retry !== null) clearTimeout(this.retry); this.retry = null;
    const client = this.client; this.client = null;
    this.setReady(false); client?.close();
  };
  private wake = () => {
    if (document.visibilityState === "hidden" || navigator.onLine === false) this.suspend();
    else void this.connect();
  };
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("online", this.wake); window.addEventListener("offline", this.wake);
    this.wake();
  }
  stop() {
    this.stopped = true; this.suspend();
    document.removeEventListener("visibilitychange", this.wake);
    window.removeEventListener("online", this.wake); window.removeEventListener("offline", this.wake);
  }
}

import { request, transaction } from "./local-database";

type Lease = { owner: string; expires: number };
const leaseKey = "sync-lease", lockName = "idea-bank.sync", leaseMs = 180000;
/** Let an in-flight local writer commit its acknowledgement before handling its broker echo. */
export async function waitForSyncIdle() {
  if(typeof navigator.locks?.request==="function") {
    await navigator.locks.request(lockName,{mode:"exclusive"},()=>{});return;
  }
  let delay=100;
  for(;;) {
    const lease=await transaction(["meta"],"readonly",async tx=>request<Lease|undefined>(tx.objectStore("meta").get(leaseKey)));
    const now=Date.now();
    if(!lease || lease.expires<=now || lease.expires>now+leaseMs)return;
    await new Promise(resolve=>setTimeout(resolve,delay));delay=Math.min(delay*2,1000);
  }
}
/** Prefer browser-managed locks; use a transactional, expiring lease where Web Locks are absent. */
export async function withSyncLock(work: (valid: () => boolean) => Promise<void>): Promise<boolean> {
  if (typeof navigator.locks?.request === "function") {
    return navigator.locks.request(lockName,{mode:"exclusive",ifAvailable:true},async lock => {
      if (!lock) return false;
      await work(() => true); return true;
    });
  }
  const owner=crypto.randomUUID();
  const acquired=await transaction(["meta"],"readwrite",async tx => {
    const store=tx.objectStore("meta"), current=await request<Lease|undefined>(store.get(leaseKey));
    if (current && current.expires>Date.now()) return false;
    store.put({owner,expires:Date.now()+leaseMs},leaseKey); return true;
  });
  if (!acquired) return false;
  let valid=true, renewing=false, expires=Date.now()+leaseMs;
  const heartbeat=setInterval(() => {
    if(renewing)return; renewing=true;
    void transaction(["meta"],"readwrite",async tx => {
      const store=tx.objectStore("meta"),current=await request<Lease|undefined>(store.get(leaseKey));
      if(current?.owner!==owner){valid=false;return;}
      const next=Date.now()+leaseMs;store.put({owner,expires:next},leaseKey);return next;
    }).then(next=>{if(next)expires=next;}).catch(()=>{valid=false;}).finally(()=>{renewing=false;});
  },10000);
  try { await work(()=>valid&&Date.now()<expires); return true; }
  finally {
    clearInterval(heartbeat); valid=false;
    await transaction(["meta"],"readwrite",async tx => {
      const store=tx.objectStore("meta"),current=await request<Lease|undefined>(store.get(leaseKey));
      if(current?.owner===owner)store.delete(leaseKey);
    }).catch(()=>{});
  }
}

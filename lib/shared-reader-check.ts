import { transaction, request } from "./local-database";
import { waitForSyncIdle } from "./sync-lock";

export const READER_CHECK_INTERVAL = 600000;
const channelName="idea-bank.reader.verified",sender=crypto.randomUUID();
const stampKey=(scope:string)=>`reader-verified:${scope}`;
const recent=(stamp:unknown,now:number)=>typeof stamp==="number" && stamp<=now && now-stamp<READER_CHECK_INTERVAL;

/** A successful whole-reader packet, including a broker refresh, satisfies the safety check. */
export async function noteReaderCheck(scope:string) {
  await transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),now=Date.now(),last=await request<number|undefined>(meta.get(stampKey(scope)));
    if(last!==undefined && last<=now && now-last<1000)return false;
    meta.put(now,stampKey(scope));return true;
  });
  try{const channel=new BroadcastChannel(channelName);channel.postMessage({scope,sender});channel.close();}catch{/* Shared storage still coordinates the next safety check. */}
}
export function subscribeReaderChecks(listener:(scope:string)=>void) {
  try{const channel=new BroadcastChannel(channelName);channel.onmessage=event=>{if(event.data?.sender!==sender && typeof event.data?.scope==="string")listener(event.data.scope);};return()=>channel.close();}
  catch{return()=>{};}
}
/** Only safety/focus checks are deduplicated. Explicit refreshes and broker events stay immediate. */
export async function runSharedReaderCheck(scope:string,work:()=>Promise<void>) {
  const fresh=()=>transaction(["meta"],"readonly",async tx=>recent(await request(tx.objectStore("meta").get(stampKey(scope))),Date.now()));
  if(typeof navigator.locks?.request==="function") {
    await navigator.locks.request(`${channelName}:${scope}`,{mode:"exclusive"},async()=>{if(!await fresh())await work();});
    return;
  }
  const owner=crypto.randomUUID(),key=`reader-check-lease:${scope}`;
  const acquired=await transaction(["meta"],"readwrite",async tx=>{
    const meta=tx.objectStore("meta"),now=Date.now();
    if(recent(await request(meta.get(stampKey(scope))),now))return false;
    const lease=await request<{owner:string;expires:number}|undefined>(meta.get(key));
    if(lease && lease.expires>now && lease.expires<=now+240000)return false;
    meta.put({owner,expires:now+240000},key);return true;
  });
  if(!acquired)return;
  try{await work();}
  finally{await transaction(["meta"],"readwrite",async tx=>{const meta=tx.objectStore("meta");if((await request<{owner:string}|undefined>(meta.get(key)))?.owner===owner)meta.delete(key);});}
}

/** Part of the same transaction as the locally applied packet or committed write. */
export async function rememberReaderEventsIn(tx:IDBTransaction,scope:string,revisions:string[]) {
  const meta=tx.objectStore("meta"),key=`reader-events:${scope}`,seen=await request<string[]|undefined>(meta.get(key)) || [];
  meta.put([...new Set([...seen,...revisions])].slice(-512),key);
}
/** Events bypass the interval. Only server-confirmed, locally applied revisions are deduplicated. */
export async function runSharedReaderEvents(scope:string,revisions:string[],work:()=>Promise<string[]>) {
  const ids=[...new Set(revisions)].slice(0,512),eventsKey=`reader-events:${scope}`;
  const completed=()=>transaction(["meta"],"readonly",async tx=>{
    const seen=await request<string[]|undefined>(tx.objectStore("meta").get(eventsKey)) || [];
    return ids.every(id=>seen.includes(id));
  });
  const perform=async()=>{
    if(await completed())return;
    await waitForSyncIdle();
    if(await completed())return;
    const observed=await work();
    const confirmed=ids.filter(id=>observed.includes(id));
    if(!confirmed.length)return;
    await transaction(["meta"],"readwrite",tx=>rememberReaderEventsIn(tx,scope,confirmed));
  };
  if(typeof navigator.locks?.request==="function") {
    await navigator.locks.request(`${channelName}:${scope}`,{mode:"exclusive"},perform);return;
  }
  const key=`reader-check-lease:${scope}`,owner=crypto.randomUUID();
  let delay=100;
  for(;;) {
    if(await completed())return;
    const acquired=await transaction(["meta"],"readwrite",async tx=>{
      const meta=tx.objectStore("meta"),now=Date.now(),lease=await request<{expires:number}|undefined>(meta.get(key));
      if(lease && lease.expires>now && lease.expires<=now+240000)return false;
      meta.put({owner,expires:now+240000},key);return true;
    });
    if(!acquired){await new Promise(resolve=>setTimeout(resolve,delay));delay=Math.min(1000,delay*2);continue;}
    try{await perform();return;}
    finally{await transaction(["meta"],"readwrite",async tx=>{const meta=tx.objectStore("meta");if((await request<{owner:string}|undefined>(meta.get(key)))?.owner===owner)meta.delete(key);});}
  }
}

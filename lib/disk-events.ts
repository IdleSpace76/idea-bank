import {watch,type FSWatcher} from "node:fs";
import type {DiskLibraryStore} from "./disk-library";
import {localEndpoint,localDiskStore} from "./disk-api";

type Hub={watcher:FSWatcher;listeners:Set<(revision:number)=>void>;timer?:ReturnType<typeof setTimeout>;revision:number};
const hubs=new WeakMap<DiskLibraryStore,Hub>();
/** Filesystem notifications cover writes from the standalone MCP process, without polling SQLite. */
function subscribe(db:DiskLibraryStore,listener:(revision:number)=>void){
  let hub=hubs.get(db);
  if(!hub){
    const listeners=new Set<(revision:number)=>void>();
    const watcher=watch(db.settings.root,(_event,name)=>{
      if(!name || !/^library\.sqlite(?:-wal|-shm)?$/.test(String(name)) || hub!.timer)return;
      hub!.timer=setTimeout(()=>{hub!.timer=undefined;try{const revision=db.readState().revision;if(revision>hub!.revision){hub!.revision=revision;for(const callback of listeners)callback(revision);}}catch{}},150);
    });
    hub={watcher,listeners,revision:db.readState().revision};hubs.set(db,hub);
  }
  hub.listeners.add(listener);listener(db.readState().revision);
  return ()=>{hub!.listeners.delete(listener);if(!hub!.listeners.size){hub!.watcher.close();if(hub!.timer)clearTimeout(hub!.timer);hubs.delete(db);}};
}
export function diskEvents(request:Request){return localEndpoint(request,false,async()=>{
  const db=await localDiskStore(),encoder=new TextEncoder();let cleanup=()=>{};
  const stream=new ReadableStream<Uint8Array>({start(controller){
    let closed=false;const stop=subscribe(db,revision=>{if(!closed)controller.enqueue(encoder.encode(`data: ${JSON.stringify({revision})}\n\n`));});
    const heartbeat=setInterval(()=>{if(!closed)controller.enqueue(encoder.encode(": keepalive\n\n"));},30000);
    cleanup=()=>{if(closed)return;closed=true;stop();clearInterval(heartbeat);request.signal.removeEventListener("abort",cleanup);try{controller.close();}catch{}};
    request.signal.addEventListener("abort",cleanup,{once:true});if(request.signal.aborted)cleanup();
  },cancel(){cleanup();}});
  return new Response(stream,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-store","X-Accel-Buffering":"no","X-Content-Type-Options":"nosniff"}});
});}

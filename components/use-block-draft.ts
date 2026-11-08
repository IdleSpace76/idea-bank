"use client";
import { useEffect,useRef,useState } from "react";
import { readBlockDraft,writeBlockDraft,removeBlockDraft,type BlockDraft } from "@/lib/block-drafts";
import type { Project } from "@/lib/ideas";

type Session={scope:string;base:Project;revision:string|null;stopped:boolean};
/** Serialize local autosaves so an older write cannot replace a newer edit or undo cancellation. */
export function useBlockDraft(scope:string,id:string|undefined,project:Project|null,files:ReadonlyMap<string,Blob>,dirty:boolean,paused:boolean) {
  const [recovery,setRecovery]=useState<BlockDraft>();
  const [status,setStatus]=useState<""|"waiting"|"saved">("");
  const [error,setError]=useState("");
  const session=useRef<Session|null>(null),queue=useRef<Promise<unknown>>(Promise.resolve());
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null),generation=useRef(0);
  const latest=useRef({project,files,dirty,paused});latest.current={project,files,dirty,paused};
  function cancelTimer(){if(timer.current)clearTimeout(timer.current);timer.current=null;}
  async function discover(){if(!id)return;try{setRecovery(await readBlockDraft(scope,id));}catch(e){setError((e as Error).message);}}
  useEffect(()=>{
    let cancelled=false;const current=++generation.current;
    cancelTimer();session.current=null;setRecovery(undefined);setStatus("");setError("");
    if(id)void readBlockDraft(scope,id).then(value=>{if(!cancelled&&current===generation.current)setRecovery(value);}).catch(e=>{if(!cancelled)setError((e as Error).message);});
    return()=>{cancelled=true;cancelTimer();};
  },[scope,id]);
  async function start(base:Project,restore?:BlockDraft):Promise<boolean> {
    await queue.current.catch(()=>{});
    const saved=await readBlockDraft(scope,base.id);
    if(saved && !restore){setRecovery(saved);return false;}
    if(restore && saved?.revision!==restore.revision)throw new Error("Черновик изменён в другой вкладке. Сохранённая копия не перезаписана.");
    session.current={scope,base:structuredClone(base),revision:saved?.revision || null,stopped:false};
    setRecovery(undefined);setStatus("");setError("");return true;
  }
  function flush(){
    cancelTimer();const active=session.current,snapshot=latest.current,current=generation.current;
    if(!active || active.stopped || !snapshot.project || !snapshot.dirty || snapshot.paused)return;
    const project=structuredClone(snapshot.project),files=new Map(snapshot.files);
    queue.current=queue.current.catch(()=>{}).then(async()=>{
      if(active.stopped)return;
      try{
        const saved=await writeBlockDraft(active.scope,active.base,project,files,active.revision);active.revision=saved.revision;
        if(current===generation.current){if(latest.current.project===snapshot.project && latest.current.files===snapshot.files)setStatus("saved");setError("");}
      }catch(e){if(current===generation.current){setStatus("");setError((e as Error).message);}}
    });
  }
  useEffect(()=>{
    cancelTimer();
    if(project && dirty && !paused && session.current){setStatus("waiting");timer.current=setTimeout(flush,1000);}
    return cancelTimer;
  },[project,files,dirty,paused]);
  useEffect(()=>{
    const hidden=()=>{if(document.visibilityState==="hidden")flush();};
    const leaving=()=>flush();document.addEventListener("visibilitychange",hidden);window.addEventListener("pagehide",leaving);window.addEventListener("beforeunload",leaving);
    return()=>{document.removeEventListener("visibilitychange",hidden);window.removeEventListener("pagehide",leaving);window.removeEventListener("beforeunload",leaving);};
  },[]);
  async function clear(){
    cancelTimer();const active=session.current;
    if(active)active.stopped=true;
    await queue.current.catch(()=>{});
    if(active)await removeBlockDraft(active.scope,active.base.id,active.revision);
    session.current=null;setRecovery(undefined);setStatus("");setError("");
  }
  async function discard(){if(recovery){await removeBlockDraft(scope,recovery.id,recovery.revision);setRecovery(undefined);}}
  async function checkpoint(){cancelTimer();await queue.current.catch(()=>{});const active=session.current;return active?{id:active.base.id,revision:active.revision}:undefined;}
  return {recovery,status,error,start,clear,discard,discover,checkpoint};
}

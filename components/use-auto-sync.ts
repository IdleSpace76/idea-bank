"use client";
import { useEffect,useMemo,useRef,useSyncExternalStore } from "react";
import { SyncController,initialSyncView } from "@/lib/sync-controller";
import type { Library } from "@/lib/ideas";
const noop=()=>()=>{};
const empty=()=>initialSyncView;
export function useAutoSync(scope:string|undefined,ready:boolean,canRun:()=>boolean,onApplied:(library:Library)=>void,blocked:boolean){
  const options=useRef({canRun,onApplied});options.current={canRun,onApplied};
  const controller=useMemo(()=>scope?new SyncController(scope,{canRun:()=>options.current.canRun(),onApplied:library=>options.current.onApplied(library)}):null,[scope]);
  const view=useSyncExternalStore(controller?.subscribe||noop,controller?.getSnapshot||empty,empty);
  useEffect(()=>{if(!ready||!controller)return;controller.start();return()=>controller.stop();},[controller,ready]);
  useEffect(()=>{controller?.contextChanged();},[controller,blocked]);
  return {controller,view};
}

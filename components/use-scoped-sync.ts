"use client";
import { useEffect,useMemo,useRef,useSyncExternalStore } from "react";
import { ScopedSyncController } from "@/lib/scoped-controller";
import { initialSyncView } from "@/lib/sync-controller";
const noop=()=>()=>{},empty=()=>initialSyncView;
export function useScopedSync(scope:string|undefined,enabled:boolean,canRun:()=>boolean,refresh:(localOnly?:boolean,safety?:boolean,revisions?:string[])=>void,blocked:boolean){
  const options=useRef({canRun,refresh});options.current={canRun,refresh};
  const controller=useMemo(()=>scope?new ScopedSyncController(scope,{canRun:()=>options.current.canRun(),refresh:(localOnly,safety,revisions)=>options.current.refresh(localOnly,safety,revisions)}):null,[scope]);
  const view=useSyncExternalStore(controller?.subscribe || noop,controller?.getSnapshot || empty,empty);
  useEffect(()=>{if(!enabled || !controller)return;controller.start();return()=>controller.stop();},[enabled,controller]);
  useEffect(()=>{controller?.contextChanged();},[controller,blocked]);
  return {controller,view};
}

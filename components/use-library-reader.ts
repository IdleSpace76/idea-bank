"use client";
import { useCallback, useEffect, useMemo, useRef, useState,useSyncExternalStore } from "react";
import { loadReaderIdea, loadReaderPage,syncReader,readerActivity,subscribeReaderActivity, ReaderError, type ReaderPage } from "@/lib/library-reader";
import { subscribeLocalChanges } from "@/lib/library-store";
import { subscribeScoped,scopedBatchActive } from "@/lib/scoped-store";
import { subscribeReaderChecks } from "@/lib/shared-reader-check";
import type { SyncTarget,ScopedRead } from "@/lib/scoped-types";
import type { IdeaSummary, Library, Project, Route, Section } from "@/lib/ideas";

type List = { items: IdeaSummary[]; page: ReaderPage | null; loading: boolean; error: string; cachePending?:boolean; cloudError?:string; conflict?:SyncTarget;auth?:boolean;migration?:boolean;source?:string;localVersion?:number;localOnly?:boolean };
const emptyList: List = {items:[],page:null,loading:false,error:""};
const reason = (error: unknown) => error instanceof Error ? error.message : "Не удалось загрузить данные. Повторите попытку.";
const projects = (ideas: IdeaSummary[]): Project[] => ideas.map(idea => ({...idea,blocks:[]}));

/** Keep only visible card metadata and the open document in React state. */
export function useLibraryReader(scope: string | undefined, enabled: boolean, route: Route, query: string, sidebarQuery: string, locked: boolean) {
  const networkLoading=useSyncExternalStore(subscribeReaderActivity,useCallback(()=>readerActivity(scope),[scope]),()=>0)>0;
  const [main,setMain] = useState<List>(emptyList), [search,setSearch] = useState<List>(emptyList);
  const [sidebar,setSidebar] = useState<Record<string,List>>({});
  const [detail,setDetail] = useState<{id:string;idea?:Project;editBase?:ScopedRead;loading:boolean;offline:boolean;error:string;cloudError?:string;conflict?:SyncTarget;auth?:boolean}>({id:"",loading:false,offline:false,error:""});
  const detailRef=useRef(detail);detailRef.current=detail;
  const detailScope=useRef(scope);
  const showLocalIdea=useCallback((idea:Project)=>{
    detailScope.current=scope;
    setDetail({id:idea.id,idea,loading:false,offline:navigator.onLine===false,error:""});
  },[scope]);
  const [refreshState,setRefreshState] = useState({id:0,localOnly:false}), [online,setOnline] = useState(true);
  const refreshId=refreshState.id,refreshRequest=useRef<Promise<void>|null>(null);
  const refreshSafety=useRef(false),urgentRefresh=useRef(false);
  const queuedRevisions=useRef(new Set<string>());
  const invalidating=useRef<Promise<unknown>>(Promise.resolve());
  const lastMainRefresh=useRef<{scope?:string;id:number}>({id:-1}),lastDetailRefresh=useRef<{scope?:string;id:number}>({id:-1});
  const state = useRef({main,sidebar,search,locked}); state.current = {main,sidebar,search,locked};
  const refreshTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const lastWake=useRef(Date.now());
  const scheduleRefresh = useCallback(() => {
    if(refreshTimer.current!==null)return;
    refreshTimer.current=setTimeout(()=>{refreshTimer.current=null;setRefreshState(value=>({id:value.id+1,localOnly:true}));},200);
  },[]);
  const refresh:(safety?:boolean,revisions?:string[])=>void=useCallback((safety=false,revisions)=>{
    if(refreshRequest.current && revisions?.length)for(const id of revisions)queuedRevisions.current.add(id);
    while(queuedRevisions.current.size>512)queuedRevisions.current.delete(queuedRevisions.current.values().next().value!);
    if(refreshRequest.current && refreshSafety.current && !safety && !revisions?.length)urgentRefresh.current=true;
    if(scope && !refreshRequest.current) {
      refreshSafety.current=safety || !!revisions?.length;
      const pending=syncReader(scope,safety,revisions).catch(error=>{setMain(previous=>({...previous,error:reason(error),cloudError:error instanceof ReaderError && error.code==="UNAVAILABLE"?error.message:undefined,conflict:error instanceof ReaderError?error.target:undefined}));}).finally(()=>{if(refreshRequest.current===pending){refreshRequest.current=null;const queued=[...queuedRevisions.current];queuedRevisions.current.clear();if(urgentRefresh.current){urgentRefresh.current=false;refresh();}else if(queued.length)refresh(false,queued);}});
      refreshRequest.current=pending;invalidating.current=pending;
    }
    scheduleRefresh();
  },[scope,scheduleRefresh]);
  const refreshLocal=useCallback(()=>scheduleRefresh(),[scheduleRefresh]);
  useEffect(()=>()=>{if(refreshTimer.current!==null){clearTimeout(refreshTimer.current);refreshTimer.current=null;}refreshRequest.current=null;urgentRefresh.current=false;queuedRevisions.current.clear();},[scope]);
  const sectionId = route.screen === "section" ? route.id : undefined;
  const ideaId = route.screen === "project" ? route.id : undefined;
  const mainKey = JSON.stringify([scope,sectionId,query]), lastKey = useRef("");
  const generation = useRef(0), moreBusy = useRef(false);
  const sideGeneration=useRef(0), searchGeneration=useRef(0);
  const lastSearchKey=useRef("");
  const sidebarVersion=useRef("");
  const localVersion=useRef(0);
  const navigation=useRef<{scope:string|undefined;sections:Section[];counts:Record<string,number>}>({scope,sections:[],counts:{}});

  useEffect(() => {
    const wake = () => {
      setOnline(navigator.onLine !== false);
      if(document.visibilityState==="hidden" || navigator.onLine===false || Date.now()-lastWake.current<600000)return;
      lastWake.current=Date.now();refresh(true);
    };
    const reconnect=()=>{setOnline(navigator.onLine!==false);lastWake.current=Date.now();refresh();};
    const visible=()=>{if(document.visibilityState==="visible")wake();};
    setOnline(navigator.onLine !== false);
    window.addEventListener("online",reconnect); window.addEventListener("offline",wake); window.addEventListener("focus",wake);
    document.addEventListener("visibilitychange",visible);
    const localChange=(external=false)=>{localVersion.current++;if(!state.current.locked && (!scope || external || !scopedBatchActive(scope)))scheduleRefresh();};
    const stop = subscribeLocalChanges(()=>localChange());
    const stopScoped=subscribeScoped((value,external)=>{if(value===scope)localChange(external);});
    const stopVerified=scope?subscribeReaderChecks(value=>{if(value===scope)scheduleRefresh();}):()=>{};
    return () => {stop();stopScoped();stopVerified();window.removeEventListener("online",reconnect);window.removeEventListener("offline",wake);window.removeEventListener("focus",wake);document.removeEventListener("visibilitychange",visible);};
  },[refresh,scheduleRefresh,scope]);

  useEffect(() => {
    const current=++generation.current;
    if (!enabled || locked) return;
    const localSnapshotVersion=localVersion.current;
    let cancelled = false;
    moreBusy.current = false;
    const sameKey=lastKey.current===mainKey;
    const force=!refreshState.localOnly && (lastMainRefresh.current.scope!==scope || lastMainRefresh.current.id!==refreshId);
    lastMainRefresh.current={scope,id:refreshId};
    const target = sameKey ? Math.max(24,state.current.main.items.length) : 24;
    lastKey.current = mainKey;
    setMain(previous => ({...previous,loading:true,cachePending:!!scope,error:"",...(!sameKey ? {items:[],page:null} : {})}));
    const timer = setTimeout(() => { void (async () => {
      try {
        const localOnly=refreshState.localOnly && sameKey;
        await invalidating.current;
        if(cancelled)return;
        let page = await loadReaderPage(scope,{sectionId,query},{localOnly,force,onCached:cached=>{
          if(cancelled)return;
          setMain(previous=>cached?{...previous,page:cached,source:scope,items:sameKey && previous.page?.revision===cached.revision && previous.items.length>cached.ideas.length?previous.items:cached.ideas,cachePending:false,loading:true,error:cached.cloudError || ""}:{...previous,cachePending:false});
        }}), items = [...page.ideas];
        while (!cancelled && page.nextCursor && items.length < target) {
          try{page = await loadReaderPage(scope,{sectionId,query,cursor:page.nextCursor},localOnly);items.push(...page.ideas);}catch(error){if(localOnly && error instanceof ReaderError && error.code==="CACHE_MISS")break;throw error;}
        }
        if (!cancelled) {navigation.current={scope,sections:page.sections,counts:page.counts};setMain({items,page,source:scope,localVersion:localSnapshotVersion,localOnly,loading:false,error:page.cloudError || ""});}
      } catch (error) {
        if (!cancelled && current === generation.current) setMain(previous => ({...previous,loading:false,cachePending:false,error:reason(error),cloudError:error instanceof ReaderError && error.code==="UNAVAILABLE"?error.message:undefined,migration:error instanceof ReaderError && error.code==="MIGRATION_REQUIRED",auth:error instanceof ReaderError && error.code==="UNAUTHORIZED",conflict:error instanceof ReaderError?error.target:undefined,page:previous.page && error instanceof ReaderError && error.code==="OFFLINE" ? {...previous.page,offline:true} : previous.page}));
      }
    })(); },query ? 200 : 0);
    return () => {cancelled = true;clearTimeout(timer);};
  },[scope,enabled,sectionId,query,refreshId,locked,mainKey]);

  useEffect(() => {
    if (!enabled || locked) return;
    const force=!refreshState.localOnly && (lastDetailRefresh.current.scope!==scope || lastDetailRefresh.current.id!==refreshId);
    lastDetailRefresh.current={scope,id:refreshId};
    if (!ideaId) {setDetail({id:"",loading:false,offline:false,error:""});return;}
    let cancelled = false;
    const inMemory=detailScope.current===scope && detailRef.current.id===ideaId ? detailRef.current.idea : undefined;
    const editBase=inMemory?detailRef.current.editBase:undefined;
    detailScope.current=scope;
    setDetail({id:ideaId,idea:inMemory,editBase,loading:true,offline:navigator.onLine===false,error:""});
    void invalidating.current.then(()=>{if(cancelled)return;return loadReaderIdea(scope,ideaId,cached=>{if(!cancelled && !inMemory)setDetail({id:ideaId,idea:cached.idea,editBase:cached.editBase,loading:true,offline:cached.offline,error:""});},refreshState.localOnly && !!inMemory,force);})
      .then(result => {if(!cancelled && result)setDetail({id:ideaId,idea:result.idea,editBase:result.editBase,loading:false,offline:result.offline,cloudError:result.cloudError,error:""});})
      .catch(error => {if(!cancelled) {
        if(inMemory && error instanceof ReaderError && ["OFFLINE","UNAVAILABLE"].includes(error.code))setDetail({id:ideaId,idea:inMemory,editBase,loading:false,offline:error.code==="OFFLINE" || navigator.onLine===false,cloudError:error.code==="UNAVAILABLE"?error.message:undefined,error:""});
        else setDetail({id:ideaId,loading:false,offline:false,error:reason(error),cloudError:error instanceof ReaderError && error.code==="UNAVAILABLE"?error.message:undefined,auth:error instanceof ReaderError && error.code==="UNAUTHORIZED",conflict:error instanceof ReaderError?error.target:undefined});
      }});
    return () => {cancelled=true;};
  },[scope,enabled,ideaId,refreshId,locked]);

  const sectionKey = main.page?.sections.map(section => section.id).join("\n") || "";
  useEffect(() => {
    if(main.source!==scope){++sideGeneration.current;return;}
    if (!enabled || locked || main.loading || !main.page) return;
    const version=JSON.stringify([scope,main.page.revision,sectionKey,main.localVersion]);
    if(sidebarVersion.current===version && !Object.values(state.current.sidebar).some(list=>list.error))return;
    ++sideGeneration.current;
    let cancelled = false;
    const sections = main.page.sections;
    const catalog=main.page;
    void (async () => {
      const next: Record<string,List> = {};
      for (let start=0;start<sections.length && !cancelled;start+=4) await Promise.all(sections.slice(start,start+4).map(async section => {
        try {
          const target=state.current.sidebar[section.id]?.items.length || 4;
          const loaded=state.current.main.items.filter(idea=>idea.sectionId===section.id),count=catalog.counts[section.id] || 0;
          // A complete set already received in the main list needs no separate sidebar request.
          if(!catalog.offline && !catalog.cloudError && loaded.length===count && count<=target) {
            next[section.id]={items:loaded,page:{...catalog,ideas:loaded,total:count,nextCursor:null},source:scope,loading:false,error:""};return;
          }
          let page=await loadReaderPage(scope,{sectionId:section.id,limit:4},!!main.localOnly),items=[...page.ideas];
          while(!cancelled && page.nextCursor && items.length<target){try{page=await loadReaderPage(scope,{sectionId:section.id,cursor:page.nextCursor},!!main.localOnly);items.push(...page.ideas);}catch(error){if(main.localOnly && error instanceof ReaderError && error.code==="CACHE_MISS")break;throw error;}}
          next[section.id]={items,page,source:scope,loading:false,error:page.cloudError || ""};
        }
        catch(error){const before=state.current.sidebar[section.id];next[section.id]={...(before?.source===scope?before:emptyList),loading:false,error:reason(error)};}
      }));
      if(!cancelled){sidebarVersion.current=version;setSidebar(next);}
    })();
    return () => {cancelled=true;};
  },[scope,enabled,sectionKey,main.page,main.loading,main.source,main.localVersion,locked]);

  useEffect(() => {
    ++searchGeneration.current;
    if (!enabled || locked || !sidebarQuery.trim()) {if(!sidebarQuery.trim()){lastSearchKey.current="";setSearch(emptyList);}return;}
    const key=JSON.stringify([scope,sidebarQuery]),localOnly=refreshState.localOnly && lastSearchKey.current===key;lastSearchKey.current=key;
    let cancelled=false;setSearch({...emptyList,loading:true});
    const timer=setTimeout(()=>{void loadReaderPage(scope,{query:sidebarQuery},localOnly).then(page=>{if(!cancelled)setSearch({items:page.ideas,page,loading:false,error:""});}).catch(error=>{if(!cancelled)setSearch({...emptyList,error:reason(error)});});},200);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[scope,enabled,sidebarQuery,refreshId,locked]);

  async function loadMore() {
    const before=state.current.main, cursor=before.page?.nextCursor, current=generation.current;
    if(!cursor || before.loading || moreBusy.current || state.current.locked)return;
    moreBusy.current=true;setMain(previous=>({...previous,loading:true}));
    try {
      const page=await loadReaderPage(scope,{sectionId,query,cursor});
      if(current===generation.current)setMain(previous=>({items:[...previous.items,...page.ideas],page,source:scope,localVersion:before.localVersion,loading:false,error:""}));
    } catch(error) {
      if(current===generation.current) {
        if(error instanceof ReaderError && error.code==="STALE_CATALOG")refresh();
        else setMain(previous=>({...previous,loading:false,error:reason(error)}));
      }
    } finally {moreBusy.current=false;}
  }
  async function expandSection(id: string) {
    const before=state.current.sidebar[id];
    if(!before?.page?.nextCursor || before.loading)return;
    const current=sideGeneration.current;
    setSidebar(previous=>({...previous,[id]:{...before,loading:true}}));
    try {const page=await loadReaderPage(scope,{sectionId:id,cursor:before.page.nextCursor});if(current===sideGeneration.current)setSidebar(previous=>({...previous,[id]:{items:[...before.items,...page.ideas],page,source:scope,loading:false,error:""}}));}
    catch(error){if(current===sideGeneration.current)setSidebar(previous=>({...previous,[id]:{...before,error:reason(error)}}));}
  }
  async function moreSearch() {
    const before=state.current.search;
    if(!before.page?.nextCursor || before.loading)return;
    const current=searchGeneration.current;
    setSearch(previous=>({...previous,loading:true}));
    try{const page=await loadReaderPage(scope,{query:sidebarQuery,cursor:before.page.nextCursor});if(current===searchGeneration.current)setSearch({items:[...before.items,...page.ideas],page,loading:false,error:""});}
    catch(error){if(current===searchGeneration.current)setSearch({...before,error:reason(error)});}
  }
  const library = useMemo<Library>(() => {
    const ideas = new Map<string,Project>();
    for(const item of projects([...main.items,...Object.values(sidebar).flatMap(list=>list.items),...search.items]))ideas.set(item.id,item);
    if(detail.id===ideaId && detail.idea)ideas.set(detail.id,detail.idea);
    return {version:1,sections:main.page?.sections || (navigation.current.scope===scope?navigation.current.sections:[]),projects:[...ideas.values()]};
  },[main,sidebar,search,detail,ideaId,scope]);
  const counts=main.page?.counts || (navigation.current.scope===scope?navigation.current.counts:{});
  const cloudError=main.cloudError || main.page?.cloudError || (detail.id===ideaId?detail.cloudError:undefined);
  return {library,main,sidebar,search,counts,detail:detail.id===ideaId?detail:null,cloudError,networkLoading,migrationRequired:main.migration,authRequired:main.auth || detail.id===ideaId && detail.auth,online,offline:!!scope && (!online || !!main.page?.offline || !!(ideaId && detail.offline)),refresh,refreshLocal,showLocalIdea,loadMore,expandSection,moreSearch};
}

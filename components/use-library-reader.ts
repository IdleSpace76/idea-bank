"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadReaderIdea, loadReaderPage, ReaderError, type ReaderPage } from "@/lib/library-reader";
import { subscribeLocalChanges } from "@/lib/library-store";
import { subscribeScoped } from "@/lib/scoped-store";
import type { SyncTarget } from "@/lib/scoped-types";
import type { IdeaSummary, Library, Project, Route, Section } from "@/lib/ideas";

type List = { items: IdeaSummary[]; page: ReaderPage | null; loading: boolean; error: string; conflict?:SyncTarget;auth?:boolean;migration?:boolean;source?:string };
const emptyList: List = {items:[],page:null,loading:false,error:""};
const reason = (error: unknown) => error instanceof Error ? error.message : "Не удалось загрузить данные. Повторите попытку.";
const projects = (ideas: IdeaSummary[]): Project[] => ideas.map(idea => ({...idea,blocks:[]}));

/** Keep only visible card metadata and the open document in React state. */
export function useLibraryReader(scope: string | undefined, enabled: boolean, route: Route, query: string, sidebarQuery: string, locked: boolean) {
  const [main,setMain] = useState<List>(emptyList), [search,setSearch] = useState<List>(emptyList);
  const [sidebar,setSidebar] = useState<Record<string,List>>({});
  const [detail,setDetail] = useState<{id:string;idea?:Project;loading:boolean;offline:boolean;error:string;conflict?:SyncTarget;auth?:boolean}>({id:"",loading:false,offline:false,error:""});
  const detailRef=useRef(detail);detailRef.current=detail;
  const detailScope=useRef(scope);
  const [refreshId,setRefreshId] = useState(0), [online,setOnline] = useState(true);
  const state = useRef({main,sidebar,search,locked}); state.current = {main,sidebar,search,locked};
  const refresh = useCallback(() => setRefreshId(value => value + 1),[]);
  const sectionId = route.screen === "section" ? route.id : undefined;
  const ideaId = route.screen === "project" ? route.id : undefined;
  const mainKey = JSON.stringify([scope,sectionId,query]), lastKey = useRef("");
  const generation = useRef(0), moreBusy = useRef(false);
  const sideGeneration=useRef(0), searchGeneration=useRef(0);
  const navigation=useRef<{scope:string|undefined;sections:Section[];counts:Record<string,number>}>({scope,sections:[],counts:{}});

  useEffect(() => {
    const wake = () => {setOnline(navigator.onLine !== false);refresh();};
    const visible=()=>{if(document.visibilityState==="visible")wake();};
    setOnline(navigator.onLine !== false);
    window.addEventListener("online",wake); window.addEventListener("offline",wake); window.addEventListener("focus",wake);
    document.addEventListener("visibilitychange",visible);
    const stop = subscribeLocalChanges(() => { if (!state.current.locked) refresh(); });
    const stopScoped=subscribeScoped(value=>{if(value===scope && !state.current.locked)refresh();});
    return () => {stop();stopScoped();window.removeEventListener("online",wake);window.removeEventListener("offline",wake);window.removeEventListener("focus",wake);document.removeEventListener("visibilitychange",visible);};
  },[refresh,scope]);

  useEffect(() => {
    const current=++generation.current;
    if (!enabled || locked) return;
    let cancelled = false;
    moreBusy.current = false;
    const sameKey=lastKey.current===mainKey;
    const target = sameKey ? Math.max(24,state.current.main.items.length) : 24;
    lastKey.current = mainKey;
    setMain(previous => ({...previous,loading:true,error:"",...(!sameKey ? {items:[],page:null} : {})}));
    const timer = setTimeout(() => { void (async () => {
      try {
        let page = await loadReaderPage(scope,{sectionId,query}), items = [...page.ideas];
        while (!cancelled && page.nextCursor && items.length < target) {
          page = await loadReaderPage(scope,{sectionId,query,cursor:page.nextCursor}); items.push(...page.ideas);
        }
        if (!cancelled) {navigation.current={scope,sections:page.sections,counts:page.counts};setMain({items,page,source:scope,loading:false,error:""});}
      } catch (error) {
        if (!cancelled && current === generation.current) setMain(previous => ({...previous,loading:false,error:reason(error),migration:error instanceof ReaderError && error.code==="MIGRATION_REQUIRED",auth:error instanceof ReaderError && error.code==="UNAUTHORIZED",conflict:error instanceof ReaderError?error.target:undefined,page:previous.page && error instanceof ReaderError && error.code==="OFFLINE" ? {...previous.page,offline:true} : previous.page}));
      }
    })(); },query ? 200 : 0);
    return () => {cancelled = true;clearTimeout(timer);};
  },[scope,enabled,sectionId,query,refreshId,locked,mainKey]);

  useEffect(() => {
    if (!enabled || locked) return;
    if (!ideaId) {setDetail({id:"",loading:false,offline:false,error:""});return;}
    let cancelled = false;
    const inMemory=detailScope.current===scope && detailRef.current.id===ideaId ? detailRef.current.idea : undefined;
    detailScope.current=scope;
    setDetail({id:ideaId,idea:inMemory,loading:true,offline:false,error:""});
    void loadReaderIdea(scope,ideaId).then(result => {if(!cancelled)setDetail({id:ideaId,idea:result.idea,loading:false,offline:result.offline,error:""});})
      .catch(error => {if(!cancelled) {
        if(inMemory && error instanceof ReaderError && ["OFFLINE","UNAVAILABLE"].includes(error.code))setDetail({id:ideaId,idea:inMemory,loading:false,offline:true,error:""});
        else setDetail({id:ideaId,loading:false,offline:false,error:reason(error),auth:error instanceof ReaderError && error.code==="UNAUTHORIZED",conflict:error instanceof ReaderError?error.target:undefined});
      }});
    return () => {cancelled=true;};
  },[scope,enabled,ideaId,refreshId,locked]);

  const sectionKey = main.page?.sections.map(section => section.id).join("\n") || "";
  useEffect(() => {
    ++sideGeneration.current;
    if (!enabled || locked || !main.page) return;
    let cancelled = false;
    const sections = main.page.sections;
    void (async () => {
      const next: Record<string,List> = {};
      for (let start=0;start<sections.length && !cancelled;start+=4) await Promise.all(sections.slice(start,start+4).map(async section => {
        try {
          let page=await loadReaderPage(scope,{sectionId:section.id,limit:4}),items=[...page.ideas];
          const target=state.current.sidebar[section.id]?.items.length || 4;
          while(!cancelled && page.nextCursor && items.length<target){page=await loadReaderPage(scope,{sectionId:section.id,cursor:page.nextCursor});items.push(...page.ideas);}
          next[section.id]={items,page,loading:false,error:""};
        }
        catch(error){next[section.id]={...emptyList,error:reason(error)};}
      }));
      if(!cancelled)setSidebar(next);
    })();
    return () => {cancelled=true;};
  },[scope,enabled,sectionKey,main.page?.revision,refreshId,locked]);

  useEffect(() => {
    ++searchGeneration.current;
    if (!enabled || locked || !sidebarQuery.trim()) {if(!sidebarQuery.trim())setSearch(emptyList);return;}
    let cancelled=false;setSearch({...emptyList,loading:true});
    const timer=setTimeout(()=>{void loadReaderPage(scope,{query:sidebarQuery}).then(page=>{if(!cancelled)setSearch({items:page.ideas,page,loading:false,error:""});}).catch(error=>{if(!cancelled)setSearch({...emptyList,error:reason(error)});});},200);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[scope,enabled,sidebarQuery,refreshId,locked]);

  async function loadMore() {
    const before=state.current.main, cursor=before.page?.nextCursor, current=generation.current;
    if(!cursor || before.loading || moreBusy.current || state.current.locked)return;
    moreBusy.current=true;setMain(previous=>({...previous,loading:true}));
    try {
      const page=await loadReaderPage(scope,{sectionId,query,cursor});
      if(current===generation.current)setMain(previous=>({items:[...previous.items,...page.ideas],page,source:scope,loading:false,error:""}));
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
    try {const page=await loadReaderPage(scope,{sectionId:id,cursor:before.page.nextCursor});if(current===sideGeneration.current)setSidebar(previous=>({...previous,[id]:{items:[...before.items,...page.ideas],page,loading:false,error:""}}));}
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
  return {library,main,sidebar,search,counts,detail:detail.id===ideaId?detail:null,migrationRequired:main.migration,authRequired:main.auth || detail.id===ideaId && detail.auth,online,offline:!!scope && (!online || !!main.page?.offline || !!(ideaId && detail.offline)),refresh,loadMore,expandSection,moreSearch};
}

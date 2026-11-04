"use client";
import { translate as t } from "@/lib/i18n";
import { LanguagePicker, useI18n } from "./language-picker";
import { loadExampleMedia } from "@/lib/example-media";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronRight, CircleAlert, Cloud, CloudCheck, CloudOff, RefreshCw, Code2, Folder, FolderInput, Gamepad2, ImagePlus, LayoutGrid, Lightbulb, LockKeyhole, Monitor, Palette, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Rocket, Search, Trash2 } from "lucide-react";
import { Dialog } from "./dialog";
import { DropdownMenu } from "./dropdown-menu";
import { EditorActions } from "./editor-actions";
import { SidebarResizer } from "./sidebar-resizer";
import { ThemePicker } from "./theme-picker";
import { BackupControls } from "./backup-controls";
import { CloudSyncControls } from "./cloud-sync-controls";
import { useAutoSync } from "./use-auto-sync";
import { syncLabel } from "@/lib/sync-controller";
import { equal } from "@/lib/entity-sync";
import { initializeLocalLibrary, readLocalLibrary, saveLocalLibrary, subscribeLocalChanges } from "@/lib/library-store";
import { logout } from "@/app/auth-actions";
import { BlockEditor, ProjectBlocks } from "./project-blocks";
import { describeMediaFile, mediaIds, projectMediaIds, removeMediaFiles, saveMediaFiles } from "@/lib/media-store";
import { MediaScope } from "./media-scope";
import { useMediaSource } from "@/lib/use-media-source";
import { coverNames, createId, demoLibrary, readRoute, routeHash, type Cover, type Library, type MediaAsset, type Project, type Route, type Section, type SectionIcon } from "@/lib/ideas";

type Modal =
  | { type: "new-section" }
  | { type: "edit-section" | "delete-section"; section: Section }
  | { type: "new-project"; sectionId: string }
  | { type: "edit-project" | "delete-project" | "move-project"; project: Project }
  | { type: "storage-info" };

const sectionIcons = { gamepad: Gamepad2, book: BookOpen, code: Code2, folder: Folder, lightbulb: Lightbulb, palette: Palette, rocket: Rocket };
function CoverArt({ cover, small = false, image, file, title = t("Новая идея") }: { cover: Cover; small?: boolean; image?: MediaAsset; file?: Blob; title?: string }) {
  const { t } = useI18n();
  const coverRef=useRef<HTMLDivElement>(null);
  const { source, error, setError } = useMediaSource(image?.id, file,coverRef);
  return <div ref={coverRef} aria-hidden="true" className={`cover-art cover-${cover} ${small ? "cover-small" : ""} ${image ? "cover-uploaded" : ""}`}>{image && source && !error ? <img src={source} alt="" onError={() => setError(t("Обложка недоступна"))} /> : <span>{image && error ? t("Обложка недоступна") : title}</span>}</div>;
}

function SectionSymbol({ icon }: { icon: SectionIcon }) {
  const { t } = useI18n();
  const Icon = sectionIcons[icon];
  return <Icon aria-hidden="true" />;
}

export function IdeaBank({ account, cloudScope }: { account?: string; cloudScope?: string }) {
  const { t } = useI18n();
  const [library, setLibrary] = useState<Library>(demoLibrary);
  const [ready, setReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [route, setRoute] = useState<Route>({ screen: "home" });
  const [modal, setModal] = useState<Modal | null>(null);
  const [query, setQuery] = useState("");
  const [cardLimit,setCardLimit]=useState(24);
  const [searchLimit,setSearchLimit]=useState(24);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [draft, setDraft] = useState<Project | null>(null);
  const [message, setMessage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<Map<string, Blob>>(new Map());
  const [mediaError, setMediaError] = useState("");
  const [saving, setSaving] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const savingRef = useRef(false);
  const importingRef = useRef(false);
  const [importingMedia, setImportingMedia] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const routeRef = useRef(route);
  const dirtyRef = useRef(false);
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const returnBlock = useRef<string | null>(null);

  const currentProject = route.screen === "project" ? library.projects.find(p => p.id === route.id) : undefined;
  const currentSection = route.screen === "section" ? library.sections.find(s => s.id === route.id) : library.sections.find(s => s.id === currentProject?.sectionId);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(currentProject);
  dirtyRef.current = dirty;
  routeRef.current = route;

  const syncBlocked=!!draft || saving || importingMedia || backupBusy || (!!modal && modal.type!=="storage-info");
  const automaticSync=useAutoSync(cloudScope,ready&&!readOnly,
    ()=>ready&&!readOnly&&!draft&&!savingRef.current&&!importingRef.current&&!importingMedia&&!backupBusy&&(!modalRef.current||modalRef.current.type==="storage-info"),
    next=>{
      if(draft || dirtyRef.current || savingRef.current || (modalRef.current&&modalRef.current.type!=="storage-info"))return;
      setLibrary(previous=>equal(previous,next)?previous:next);
      const current=routeRef.current;
      if(current.screen==="project"&&!next.projects.some(idea=>idea.id===current.id) || current.screen==="section"&&!next.sections.some(section=>section.id===current.id)){
        setRoute({screen:"home"});history.replaceState(null,"","#/");
      }
    },syncBlocked);
  const syncView=automaticSync.view;
  const syncAttention=["review","conflict","migration","auth","error"].includes(syncView.phase);

  useEffect(() => {
    let cancelled = false;
    try { setSidebarCollapsed(localStorage.getItem("idea-bank.sidebar-collapsed") === "true"); } catch { /* Navigation remains available if browser storage is disabled. */ }
    try { const width = Number(localStorage.getItem("idea-bank.sidebar-width")); if (Number.isFinite(width) && width >= 220 && width <= 520) setSidebarWidth(Math.min(width, Math.max(220, innerWidth - 360))); } catch { /* Use the default width when storage is unavailable. */ }
    async function loadLibrary() { try {
      const saved = await initializeLocalLibrary(async () => ({ library: structuredClone(demoLibrary), files: await loadExampleMedia() }));
      if (!cancelled) setLibrary(saved);
    } catch {
      if (!cancelled) { setReadOnly(true); setStorageError(t("Не удалось прочитать сохранённую библиотеку. Исходные данные оставлены без изменений. Сейчас показан пример; редактирование отключено.")); }
    }
    if (!cancelled) { setRoute(readRoute(location.hash)); setReady(true); }
    }
    void loadLibrary();
    function onHashChange() {
      const next = readRoute(location.hash);
      if (routeHash(next) === routeHash(routeRef.current)) return;
      if (savingRef.current || importingRef.current) { history.replaceState(null, "", routeHash(routeRef.current)); return; }
      if (dirtyRef.current && !window.confirm(t("Уйти без сохранения изменений?"))) {
        history.replaceState(null, "", routeHash(routeRef.current));
        return;
      }
      setDraft(null); setQuery(""); setModal(null); setRoute(next);
    }
    function beforeUnload(e: BeforeUnloadEvent) {
      if (dirtyRef.current || savingRef.current || importingRef.current) { e.preventDefault(); e.returnValue = ""; }
    }
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("beforeunload", beforeUnload);
    return () => { cancelled = true; window.removeEventListener("hashchange", onHashChange); window.removeEventListener("beforeunload", beforeUnload); };
  }, []);

  useEffect(() => { if (ready) heading.current?.focus(); }, [route, ready]);
  useEffect(() => {
    function constrainSidebar() { setSidebarWidth(width => width === null ? null : Math.min(width, Math.max(220, innerWidth - 360))); }
    window.addEventListener("resize", constrainSidebar);
    return () => window.removeEventListener("resize", constrainSidebar);
  }, []);
  useEffect(() => {
    if (!scrollTarget) return;
    const target = document.getElementById(`block-${scrollTarget}`);
    if (!target) return;
    target.scrollIntoView({ block: "start", behavior: "instant" });
    if (draft) target.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    setScrollTarget(null);
  }, [scrollTarget, draft]);
  useEffect(() => { if (!draft) { setPendingMedia(new Map()); setMediaError(""); } }, [draft]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const refresh = () => {
      if (draft || dirtyRef.current || (modalRef.current&&modalRef.current.type!=="storage-info") || savingRef.current || importingRef.current) return;
      void readLocalLibrary().then(next => { if (!cancelled && !draft && !dirtyRef.current && (!modalRef.current||modalRef.current.type==="storage-info") && !savingRef.current) setLibrary(next); }).catch(() => {});
    };
    const unsubscribe = subscribeLocalChanges(refresh);
    window.addEventListener("focus", refresh);
    refresh();
    return () => { cancelled = true; unsubscribe(); window.removeEventListener("focus", refresh); };
  }, [ready, draft, modal]);

  /** Publishes UI success only after the library and pending changes commit together. */
  async function commit(next: Library, notice: string) {
    if (readOnly || savingRef.current) return false;
    savingRef.current = true; setSaving(true);
    try {
      await saveLocalLibrary(next, library);
      setLibrary(next); setStorageError(""); setMessage(notice);
      const kept = new Set(next.projects.flatMap(projectMediaIds));
      const removed = library.projects.flatMap(projectMediaIds).filter(id => !kept.has(id));
      void removeMediaFiles(removed).catch(() => {});
      return true;
    } catch (reason) {
      setStorageError(reason instanceof Error ? reason.message : t("Не удалось сохранить изменения в браузере. Они остались на странице, но могут пропасть после обновления."));
      setMessage(""); return false;
    } finally { savingRef.current = false; setSaving(false); }
  }

  function navigate(next: Route) {
    if (savingRef.current || importingRef.current) return;
    if (dirty && !window.confirm(t("Уйти без сохранения изменений?"))) return;
    dirtyRef.current = false;
    setDraft(null); setQuery(""); setModal(null); setRoute(next);
    location.hash = routeHash(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function toggleSidebar() {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    try { localStorage.setItem("idea-bank.sidebar-collapsed", String(collapsed)); } catch { /* The toggle still works for this session. */ }
  }

  function cancelEditing() {
    if (importingRef.current) return;
    if (!dirty || window.confirm(t("Отменить изменения идеи?"))) {
      setDraft(null); setScrollTarget(returnBlock.current); returnBlock.current = null;
    }
  }

  function editBlock(id: string) {
    if (!currentProject || readOnly) return;
    returnBlock.current = id; setDraft(structuredClone(currentProject)); setScrollTarget(id);
  }

  function addBlock() {
    const project = draft || currentProject;
    if (!project || readOnly || saving) return;
    const id = createId();
    returnBlock.current = id;
    setDraft({ ...structuredClone(project), blocks: [...project.blocks, { id, heading: "", text: "", width: "full", media: [] }] });
    setScrollTarget(id);
  }

  function sectionMenu(section: Section, label = t("Действия с разделом")) {
    return <DropdownMenu label={label} disabled={readOnly || saving} items={[
      { label: t("Добавить идею"), icon: <Plus />, onSelect: () => setModal({ type: "new-project", sectionId: section.id }) },
      { label: t("Изменить раздел"), icon: <Pencil />, onSelect: () => setModal({ type: "edit-section", section }) },
      { label: t("Удалить раздел"), icon: <Trash2 />, danger: true, onSelect: () => setModal({ type: "delete-section", section }) },
    ]} />;
  }

  async function saveProject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || !currentProject || savingRef.current || importingRef.current || readOnly) return;
    const saved = { ...currentProject, blocks: draft.blocks, updatedAt: new Date().toISOString() };
    savingRef.current = true; setSaving(true); setMediaError("");
    try {
      const referenced = new Set(mediaIds(saved.blocks));
      await saveMediaFiles(new Map([...pendingMedia].filter(([id]) => referenced.has(id))));
      savingRef.current = false;
      if (await commit({ ...library, projects: library.projects.map(p => p.id === saved.id ? saved : p) }, t("Идея и медиа сохранены в этом браузере."))) { setDraft(null); setScrollTarget(returnBlock.current); returnBlock.current = null; }
    } catch { setMediaError(t("Не удалось сохранить медиа: возможно, закончилось место или браузер запретил хранение файлов. Текст и файлы остались в редакторе — попробуй сохранить ещё раз.")); }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function removeSection(section: Section) {
    if (!await commit({ ...library, sections: library.sections.filter(s => s.id !== section.id), projects: library.projects.filter(p => p.sectionId !== section.id) }, t("Раздел удалён."))) return;
    setModal(null);
    if (currentSection?.id === section.id) navigate({ screen: "home" });
  }

  async function removeProject(project: Project) {
    if (!await commit({ ...library, projects: library.projects.filter(p => p.id !== project.id) }, t("Идея удалена."))) return;
    setModal(null);
    if (currentProject?.id === project.id) navigate({ screen: "section", id: project.sectionId });
  }

  const allProjects = [...library.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleProjects = allProjects.filter(p => (route.screen !== "section" || p.sectionId === route.id) && `${p.name} ${p.description}`.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")));
  useEffect(()=>{setCardLimit(24);},[route.screen,route.screen === "section" ? route.id : "",query]);
  useEffect(()=>{setSearchLimit(24);},[sidebarQuery]);
  const recentProjects = allProjects.slice(0, 4);
  const sidebarResults = sidebarQuery.trim() ? allProjects.filter(project => `${project.name} ${project.description}`.toLocaleLowerCase("ru").includes(sidebarQuery.trim().toLocaleLowerCase("ru"))) : [];
  const missing = (route.screen === "project" && !currentProject) || (route.screen === "section" && !currentSection);
  const projectCount = (sectionId: string) => library.projects.filter(p => p.sectionId === sectionId).length;

  function projectCardMenu(project: Project) {
    return <DropdownMenu label={t("Действия с идеей {0}", { 0: project.name })} disabled={readOnly || saving} items={[
      { label: t("Изменить"), icon: <Pencil />, onSelect: () => setModal({ type: "edit-project", project }) },
      { label: t("Перенести в раздел"), icon: <FolderInput />, onSelect: () => setModal({ type: "move-project", project }) },
      { label: t("Удалить идею"), icon: <Trash2 />, danger: true, onSelect: () => setModal({ type: "delete-project", project }) },
    ]} />;
  }

  function newProjectCard() {
    return <button className="new-project-card" disabled={readOnly || saving || !library.sections.length} onClick={() => setModal({ type: "new-project", sectionId: route.screen === "section" ? route.id : library.sections[0].id })}><Plus /><span>{t("Новая идея")}</span></button>;
  }

  function projectCards() {
    return <><div className="project-grid">{visibleProjects.slice(0,cardLimit).map(p => <div className="project-card-shell" key={p.id}><button className="project-card" onClick={() => navigate({ screen: "project", id: p.id })}>
      <CoverArt cover={p.cover} image={p.coverImage} title={p.name} /><strong>{p.name}</strong><span className="card-description">{p.description || t("Новая идея")}</span><span className="card-category">{library.sections.find(s => s.id === p.sectionId)?.name}<ArrowUpRight /></span>
    </button><div className="project-card-menu">{projectCardMenu(p)}</div></div>)}{!query && newProjectCard()}</div>{visibleProjects.length>cardLimit && <button className="secondary-button load-more-ideas" onClick={()=>setCardLimit(value=>value+24)}>{t("Показать ещё идеи")}</button>}</>;
  }

  return <MediaScope.Provider value={cloudScope}><div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ "--sidebar-width": sidebarWidth ? `${sidebarWidth}px` : undefined } as CSSProperties}>
    <aside id="library-sidebar" className="sidebar" aria-label={t("Разделы библиотеки")} hidden={sidebarCollapsed}>
      <div className="sidebar-heading"><button className="brand" onClick={() => navigate({ screen: "home" })}><span className="brand-mark">i.</span><span className="brand-name">idea bank</span></button><button className="icon-button sidebar-toggle" type="button" aria-label={t("Свернуть боковую панель")} title={t("Свернуть боковую панель")} aria-controls="library-sidebar" aria-expanded="true" onClick={toggleSidebar}><PanelLeftClose /></button></div>
      <p className="sidebar-caption">{t("МОЕ ПРОСТРАНСТВО")}</p>
      <button className={`nav-item ${route.screen === "home" ? "selected" : ""}`} onClick={() => navigate({ screen: "home" })}><LayoutGrid /><span>{t("Все идеи")}</span><small>{library.projects.length}</small></button>
      <label className="sidebar-search idea-search"><Search /><input type="search" aria-label={t("Поиск идеи в библиотеке")} placeholder={t("Найти идею")} value={sidebarQuery} onChange={e => setSidebarQuery(e.target.value)} /></label>
      {sidebarQuery.trim() && <div className="sidebar-search-results" aria-label={t("Результаты поиска")}><p className="sidebar-search-count" role="status">{t("Найдено: ")}{sidebarResults.length}</p><ul>{sidebarResults.slice(0,searchLimit).map(project => <li key={project.id}><button onClick={() => navigate({ screen: "project", id: project.id })}><strong>{project.name}</strong><small>{library.sections.find(section => section.id === project.sectionId)?.name}</small></button></li>)}</ul>{sidebarResults.length>searchLimit && <button className="back-button" onClick={()=>setSearchLimit(value=>value+24)}>{t("Показать ещё")}</button>}</div>}
      <div className="sidebar-label"><span>{t("Мои разделы")}</span><button className="icon-button" aria-label={t("Создать раздел")} disabled={!ready || readOnly} onClick={() => setModal({ type: "new-section" })}><Plus /></button></div>
      <nav aria-label={t("Разделы и идеи")}>{library.sections.map(s => {
        const projects = allProjects.filter(project => project.sectionId === s.id);
        const expanded = !!expandedSections[s.id];
        return <div className="sidebar-section" key={s.id}>
          <button className={`nav-item ${currentSection?.id === s.id ? "selected" : ""}`} onClick={() => navigate({ screen: "section", id: s.id })}><SectionSymbol icon={s.icon} /><span>{s.name}</span><small>{projects.length}</small></button>
          {!!projects.length && <ul className="sidebar-projects" id={`sidebar-projects-${s.id}`}>{(expanded ? projects : projects.slice(0, 4)).map(project => <li key={project.id}><button className={`sidebar-project ${currentProject?.id === project.id ? "selected" : ""}`} aria-current={currentProject?.id === project.id ? "page" : undefined} title={project.name} onClick={() => navigate({ screen: "project", id: project.id })}><span>{project.name}</span></button></li>)}</ul>}
          {projects.length > 4 && <button className="expand-section" aria-label={t("{0} раздел {1}", { 0: expanded ? t("Свернуть") : t("Развернуть"), 1: s.name })} aria-expanded={expanded} aria-controls={`sidebar-projects-${s.id}`} onClick={() => setExpandedSections(previous => ({ ...previous, [s.id]: !previous[s.id] }))}><ChevronRight className={expanded ? "expanded" : ""} /><span>{expanded ? t("Свернуть раздел") : t("Развернуть раздел (+{0})", { 0: projects.length - 4 })}</span></button>}
        </div>;
      })}</nav>
      <div className="sidebar-bottom"><span className="profile-mark">{t("М")}</span><div>{t("Моя библиотека")}<small>{t("Место для будущих идей")}</small></div></div>
    </aside>
    {!sidebarCollapsed && <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} onCommit={width => { try { localStorage.setItem("idea-bank.sidebar-width", String(width)); } catch { /* Keep the current width for this session. */ } }} onReset={() => { setSidebarWidth(null); try { localStorage.removeItem("idea-bank.sidebar-width"); } catch { /* Keep the default width for this session. */ } }} />}

    <div className="workspace">
      <header className="topbar"><button aria-label="Idea Bank" className="brand mobile-brand" onClick={() => navigate({ screen: "home" })}><span className="brand-mark">i.</span><span className="brand-name">idea bank</span></button><div className="topbar-navigation">{sidebarCollapsed && <button className="icon-button sidebar-toggle" type="button" aria-label={t("Развернуть боковую панель")} title={t("Развернуть боковую панель")} aria-controls="library-sidebar" aria-expanded="false" onClick={toggleSidebar}><PanelLeftOpen /></button>}<nav className="breadcrumbs" aria-label={t("Путь к идее")}><button onClick={() => navigate({ screen: "home" })} aria-current={route.screen === "home" ? "page" : undefined}>{t("Библиотека")}</button>{currentSection && <><ChevronRight /><button onClick={() => navigate({ screen: "section", id: currentSection.id })} aria-current={route.screen === "section" ? "page" : undefined}>{currentSection.name}</button></>}{currentProject && <><ChevronRight /><button onClick={() => navigate({ screen: "project", id: currentProject.id })} aria-current="page">{currentProject.name}</button></>}</nav></div>
        <div className="topbar-actions"><LanguagePicker /><ThemePicker /><button aria-label={cloudScope ? `${t("Синхронизация")}: ${t(syncLabel(syncView.phase))}` : t("На этом устройстве")} title={cloudScope ? t(syncView.error||syncView.status||syncLabel(syncView.phase)) : t("На этом устройстве")} data-sync-phase={cloudScope?syncView.phase:undefined} className={`local-status ${storageError||syncAttention ? "has-warning" : ""}`} onClick={() => setModal({ type: "storage-info" })}>{storageError||syncAttention ? <CircleAlert /> : cloudScope ? syncView.busy ? <RefreshCw className="sync-spinning" /> : syncView.phase==="synced" ? <CloudCheck /> : syncView.phase==="offline" ? <CloudOff /> : <Cloud /> : <Monitor />}<span>{cloudScope ? t(syncLabel(syncView.phase)) : t("На этом устройстве")}</span></button>{account && <form action={logout} onSubmit={event => { if (saving || importingMedia || backupBusy || (dirtyRef.current && !window.confirm(t("Выйти без сохранения изменений?")))) event.preventDefault(); }}><button type="submit" className="secondary-button account-logout" title={t("Выполнен вход: {0}", { 0: account })} disabled={saving || importingMedia || backupBusy}>{t("Выйти")}</button></form>}</div>
      </header>

      {storageError && <div className="storage-warning" role="alert"><CircleAlert /><p>{t(storageError)}</p></div>}
      {!ready ? <main className="page-content loading"><span className="eyebrow">IDEA BANK</span><h1>{t("Открываем библиотеку…")}</h1></main> : <main className={`page-content ${route.screen === "project" ? "project-page" : route.screen === "section" ? "section-page" : "library-page"}`}>
        {missing ? <div className="empty-state"><Folder /><h1 ref={heading} tabIndex={-1}>{t("Здесь пока ничего нет")}</h1><p>{t("Возможно, эта идея или раздел уже удалены.")}</p><button className="primary-button" onClick={() => navigate({ screen: "home" })}>{t("К библиотеке")}</button></div> : route.screen === "project" && currentProject ? <>
          <div className="project-toolbar"><button className="back-button" onClick={() => navigate({ screen: "section", id: currentProject.sectionId })}><ArrowLeft />{currentSection?.name}</button><div className="project-actions">{!draft && <><button className="edit-button page-action-button" disabled={readOnly} onClick={() => setModal({ type: "edit-project", project: currentProject })}><Pencil />{t("Изменить")}</button><DropdownMenu label={t("Действия с идеей")} disabled={readOnly} items={[
            { label: t("Перенести в раздел"), icon: <FolderInput />, onSelect: () => setModal({ type: "move-project", project: currentProject }) },
            { label: t("Удалить идею"), icon: <Trash2 />, danger: true, onSelect: () => setModal({ type: "delete-project", project: currentProject }) },
          ]} /></>}</div></div>
          <article className="document"><div className="project-summary"><h1 ref={heading} tabIndex={-1}>{currentProject.name}</h1>{currentProject.description && <p className="page-subtitle">{currentProject.description}</p>}</div><div className="document-rule" />
          {draft ? <form id="project-editor" onSubmit={saveProject}>
            <p className="layout-help">{t("Перетаскивай блоки за ручку ⠿ или меняй порядок стрелками. Выбери ширину карточек; на телефоне они выстроятся в один столбец.")}</p>
            <BlockEditor blocks={draft.blocks} onChange={blocks => setDraft(previous => previous ? { ...previous, blocks } : null)} pending={pendingMedia} onFiles={files => setPendingMedia(previous => new Map([...previous, ...files]))} onError={setMediaError} disabled={saving || importingMedia} onImporting={busy => { importingRef.current = busy; setImportingMedia(busy); }} onAdd={addBlock} />
            {mediaError && <p className="media-save-error" role="alert">{t(mediaError)}</p>}
            {importingMedia && <p className="media-import-status" role="status">{t("Подготавливаем медиа…")}</p>}
            <div className="editor-save"><EditorActions saving={saving || importingMedia} onCancel={cancelEditing} /></div>
          </form> : <>{currentProject.blocks.length ? <ProjectBlocks blocks={currentProject.blocks} onEdit={editBlock} readOnly={readOnly} /> : <p className="muted">{t("Здесь появятся первые мысли об этой идее.")}</p>}
            <button className="add-block-button" disabled={readOnly} onClick={addBlock}><Plus />{t("Добавить блок")}</button></>}
          </article>
        </> : <>
          <div className="project-toolbar section-back-toolbar">{route.screen === "section" ? <button className="back-button" onClick={() => navigate({ screen: "home" })}><ArrowLeft />{t("Библиотека")}</button> : <span />}<div className="project-actions"><button className="primary-button page-action-button" disabled={readOnly || !library.sections.length} onClick={() => setModal({ type: "new-project", sectionId: route.screen === "section" ? route.id : library.sections[0].id })}><Plus />{t("Идея")}</button></div></div>
          <div className="page-heading"><div><h1 ref={heading} tabIndex={-1}>{route.screen === "home" ? <><span className="desktop-title">{t("Все твои идеи.")}<br />{t("В одном месте.")}</span><span className="mobile-title">{t("У каждой идеи")}<br />{t("есть своё место.")}</span></> : currentSection?.name}</h1><p className="page-subtitle">{route.screen === "home" ? t("От случайной мысли до следующей большой идеи.") : currentSection?.description}</p></div>
          </div>

          {route.screen === "home" && <section className="sections-area" aria-labelledby="sections-heading"><div className="section-heading"><h2 id="sections-heading">{t("Мои разделы")}</h2></div><div className="section-grid">{library.sections.map(s => <div className="section-card" key={s.id}><button className="section-open" onClick={() => navigate({ screen: "section", id: s.id })}><span className="section-symbol"><SectionSymbol icon={s.icon} /></span><span><strong>{s.name}</strong><small>{t("Идей: ")}{projectCount(s.id)}</small></span></button>{sectionMenu(s, t("Действия с разделом {0}", { 0: s.name }))}</div>)}<button className="new-section-card" disabled={readOnly} onClick={() => setModal({ type: "new-section" })}><Plus /><span>{t("Создать раздел")}</span></button></div></section>}

          <section className={`projects-area ${route.screen === "home" && !query ? "home-projects" : ""}`} aria-label={t("Идеи")}><div className="projects-toolbar"><label className="search-field idea-search"><Search /><input type="search" aria-label={t("Найти идею")} placeholder={t("Найти идею")} value={query} onChange={e => setQuery(e.target.value)} /></label><span>{t("Идей: ")}{visibleProjects.length}</span></div>{projectCards()}{!visibleProjects.length && <div className="empty-inline"><p>{query ? t("Таких идей пока нет. Попробуй другое название.") : t("Место для твоей следующей идеи.")}</p></div>}</section>
          {route.screen === "home" && !!recentProjects.length && !query && <section className="recent-project">{!!recentProjects.length && <h2>{t("Последние идеи")}</h2>}<div className="recent-project-list">{recentProjects.map(project => <div className="recent-project-item" key={project.id}><button onClick={() => navigate({ screen: "project", id: project.id })}><CoverArt cover={project.cover} image={project.coverImage} title={project.name} small /><span><strong>{project.name}</strong><small>{library.sections.find(s => s.id === project.sectionId)?.name}</small></span></button>{projectCardMenu(project)}</div>)}</div></section>}

        </>}
      </main>}
      <div className="notice" role="status" aria-live="polite">{t(message)}</div>
      <footer className="app-footer"><span><LockKeyhole />{t("Личная библиотека")}</span><button onClick={() => setModal({ type: "storage-info" })}>{cloudScope ? t("Синхронизация и копии") : t("Локальная версия")} <ArrowUpRight /></button></footer>
    </div>

    {modal && <Dialog title={modalTitle(modal)} closeDisabled={backupBusy} onClose={() => { if (!savingRef.current) setModal(null); }}>
      {modal.type === "new-section" || modal.type === "edit-section" ? <SectionForm section={modal.type === "edit-section" ? modal.section : undefined} onCancel={() => setModal(null)} onSave={async values => {
        const section: Section = modal.type === "edit-section" ? { ...modal.section, ...values } : { id: createId(), ...values };
        const success = await commit({ ...library, sections: modal.type === "edit-section" ? library.sections.map(s => s.id === section.id ? section : s) : [...library.sections, section] }, modal.type === "edit-section" ? t("Раздел обновлён.") : t("Раздел создан.")); if (success) setModal(null); return success;
      }} /> : modal.type === "new-project" || modal.type === "edit-project" ? <ProjectForm sections={library.sections} initialSectionId={modal.type === "new-project" ? modal.sectionId : modal.project.sectionId} project={modal.type === "edit-project" ? modal.project : undefined} onCancel={() => setModal(null)} onSave={async (values, coverFile) => {
        const project: Project = modal.type === "edit-project" ? { ...modal.project, ...values, updatedAt: new Date().toISOString() } : { id: createId(), ...values, blocks: [], updatedAt: new Date().toISOString() };
        savingRef.current = true;
        try {
        if (coverFile && project.coverImage) await saveMediaFiles(new Map([[project.coverImage.id, coverFile]]));
        savingRef.current = false;
        const success = await commit({ ...library, projects: modal.type === "edit-project" ? library.projects.map(p => p.id === project.id ? project : p) : [...library.projects, project] }, t("Идея сохранена в этом браузере."));
        if (success) { setModal(null); if (modal.type === "new-project") navigate({ screen: "project", id: project.id }); }
        return success;
        } finally { savingRef.current = false; }
      }} />
      : modal.type === "delete-section" ? <><p className="dialog-description">{t("Удалить «")}{modal.section.name}{t("»? Вместе с разделом будут удалены все его идеи (")}{projectCount(modal.section.id)}{t("). Это действие нельзя отменить.")}</p><div className="form-actions"><button className="secondary-button" onClick={() => setModal(null)}>{t("Отмена")}</button><button className="danger-button" onClick={() => removeSection(modal.section)}>{t("Удалить раздел")}</button></div></>
      : modal.type === "delete-project" ? <><p className="dialog-description">{t("Удалить «")}{modal.project.name}{t("» и все её текстовые блоки? Это действие нельзя отменить.")}</p><div className="form-actions"><button className="secondary-button" onClick={() => setModal(null)}>{t("Отмена")}</button><button className="danger-button" onClick={() => removeProject(modal.project)}>{t("Удалить идею")}</button></div></>
      : modal.type === "move-project" ? <div className="menu-options">{library.sections.map(s => <button disabled={s.id === modal.project.sectionId} key={s.id} onClick={async () => { const moved = { ...modal.project, sectionId: s.id, updatedAt: new Date().toISOString() }; if (await commit({ ...library, projects: library.projects.map(p => p.id === moved.id ? moved : p) }, t("Идея перенесена."))) setModal(null); }}><SectionSymbol icon={s.icon} /><span>{s.name}</span>{s.id === modal.project.sectionId && <Check />}</button>)}</div>
      : <><div className="storage-info-icon"><Monitor /></div><p className="dialog-description">{t("Изменения сохраняются на устройстве и автоматически отправляются в подключённое облако. ZIP-копия позволяет сохранить отдельный архив библиотеки.")}</p><p className="dialog-description">{t("Облачное подключение доступно после входа владельца и настройки B2. Очистка данных сайта в браузере удалит локальную библиотеку и вложения.")}</p>{automaticSync.controller && <CloudSyncControls controller={automaticSync.controller} view={syncView} library={library} locked={!!draft || importingMedia || backupBusy || saving} readOnly={readOnly} />}<BackupControls scope={cloudScope} library={library} locked={!!draft || importingMedia || backupBusy || syncView.busy} readOnly={readOnly} onBusyChange={busy => { savingRef.current = busy; setBackupBusy(busy); }} onRestored={next => {
        setLibrary(next); setReadOnly(false); setStorageError(""); setDraft(null); setPendingMedia(new Map()); setMediaError(""); setQuery(""); setSidebarQuery(""); setExpandedSections({});
        setRoute({ screen: "home" }); history.replaceState(null, "", "#/"); setModal(null); setMessage(t("Библиотека и медиа восстановлены из архива.")); window.scrollTo({ top: 0, behavior: "instant" });
      }} /><button className="primary-button full-width" disabled={backupBusy} onClick={() => setModal(null)}>{t("Понятно")}</button></>}
    </Dialog>}
  </div></MediaScope.Provider>;
}

function modalTitle(modal: Modal): string {
  switch (modal.type) {
    case "new-section": return t("Новый раздел");
    case "edit-section": return t("Изменить раздел");
    case "new-project": return t("Новая идея");
    case "edit-project": return t("Изменить идею");
    case "delete-section": return t("Удалить раздел?");
    case "delete-project": return t("Удалить идею?");
    case "move-project": return t("Перенести в раздел");
    case "storage-info": return t("Где хранятся идеи");
  }
}

function SectionForm({ section, onSave, onCancel }: { section?: Section; onSave: (values: Pick<Section, "name" | "description" | "icon">) => Promise<boolean>; onCancel: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(section?.name || "");
  const [description, setDescription] = useState(section?.description || "");
  const [icon, setIcon] = useState<SectionIcon>(section?.icon || "folder");
  const [submitting, setSubmitting] = useState(false);
  return <form className="section-form" onSubmit={async e => { e.preventDefault(); if (!name.trim() || submitting) return; setSubmitting(true); try { await onSave({ name: name.trim(), description: description.trim(), icon }); } finally { setSubmitting(false); } }}><fieldset disabled={submitting}>
    <label className="field-label" htmlFor="section-name">{t("Название")}</label><input autoFocus id="section-name" required maxLength={70} pattern=".*\S.*" value={name} placeholder={t("Например, Gamedev")} onChange={e => setName(e.target.value)} />
    <label className="field-label" htmlFor="section-description">{t("Описание ")}<span>{t("необязательно")}</span></label><textarea id="section-description" rows={2} maxLength={300} value={description} placeholder={t("Какие идеи будут здесь жить?")} onChange={e => setDescription(e.target.value)} />
    <fieldset className="icon-picker"><legend>{t("Значок раздела")}</legend>{(Object.keys(sectionIcons) as SectionIcon[]).map(value => <button type="button" className={`icon-button ${icon === value ? "chosen" : ""}`} key={value} aria-label={{ gamepad: t("Игры"), book: t("Обучение"), code: t("Программирование"), folder: t("Папка"), lightbulb: t("Идеи"), palette: t("Творчество"), rocket: t("Ракета") }[value]} aria-pressed={icon === value} onClick={() => setIcon(value)}><SectionSymbol icon={value} /></button>)}</fieldset>
    <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>{t("Отмена")}</button><button className="primary-button" type="submit">{section ? t("Сохранить") : t("Создать раздел")}</button></div></fieldset>
  </form>;
}

function ProjectForm({ sections, initialSectionId, project, onSave, onCancel }: { sections: Section[]; initialSectionId: string; project?: Project; onSave: (values: Pick<Project, "name" | "description" | "cover" | "coverImage" | "sectionId">, file?: File) => Promise<boolean>; onCancel: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(project?.name || "");
  const [description, setDescription] = useState(project?.description || "");
  const [sectionId, setSectionId] = useState(initialSectionId);
  const [cover, setCover] = useState<Cover>(project?.cover || "forest");
  const [coverImage, setCoverImage] = useState<MediaAsset | undefined>(project?.coverImage);
  const [coverFile, setCoverFile] = useState<File>();
  const [submitting, setSubmitting] = useState(false);
  const [readingCover, setReadingCover] = useState(false);
  const [error, setError] = useState("");
  return <form className="project-form" onSubmit={async e => {
    e.preventDefault(); if (!name.trim() || submitting || readingCover) return;
    setSubmitting(true); setError("");
    try { if (!await onSave({ name: name.trim(), description: description.trim(), sectionId, cover, coverImage }, coverFile)) setError(t("Не удалось сохранить идею. Попробуй ещё раз.")); }
    catch { setError(t("Не удалось сохранить обложку в браузере. Попробуй ещё раз или выбери готовую.")); }
    finally { setSubmitting(false); }
  }}><fieldset disabled={submitting || readingCover}>
    <label className="field-label" htmlFor="new-project-name">{t("Название")}</label><input autoFocus id="new-project-name" required maxLength={100} pattern=".*\S.*" value={name} placeholder={t("Как называется твоя идея?")} onChange={e => setName(e.target.value)} />
    <label className="field-label" htmlFor="new-project-description">{t("Краткое описание ")}<span>{t("необязательно")}</span></label><textarea id="new-project-description" maxLength={1000} rows={2} value={description} onChange={e => setDescription(e.target.value)} />
    <label className="field-label" htmlFor="new-project-section">{t("Раздел")}</label><select id="new-project-section" value={sectionId} onChange={e => setSectionId(e.target.value)}>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
    <fieldset className="cover-picker"><legend>{t("Обложка ")}<span className="cover-size-hint">{t("(рекомендуется 800 × 800 px)")}</span></legend>{(Object.keys(coverNames) as Cover[]).filter(value => value !== "sand").map(value => <button type="button" className={!coverImage && cover === value ? "chosen" : ""} key={value} aria-label={t(coverNames[value])} aria-pressed={!coverImage && cover === value} onClick={() => { setCover(value); setCoverImage(undefined); setCoverFile(undefined); }}><CoverArt cover={value} small />{!coverImage && cover === value && <Check />}</button>)}
      <label className={`upload-cover ${coverImage ? "chosen" : ""}`}>{coverImage ? <CoverArt cover={cover} image={coverImage} file={coverFile} small /> : <ImagePlus />}<input type="file" accept="image/*" aria-label={t("Загрузить свою обложку")} onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
        const asset = describeMediaFile(file);
        if (!asset || asset.kind !== "image") { setError(t("Выбери изображение PNG, JPEG, WebP или GIF.")); return; }
        setReadingCover(true);
        try { const image = await createImageBitmap(file); image.close(); setCoverImage(asset); setCoverFile(file); setError(""); }
        catch { setError(t("Не удалось открыть это изображение. Выбери другой файл.")); }
        finally { setReadingCover(false); }
      }} /><span className="sr-only">{t("Своя обложка")}</span></label>
    </fieldset>
    {coverImage && <p className="cover-file-name">{coverImage.name}</p>}
    {error && <p className="media-save-error" role="alert">{t(error)}</p>}
    <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>{t("Отмена")}</button><button className="primary-button" type="submit">{submitting ? t("Сохраняем…") : project ? t("Сохранить") : t("Создать идею")}</button></div></fieldset>
  </form>;
}

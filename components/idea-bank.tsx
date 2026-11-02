"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronRight, CircleAlert, Code2, Folder, FolderInput, Gamepad2, ImagePlus, LayoutGrid, Lightbulb, LockKeyhole, Monitor, Palette, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Rocket, Search, Trash2 } from "lucide-react";
import { Dialog } from "./dialog";
import { DropdownMenu } from "./dropdown-menu";
import { EditorActions } from "./editor-actions";
import { SidebarResizer } from "./sidebar-resizer";
import { ThemePicker } from "./theme-picker";
import { BackupControls } from "./backup-controls";
import { BlockEditor, ProjectBlocks } from "./project-blocks";
import { describeMediaFile, mediaIds, projectMediaIds, removeMediaFiles, saveMediaFiles } from "@/lib/media-store";
import { useMediaSource } from "@/lib/use-media-source";
import { coverNames, createId, demoLibrary, parseLibrary, readRoute, routeHash, STORAGE_KEY, type Cover, type Library, type MediaAsset, type Project, type Route, type Section, type SectionIcon } from "@/lib/ideas";

type Modal =
  | { type: "new-section" }
  | { type: "edit-section" | "delete-section"; section: Section }
  | { type: "new-project"; sectionId: string }
  | { type: "edit-project" | "delete-project" | "move-project"; project: Project }
  | { type: "storage-info" };

const sectionIcons = { gamepad: Gamepad2, book: BookOpen, code: Code2, folder: Folder, lightbulb: Lightbulb, palette: Palette, rocket: Rocket };
function CoverArt({ cover, small = false, image, file, title = "Новая идея" }: { cover: Cover; small?: boolean; image?: MediaAsset; file?: Blob; title?: string }) {
  const { source, error, setError } = useMediaSource(image?.id, file);
  return <div aria-hidden="true" className={`cover-art cover-${cover} ${small ? "cover-small" : ""} ${image ? "cover-uploaded" : ""}`}>{image && source && !error ? <img src={source} alt="" onError={() => setError("Обложка недоступна")} /> : <span>{image && error ? "Обложка недоступна" : title}</span>}</div>;
}

function SectionSymbol({ icon }: { icon: SectionIcon }) {
  const Icon = sectionIcons[icon];
  return <Icon aria-hidden="true" />;
}

export function IdeaBank() {
  const [library, setLibrary] = useState<Library>(demoLibrary);
  const [ready, setReady] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [route, setRoute] = useState<Route>({ screen: "home" });
  const [modal, setModal] = useState<Modal | null>(null);
  const [query, setQuery] = useState("");
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
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const returnBlock = useRef<string | null>(null);

  const currentProject = route.screen === "project" ? library.projects.find(p => p.id === route.id) : undefined;
  const currentSection = route.screen === "section" ? library.sections.find(s => s.id === route.id) : library.sections.find(s => s.id === currentProject?.sectionId);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(currentProject);
  dirtyRef.current = dirty;
  routeRef.current = route;

  useEffect(() => {
    try { setSidebarCollapsed(localStorage.getItem("idea-bank.sidebar-collapsed") === "true"); } catch { /* Navigation remains available if browser storage is disabled. */ }
    try { const width = Number(localStorage.getItem("idea-bank.sidebar-width")); if (Number.isFinite(width) && width >= 220 && width <= 520) setSidebarWidth(Math.min(width, Math.max(220, innerWidth - 360))); } catch { /* Use the default width when storage is unavailable. */ }
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        try { setLibrary(parseLibrary(raw)); }
        catch { setReadOnly(true); setStorageError("Не удалось прочитать сохранённую библиотеку. Исходные данные оставлены без изменений. Сейчас показан пример; редактирование отключено."); }
      }
    } catch { setStorageError("Браузер запретил локальное хранение. Изменения будут доступны только до закрытия или обновления страницы."); }
    setRoute(readRoute(location.hash));
    setReady(true);
    function onHashChange() {
      const next = readRoute(location.hash);
      if (routeHash(next) === routeHash(routeRef.current)) return;
      if (savingRef.current || importingRef.current) { history.replaceState(null, "", routeHash(routeRef.current)); return; }
      if (dirtyRef.current && !window.confirm("Уйти без сохранения изменений?")) {
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
    return () => { window.removeEventListener("hashchange", onHashChange); window.removeEventListener("beforeunload", beforeUnload); };
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

  /** Saves each completed action locally; reports storage failures without losing the in-memory edit. */
  function commit(next: Library, notice: string) {
    if (readOnly || savingRef.current) return false;
    setLibrary(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setStorageError(""); setMessage(notice);
      const kept = new Set(next.projects.flatMap(projectMediaIds));
      const removed = library.projects.flatMap(projectMediaIds).filter(id => !kept.has(id));
      void removeMediaFiles(removed).catch(() => { /* An unreferenced file can remain if storage is temporarily unavailable. */ });
      return true;
    } catch { setStorageError("Не удалось сохранить изменения в браузере. Они остались на странице, но могут пропасть после обновления."); setMessage(""); return false; }
  }

  function navigate(next: Route) {
    if (savingRef.current || importingRef.current) return;
    if (dirty && !window.confirm("Уйти без сохранения изменений?")) return;
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
    if (!dirty || window.confirm("Отменить изменения идеи?")) {
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

  function sectionMenu(section: Section, label = "Действия с разделом") {
    return <DropdownMenu label={label} disabled={readOnly || saving} items={[
      { label: "Добавить идею", icon: <Plus />, onSelect: () => setModal({ type: "new-project", sectionId: section.id }) },
      { label: "Изменить раздел", icon: <Pencil />, onSelect: () => setModal({ type: "edit-section", section }) },
      { label: "Удалить раздел", icon: <Trash2 />, danger: true, onSelect: () => setModal({ type: "delete-section", section }) },
    ]} />;
  }

  async function saveProject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || !draft.name.trim() || savingRef.current || importingRef.current || readOnly) return;
    const saved = { ...draft, name: draft.name.trim(), updatedAt: new Date().toISOString() };
    savingRef.current = true; setSaving(true); setMediaError("");
    try {
      const referenced = new Set(mediaIds(saved.blocks));
      await saveMediaFiles(new Map([...pendingMedia].filter(([id]) => referenced.has(id))));
      savingRef.current = false;
      if (commit({ ...library, projects: library.projects.map(p => p.id === saved.id ? saved : p) }, "Идея и медиа сохранены в этом браузере.")) { setDraft(null); setScrollTarget(returnBlock.current); returnBlock.current = null; }
    } catch { setMediaError("Не удалось сохранить медиа: возможно, закончилось место или браузер запретил хранение файлов. Текст и файлы остались в редакторе — попробуй сохранить ещё раз."); }
    finally { savingRef.current = false; setSaving(false); }
  }

  function removeSection(section: Section) {
    commit({ ...library, sections: library.sections.filter(s => s.id !== section.id), projects: library.projects.filter(p => p.sectionId !== section.id) }, "Раздел удалён.");
    setModal(null);
    if (currentSection?.id === section.id) navigate({ screen: "home" });
  }

  function removeProject(project: Project) {
    commit({ ...library, projects: library.projects.filter(p => p.id !== project.id) }, "Идея удалена.");
    setModal(null);
    if (currentProject?.id === project.id) navigate({ screen: "section", id: project.sectionId });
  }

  const allProjects = [...library.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const visibleProjects = allProjects.filter(p => (route.screen !== "section" || p.sectionId === route.id) && `${p.name} ${p.description}`.toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")));
  const recentProjects = allProjects.slice(0, 4);
  const sidebarResults = sidebarQuery.trim() ? allProjects.filter(project => `${project.name} ${project.description}`.toLocaleLowerCase("ru").includes(sidebarQuery.trim().toLocaleLowerCase("ru"))) : [];
  const missing = (route.screen === "project" && !currentProject) || (route.screen === "section" && !currentSection);
  const projectCount = (sectionId: string) => library.projects.filter(p => p.sectionId === sectionId).length;

  function projectCards() {
    return <div className="project-grid">{visibleProjects.map(p => <button key={p.id} className="project-card" onClick={() => navigate({ screen: "project", id: p.id })}>
      <CoverArt cover={p.cover} image={p.coverImage} title={p.name} /><strong>{p.name}</strong><span className="card-description">{p.description || "Новая идея"}</span><span className="card-category">{library.sections.find(s => s.id === p.sectionId)?.name}<ArrowUpRight /></span>
    </button>)}{route.screen === "section" && !query && <button className="new-project-card" disabled={readOnly} onClick={() => setModal({ type: "new-project", sectionId: route.id })}><Plus /><span>Новая идея</span></button>}</div>;
  }

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ "--sidebar-width": sidebarWidth ? `${sidebarWidth}px` : undefined } as CSSProperties}>
    <aside id="library-sidebar" className="sidebar" aria-label="Разделы библиотеки" hidden={sidebarCollapsed}>
      <div className="sidebar-heading"><button className="brand" onClick={() => navigate({ screen: "home" })}><span className="brand-mark">i.</span><span className="brand-name">idea bank</span></button><button className="icon-button sidebar-toggle" type="button" aria-label="Свернуть боковую панель" title="Свернуть боковую панель" aria-controls="library-sidebar" aria-expanded="true" onClick={toggleSidebar}><PanelLeftClose /></button></div>
      <p className="sidebar-caption">МОЕ ПРОСТРАНСТВО</p>
      <button className={`nav-item ${route.screen === "home" ? "selected" : ""}`} onClick={() => navigate({ screen: "home" })}><LayoutGrid /><span>Все идеи</span><small>{library.projects.length}</small></button>
      <label className="sidebar-search idea-search"><Search /><input type="search" aria-label="Поиск идеи в библиотеке" placeholder="Найти идею" value={sidebarQuery} onChange={e => setSidebarQuery(e.target.value)} /></label>
      {sidebarQuery.trim() && <div className="sidebar-search-results" aria-label="Результаты поиска"><p className="sidebar-search-count" role="status">Найдено: {sidebarResults.length}</p><ul>{sidebarResults.map(project => <li key={project.id}><button onClick={() => navigate({ screen: "project", id: project.id })}><strong>{project.name}</strong><small>{library.sections.find(section => section.id === project.sectionId)?.name}</small></button></li>)}</ul></div>}
      <div className="sidebar-label"><span>Мои разделы</span><button className="icon-button" aria-label="Создать раздел" disabled={!ready || readOnly} onClick={() => setModal({ type: "new-section" })}><Plus /></button></div>
      <nav aria-label="Разделы и идеи">{library.sections.map(s => {
        const projects = allProjects.filter(project => project.sectionId === s.id);
        const expanded = !!expandedSections[s.id];
        return <div className="sidebar-section" key={s.id}>
          <button className={`nav-item ${currentSection?.id === s.id ? "selected" : ""}`} onClick={() => navigate({ screen: "section", id: s.id })}><SectionSymbol icon={s.icon} /><span>{s.name}</span><small>{projects.length}</small></button>
          {!!projects.length && <ul className="sidebar-projects" id={`sidebar-projects-${s.id}`}>{(expanded ? projects : projects.slice(0, 4)).map(project => <li key={project.id}><button className={`sidebar-project ${currentProject?.id === project.id ? "selected" : ""}`} aria-current={currentProject?.id === project.id ? "page" : undefined} title={project.name} onClick={() => navigate({ screen: "project", id: project.id })}><span>{project.name}</span></button></li>)}</ul>}
          {projects.length > 4 && <button className="expand-section" aria-label={`${expanded ? "Свернуть" : "Развернуть"} раздел ${s.name}`} aria-expanded={expanded} aria-controls={`sidebar-projects-${s.id}`} onClick={() => setExpandedSections(previous => ({ ...previous, [s.id]: !previous[s.id] }))}><ChevronRight className={expanded ? "expanded" : ""} /><span>{expanded ? "Свернуть раздел" : `Развернуть раздел (+${projects.length - 4})`}</span></button>}
        </div>;
      })}</nav>
      <div className="sidebar-bottom"><span className="profile-mark">М</span><div>Моя библиотека<small>Место для будущих идей</small></div></div>
    </aside>
    {!sidebarCollapsed && <SidebarResizer width={sidebarWidth} onChange={setSidebarWidth} onCommit={width => { try { localStorage.setItem("idea-bank.sidebar-width", String(width)); } catch { /* Keep the current width for this session. */ } }} onReset={() => { setSidebarWidth(null); try { localStorage.removeItem("idea-bank.sidebar-width"); } catch { /* Keep the default width for this session. */ } }} />}

    <div className="workspace">
      <header className="topbar"><button className="brand mobile-brand" onClick={() => navigate({ screen: "home" })}><span className="brand-mark">i.</span>idea bank</button><div className="topbar-navigation">{sidebarCollapsed && <button className="icon-button sidebar-toggle" type="button" aria-label="Развернуть боковую панель" title="Развернуть боковую панель" aria-controls="library-sidebar" aria-expanded="false" onClick={toggleSidebar}><PanelLeftOpen /></button>}<nav className="breadcrumbs" aria-label="Путь к идее"><button onClick={() => navigate({ screen: "home" })} aria-current={route.screen === "home" ? "page" : undefined}>Библиотека</button>{currentSection && <><ChevronRight /><button onClick={() => navigate({ screen: "section", id: currentSection.id })} aria-current={route.screen === "section" ? "page" : undefined}>{currentSection.name}</button></>}{currentProject && <><ChevronRight /><button onClick={() => navigate({ screen: "project", id: currentProject.id })} aria-current="page">{currentProject.name}</button></>}</nav></div>
        <div className="topbar-actions"><ThemePicker /><button className={`local-status ${storageError ? "has-warning" : ""}`} onClick={() => setModal({ type: "storage-info" })}>{storageError ? <CircleAlert /> : <Monitor />}<span>На этом устройстве</span></button></div>
      </header>

      {storageError && <div className="storage-warning" role="alert"><CircleAlert /><p>{storageError}</p></div>}
      {!ready ? <main className="page-content loading"><span className="eyebrow">IDEA BANK</span><h1>Открываем библиотеку…</h1></main> : <main className={`page-content ${route.screen === "project" ? "project-page" : route.screen === "section" ? "section-page" : "library-page"}`}>
        {missing ? <div className="empty-state"><Folder /><h1 ref={heading} tabIndex={-1}>Здесь пока ничего нет</h1><p>Возможно, эта идея или раздел уже удалены.</p><button className="primary-button" onClick={() => navigate({ screen: "home" })}>К библиотеке</button></div> : route.screen === "project" && currentProject ? <>
          <div className="project-toolbar"><button className="back-button" onClick={() => navigate({ screen: "section", id: currentProject.sectionId })}><ArrowLeft />{currentSection?.name}</button><div className="project-actions">{!draft && <><button className="edit-button page-action-button" disabled={readOnly} onClick={() => { returnBlock.current = null; setDraft(structuredClone(currentProject)); }}><Pencil />Изменить</button><DropdownMenu label="Действия с идеей" disabled={readOnly} items={[
            { label: "Перенести в раздел", icon: <FolderInput />, onSelect: () => setModal({ type: "move-project", project: currentProject }) },
            { label: "Удалить идею", icon: <Trash2 />, danger: true, onSelect: () => setModal({ type: "delete-project", project: currentProject }) },
          ]} /></>}</div></div>
          <article className="document">
          {draft ? <form id="project-editor" onSubmit={saveProject}>
            <fieldset disabled={saving} className="project-fields">
            <label className="field-label" htmlFor="project-name">Название идеи</label><input id="project-name" className="title-input" value={draft.name} maxLength={100} required pattern=".*\S.*" onChange={e => setDraft({ ...draft, name: e.target.value })} />
            <label className="field-label" htmlFor="project-description">Краткое описание</label><textarea id="project-description" rows={3} maxLength={1000} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} />
            </fieldset>
            <p className="layout-help">Перетаскивай блоки за ручку ⠿ или меняй порядок стрелками. Выбери ширину карточек; на телефоне они выстроятся в один столбец.</p>
            <BlockEditor blocks={draft.blocks} onChange={blocks => setDraft(previous => previous ? { ...previous, blocks } : null)} pending={pendingMedia} onFiles={files => setPendingMedia(previous => new Map([...previous, ...files]))} onError={setMediaError} disabled={saving || importingMedia} onImporting={busy => { importingRef.current = busy; setImportingMedia(busy); }} onAdd={addBlock} />
            {mediaError && <p className="media-save-error" role="alert">{mediaError}</p>}
            {importingMedia && <p className="media-import-status" role="status">Подготавливаем медиа…</p>}
            <div className="editor-save"><EditorActions saving={saving || importingMedia} onCancel={cancelEditing} /></div>
          </form> : <><div className="project-summary"><h1 ref={heading} tabIndex={-1}>{currentProject.name}</h1>{currentProject.description && <p className="page-subtitle">{currentProject.description}</p>}</div><div className="document-rule" />{currentProject.blocks.length ? <ProjectBlocks blocks={currentProject.blocks} onEdit={editBlock} readOnly={readOnly} /> : <p className="muted">Здесь появятся первые мысли об этой идее.</p>}
            <button className="add-block-button" disabled={readOnly} onClick={addBlock}><Plus />Добавить блок</button></>}
          </article>
        </> : <>
          <div className="project-toolbar section-back-toolbar">{route.screen === "section" ? <button className="back-button" onClick={() => navigate({ screen: "home" })}><ArrowLeft />Библиотека</button> : <span />}<div className="project-actions"><button className="primary-button page-action-button" disabled={readOnly || !library.sections.length} onClick={() => setModal({ type: "new-project", sectionId: currentSection?.id || library.sections[0].id })}><Plus />Идея</button>{route.screen === "section" && currentSection && sectionMenu(currentSection)}</div></div>
          <div className="page-heading"><div><h1 ref={heading} tabIndex={-1}>{route.screen === "home" ? <><span className="desktop-title">Все твои идеи.<br />В одном месте.</span><span className="mobile-title">У каждой идеи<br />есть своё место.</span></> : currentSection?.name}</h1><p className="page-subtitle">{route.screen === "home" ? "От случайной мысли до следующей большой идеи." : currentSection?.description}</p></div>
          </div>

          {route.screen === "home" && <section className="sections-area" aria-labelledby="sections-heading"><div className="section-heading"><h2 id="sections-heading">Мои разделы</h2></div><div className="section-grid">{library.sections.map(s => <div className="section-card" key={s.id}><button className="section-open" onClick={() => navigate({ screen: "section", id: s.id })}><span className="section-symbol"><SectionSymbol icon={s.icon} /></span><span><strong>{s.name}</strong><small>Идей: {projectCount(s.id)}</small></span></button>{sectionMenu(s, `Действия с разделом ${s.name}`)}</div>)}<button className="new-section-card" disabled={readOnly} onClick={() => setModal({ type: "new-section" })}><Plus /><span>Создать раздел</span></button></div></section>}

          <section className={`projects-area ${route.screen === "home" && !query ? "home-projects" : ""}`} aria-label="Идеи"><div className="projects-toolbar"><label className="search-field idea-search"><Search /><input type="search" aria-label="Найти идею" placeholder="Найти идею" value={query} onChange={e => setQuery(e.target.value)} /></label><span>Идей: {visibleProjects.length}</span></div>{projectCards()}{!visibleProjects.length && <div className="empty-inline"><p>{query ? "Таких идей пока нет. Попробуй другое название." : "Место для твоей следующей идеи."}</p></div>}</section>
          {route.screen === "home" && !!recentProjects.length && !query && <section className="recent-project"><h2>Последние идеи</h2><div className="recent-project-list">{recentProjects.map(project => <button key={project.id} onClick={() => navigate({ screen: "project", id: project.id })}><CoverArt cover={project.cover} image={project.coverImage} title={project.name} small /><span><strong>{project.name}</strong><small>{library.sections.find(s => s.id === project.sectionId)?.name}</small></span><ArrowUpRight /></button>)}</div></section>}
        </>}
      </main>}
      <div className="notice" role="status" aria-live="polite">{message}</div>
      <footer className="app-footer"><span><LockKeyhole />Личная библиотека</span><button onClick={() => setModal({ type: "storage-info" })}>Локальная версия <ArrowUpRight /></button></footer>
    </div>

    {modal && <Dialog title={modalTitle(modal)} closeDisabled={backupBusy} onClose={() => { if (!savingRef.current) setModal(null); }}>
      {modal.type === "new-section" || modal.type === "edit-section" ? <SectionForm section={modal.type === "edit-section" ? modal.section : undefined} onCancel={() => setModal(null)} onSave={values => {
        const section: Section = modal.type === "edit-section" ? { ...modal.section, ...values } : { id: createId(), ...values };
        commit({ ...library, sections: modal.type === "edit-section" ? library.sections.map(s => s.id === section.id ? section : s) : [...library.sections, section] }, modal.type === "edit-section" ? "Раздел обновлён." : "Раздел создан."); setModal(null);
      }} /> : modal.type === "new-project" || modal.type === "edit-project" ? <ProjectForm sections={library.sections} initialSectionId={modal.type === "new-project" ? modal.sectionId : modal.project.sectionId} project={modal.type === "edit-project" ? modal.project : undefined} onCancel={() => setModal(null)} onSave={async (values, coverFile) => {
        const project: Project = modal.type === "edit-project" ? { ...modal.project, ...values, updatedAt: new Date().toISOString() } : { id: createId(), ...values, blocks: [], updatedAt: new Date().toISOString() };
        savingRef.current = true;
        try {
        if (coverFile && project.coverImage) await saveMediaFiles(new Map([[project.coverImage.id, coverFile]]));
        savingRef.current = false;
        const success = commit({ ...library, projects: modal.type === "edit-project" ? library.projects.map(p => p.id === project.id ? project : p) : [...library.projects, project] }, "Идея сохранена в этом браузере.");
        if (success) { setModal(null); if (modal.type === "new-project") navigate({ screen: "project", id: project.id }); }
        return success;
        } finally { savingRef.current = false; }
      }} />
      : modal.type === "delete-section" ? <><p className="dialog-description">Удалить «{modal.section.name}»? Вместе с разделом будут удалены все его идеи ({projectCount(modal.section.id)}). Это действие нельзя отменить.</p><div className="form-actions"><button className="secondary-button" onClick={() => setModal(null)}>Отмена</button><button className="danger-button" onClick={() => removeSection(modal.section)}>Удалить раздел</button></div></>
      : modal.type === "delete-project" ? <><p className="dialog-description">Удалить «{modal.project.name}» и все её текстовые блоки? Это действие нельзя отменить.</p><div className="form-actions"><button className="secondary-button" onClick={() => setModal(null)}>Отмена</button><button className="danger-button" onClick={() => removeProject(modal.project)}>Удалить идею</button></div></>
      : modal.type === "move-project" ? <div className="menu-options">{library.sections.map(s => <button disabled={s.id === modal.project.sectionId} key={s.id} onClick={() => { const moved = { ...modal.project, sectionId: s.id, updatedAt: new Date().toISOString() }; commit({ ...library, projects: library.projects.map(p => p.id === moved.id ? moved : p) }, "Идея перенесена."); setModal(null); }}><SectionSymbol icon={s.icon} /><span>{s.name}</span>{s.id === modal.project.sectionId && <Check />}</button>)}</div>
      : <><div className="storage-info-icon"><Monitor /></div><p className="dialog-description">Изменения и медиа сохраняются в текущем браузере на этом устройстве. Данные других устройств пока не синхронизируются.</p><p className="dialog-description">GitHub и вход в аккаунт пока не подключены. Очистка данных сайта в браузере удалит локальную библиотеку и вложения.</p><BackupControls library={library} locked={!!draft || importingMedia} readOnly={readOnly} onBusyChange={busy => { savingRef.current = busy; setBackupBusy(busy); }} onRestored={next => {
        setLibrary(next); setReadOnly(false); setStorageError(""); setDraft(null); setPendingMedia(new Map()); setMediaError(""); setQuery(""); setSidebarQuery(""); setExpandedSections({});
        setRoute({ screen: "home" }); history.replaceState(null, "", "#/"); setModal(null); setMessage("Библиотека и медиа восстановлены из архива."); window.scrollTo({ top: 0, behavior: "instant" });
      }} /><button className="primary-button full-width" disabled={backupBusy} onClick={() => setModal(null)}>Понятно</button></>}
    </Dialog>}
  </div>;
}

function modalTitle(modal: Modal): string {
  switch (modal.type) {
    case "new-section": return "Новый раздел";
    case "edit-section": return "Изменить раздел";
    case "new-project": return "Новая идея";
    case "edit-project": return "Название и обложка";
    case "delete-section": return "Удалить раздел?";
    case "delete-project": return "Удалить идею?";
    case "move-project": return "Перенести в раздел";
    case "storage-info": return "Где хранятся идеи";
  }
}

function SectionForm({ section, onSave, onCancel }: { section?: Section; onSave: (values: Pick<Section, "name" | "description" | "icon">) => void; onCancel: () => void }) {
  const [name, setName] = useState(section?.name || "");
  const [description, setDescription] = useState(section?.description || "");
  const [icon, setIcon] = useState<SectionIcon>(section?.icon || "folder");
  return <form className="section-form" onSubmit={e => { e.preventDefault(); if (name.trim()) onSave({ name: name.trim(), description: description.trim(), icon }); }}>
    <label className="field-label" htmlFor="section-name">Название</label><input autoFocus id="section-name" required maxLength={70} pattern=".*\S.*" value={name} placeholder="Например, Gamedev" onChange={e => setName(e.target.value)} />
    <label className="field-label" htmlFor="section-description">Описание <span>необязательно</span></label><textarea id="section-description" rows={2} maxLength={300} value={description} placeholder="Какие идеи будут здесь жить?" onChange={e => setDescription(e.target.value)} />
    <fieldset className="icon-picker"><legend>Значок раздела</legend>{(Object.keys(sectionIcons) as SectionIcon[]).map(value => <button type="button" className={`icon-button ${icon === value ? "chosen" : ""}`} key={value} aria-label={{ gamepad: "Игры", book: "Обучение", code: "Программирование", folder: "Папка", lightbulb: "Идеи", palette: "Творчество", rocket: "Ракета" }[value]} aria-pressed={icon === value} onClick={() => setIcon(value)}><SectionSymbol icon={value} /></button>)}</fieldset>
    <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="primary-button" type="submit">{section ? "Сохранить" : "Создать раздел"}</button></div>
  </form>;
}

function ProjectForm({ sections, initialSectionId, project, onSave, onCancel }: { sections: Section[]; initialSectionId: string; project?: Project; onSave: (values: Pick<Project, "name" | "description" | "cover" | "coverImage" | "sectionId">, file?: File) => Promise<boolean>; onCancel: () => void }) {
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
    try { if (!await onSave({ name: name.trim(), description: description.trim(), sectionId, cover, coverImage }, coverFile)) setError("Не удалось сохранить идею. Попробуй ещё раз."); }
    catch { setError("Не удалось сохранить обложку в браузере. Попробуй ещё раз или выбери готовую."); }
    finally { setSubmitting(false); }
  }}><fieldset disabled={submitting || readingCover}>
    <label className="field-label" htmlFor="new-project-name">Название</label><input autoFocus id="new-project-name" required maxLength={100} pattern=".*\S.*" value={name} placeholder="Как называется твоя идея?" onChange={e => setName(e.target.value)} />
    <label className="field-label" htmlFor="new-project-description">Краткое описание <span>необязательно</span></label><textarea id="new-project-description" maxLength={1000} rows={2} value={description} onChange={e => setDescription(e.target.value)} />
    <label className="field-label" htmlFor="new-project-section">Раздел</label><select id="new-project-section" value={sectionId} onChange={e => setSectionId(e.target.value)}>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
    <fieldset className="cover-picker"><legend>Обложка <span className="cover-size-hint">(рекомендуется 800 × 800 px)</span></legend>{(Object.keys(coverNames) as Cover[]).filter(value => value !== "sand").map(value => <button type="button" className={!coverImage && cover === value ? "chosen" : ""} key={value} aria-label={coverNames[value]} aria-pressed={!coverImage && cover === value} onClick={() => { setCover(value); setCoverImage(undefined); setCoverFile(undefined); }}><CoverArt cover={value} small />{!coverImage && cover === value && <Check />}</button>)}
      <label className={`upload-cover ${coverImage ? "chosen" : ""}`}>{coverImage ? <CoverArt cover={cover} image={coverImage} file={coverFile} small /> : <ImagePlus />}<input type="file" accept="image/*" aria-label="Загрузить свою обложку" onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
        const asset = describeMediaFile(file);
        if (!asset || asset.kind !== "image") { setError("Выбери изображение PNG, JPEG, WebP или GIF."); return; }
        setReadingCover(true);
        try { const image = await createImageBitmap(file); image.close(); setCoverImage(asset); setCoverFile(file); setError(""); }
        catch { setError("Не удалось открыть это изображение. Выбери другой файл."); }
        finally { setReadingCover(false); }
      }} /><span className="sr-only">Своя обложка</span></label>
    </fieldset>
    {coverImage && <p className="cover-file-name">{coverImage.name}</p>}
    {error && <p className="media-save-error" role="alert">{error}</p>}
    <div className="form-actions"><button className="secondary-button" type="button" onClick={onCancel}>Отмена</button><button className="primary-button" type="submit">{submitting ? "Сохраняем…" : project ? "Сохранить" : "Создать идею"}</button></div></fieldset>
  </form>;
}

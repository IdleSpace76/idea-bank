import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { lstatSync,readdirSync,unlinkSync } from "node:fs";
import path from "node:path";
import { parseLibrary,summarizeIdea,type Library,type Project,type Section,type MediaAsset,type IdeaSummary,type TextBlock } from "./ideas";
import { stable } from "./entity-sync";
import { readDiskSettings,type DiskSettings } from "./disk-settings";
import { DiskMediaStore,type DiskMediaInput,type DiskMediaRecord } from "./disk-media";

const applicationId=0x4944424b,schemaVersion=3;
type JsonRow={document:string;revision:number};
export type DiskState={revision:number;initialized:boolean};
export type DiskChanges={sections?:Section[];ideas?:Project[];deleteSections?:string[];deleteIdeas?:string[];settleDrafts?:{id:string;revision:string|null}[]};
export type DiskPage={sections:Section[];ideas:IdeaSummary[];counts:Record<string,number>;total:number;revision:number;initialized:boolean;nextOffset:number|null};
export type DiskDraft={base:Project;project:Project;revision:string;savedAt:string};
export type DiskDraftContext={instance:string|null;head:string|null;draft:DiskDraft|null};
export class DiskStorageError extends Error {constructor(readonly code:"STALE_WRITE"|"MISSING_MEDIA"|"MEDIA_CHANGED"|"INVALID_DATA"|"INVALID_DATABASE",message:string){super(message);}}
const stale=()=>new DiskStorageError("STALE_WRITE","Данные изменились в другом окне. Сохранение остановлено, чтобы не потерять изменения.");
const invalid=(message="Некорректные данные библиотеки.")=>new DiskStorageError("INVALID_DATA",message);
function assets(ideas:Project[]) {
  const result=new Map<string,MediaAsset>();
  for(const idea of ideas)for(const asset of [...(idea.coverImage?[idea.coverImage]:[]),...idea.blocks.flatMap(block=>block.media || [])]){
    const previous=result.get(asset.id);if(previous && (previous.size!==asset.size || previous.mime!==asset.mime || previous.kind!==asset.kind))throw invalid("Несовместимые ссылки на медиафайл.");result.set(asset.id,asset);
  }return result;
}
function checkedProject(project:Project):Project {
  return parseLibrary(JSON.stringify({version:1,sections:[{id:project.sectionId,name:"Validation",description:"",icon:"folder"}],projects:[project]})).projects[0];
}
function unique(ids:string[]) {if(ids.some(id=>typeof id!=="string" || !id.trim()) || new Set(ids).size!==ids.length)throw invalid();}

/** Server-side disk backend. Opening it is explicit; importing the module creates no files. */
export class DiskLibraryStore {
  readonly media:DiskMediaStore;
  private constructor(readonly settings:DiskSettings,private readonly db:Database.Database){this.media=new DiskMediaStore(settings);}
  static async open(env:NodeJS.ProcessEnv=process.env):Promise<DiskLibraryStore> {
    const settings=readDiskSettings(env),media=new DiskMediaStore(settings);await media.initialize();
    try{const stat=lstatSync(settings.database);if(!stat.isFile() || stat.isSymbolicLink())throw invalid("База должна быть обычным файлом.");}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const db=new Database(settings.database,{timeout:5000});
    try{
      const id=db.pragma("application_id",{simple:true}),version=db.pragma("user_version",{simple:true});
      const tables=(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as {count:number}).count;
      if(id!==applicationId && (id!==0 || version!==0 || tables!==0) || id===applicationId && ![1,2,schemaVersion].includes(version as number))throw new DiskStorageError("INVALID_DATABASE","Неизвестный формат дисковой библиотеки. Файл оставлен без изменений.");
      db.pragma("foreign_keys = ON");db.pragma("journal_mode = WAL");db.pragma("synchronous = FULL");
      if(id===0)db.transaction(()=>{
        if(db.pragma("application_id",{simple:true})!==0)return;
        db.exec(`
          CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,initialized INTEGER NOT NULL) STRICT;
          INSERT INTO app_state VALUES (1,0,0);
          CREATE TABLE sections (id TEXT PRIMARY KEY,position INTEGER NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),revision INTEGER NOT NULL) STRICT;
          CREATE TABLE ideas (id TEXT PRIMARY KEY,section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,search_text TEXT NOT NULL,updated_at INTEGER NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),revision INTEGER NOT NULL) STRICT;
          CREATE INDEX ideas_order ON ideas(updated_at DESC,id);
          CREATE INDEX ideas_section ON ideas(section_id,updated_at DESC,id);
          CREATE TABLE blocks (idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,id TEXT NOT NULL,position INTEGER NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),PRIMARY KEY(idea_id,id)) STRICT;
          CREATE TABLE media (id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL) STRICT;
          CREATE TABLE idea_media (idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,media_id TEXT NOT NULL REFERENCES media(id),PRIMARY KEY(idea_id,media_id)) STRICT;
          CREATE TABLE drafts (idea_id TEXT PRIMARY KEY,revision TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document)),saved_at TEXT NOT NULL) STRICT;
          CREATE TABLE draft_media (idea_id TEXT NOT NULL REFERENCES drafts(idea_id) ON DELETE CASCADE,media_id TEXT NOT NULL REFERENCES media(id),PRIMARY KEY(idea_id,media_id)) STRICT;
          PRAGMA application_id = ${applicationId};PRAGMA user_version = 1;
        `);
      }).immediate();
      if(db.pragma("user_version",{simple:true})===1)db.transaction(()=>{
        if(db.pragma("user_version",{simple:true})!==1)return;
        db.exec("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,revision INTEGER NOT NULL) STRICT;PRAGMA user_version = 2;");
      }).immediate();
      if(db.pragma("user_version",{simple:true})===2)db.transaction(()=>{
        if(db.pragma("user_version",{simple:true})!==2)return;
        db.exec("ALTER TABLE ideas ADD COLUMN incarnation TEXT NOT NULL DEFAULT '';CREATE TABLE draft_heads (idea_id TEXT PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,revision TEXT NOT NULL) STRICT;CREATE TABLE media_leases (token TEXT NOT NULL,sha256 TEXT NOT NULL,pid INTEGER NOT NULL,expires INTEGER NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(token,sha256)) STRICT;DELETE FROM drafts WHERE idea_id NOT IN (SELECT id FROM ideas);INSERT INTO draft_heads SELECT idea_id,revision FROM drafts;");
        for(const row of db.prepare("SELECT id FROM ideas").all() as {id:string}[])db.prepare("UPDATE ideas SET incarnation=? WHERE id=?").run(randomUUID(),row.id);
        db.pragma("user_version = 3");
      }).immediate();
      const store=new DiskLibraryStore(settings,db);store.readState();return store;
    }catch(error){db.close();throw error;}
  }
  close(){this.db.close();}
  readOperation(id:string){return this.db.prepare("SELECT fingerprint,revision FROM operations WHERE id=?").get(id) as {fingerprint:string;revision:number}|undefined;}
  hasIdea(id:string){return !!this.db.prepare("SELECT 1 FROM ideas WHERE id=?").get(id);}
  readState():DiskState {
    const state=this.db.prepare("SELECT revision,initialized FROM app_state WHERE id=1").get() as {revision:number;initialized:number}|undefined;
    if(!state || !Number.isSafeInteger(state.revision) || state.revision<0 || ![0,1].includes(state.initialized))throw new DiskStorageError("INVALID_DATABASE","Повреждены настройки дисковой библиотеки.");
    return {revision:state.revision,initialized:state.initialized===1};
  }
  readSections():Section[] {return (this.db.prepare("SELECT document FROM sections ORDER BY position,id").all() as JsonRow[]).map(row=>JSON.parse(row.document));}
  /** SQL pagination returns metadata only, even for a library with many large bodies. */
  readPage(options:{limit?:number;offset?:number;sectionId?:string;query?:string}={}):DiskPage {
    const limit=options.limit??24,offset=options.offset??0;
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0)throw invalid("Некорректная страница каталога.");
    return this.db.transaction(()=>{
      const conditions:string[]=[],parameters:unknown[]=[];
      if(options.sectionId){conditions.push("section_id = ?");parameters.push(options.sectionId);}
      if(options.query?.trim()){
        const query=options.query.trim().toLowerCase().replace(/[\\%_]/g,"\\$&");
        conditions.push("search_text LIKE ? ESCAPE '\\'");parameters.push(`%${query}%`);
      }
      const where=conditions.length?` WHERE ${conditions.join(" AND ")}`:"";
      const total=(this.db.prepare(`SELECT count(*) AS count FROM ideas${where}`).get(...parameters) as {count:number}).count;
      const ideas=(this.db.prepare(`SELECT document FROM ideas${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...parameters,limit,offset) as JsonRow[]).map(row=>JSON.parse(row.document) as IdeaSummary);
      const counts=Object.fromEntries((this.db.prepare("SELECT sections.id AS section_id,count(ideas.id) AS count FROM sections LEFT JOIN ideas ON ideas.section_id=sections.id GROUP BY sections.id").all() as {section_id:string;count:number}[]).map(row=>[row.section_id,row.count]));
      return {sections:this.readSections(),ideas,counts,total,...this.readState(),nextOffset:offset+ideas.length<total?offset+ideas.length:null};
    })();
  }
  private ideaIn(id:string):{idea:Project;revision:number}|undefined {
    const saved=this.db.prepare("SELECT document,revision FROM ideas WHERE id=?").get(id) as JsonRow|undefined;if(!saved)return;
    const blocks=(this.db.prepare("SELECT document FROM blocks WHERE idea_id=? ORDER BY position,id").all(id) as JsonRow[]).map(row=>JSON.parse(row.document) as TextBlock);
    return {idea:checkedProject({...JSON.parse(saved.document),blocks}),revision:saved.revision};
  }
  readIdea(id:string){return this.db.transaction(()=>this.ideaIn(id))();}
  readIdeaSnapshot(id:string){return this.db.transaction(()=>{const saved=this.ideaIn(id);return saved?{...saved,libraryRevision:this.readState().revision}:undefined;})();}
  /** Explicit whole-library snapshots are available for later ZIP integration. */
  readSnapshot():{library:Library;revision:number;initialized:boolean} {
    return this.db.transaction(()=>{
      const ids=this.db.prepare("SELECT id FROM ideas ORDER BY updated_at DESC,id").all() as {id:string}[];
      return {library:{version:1 as const,sections:this.readSections(),projects:ids.map(({id})=>this.ideaIn(id)!.idea)},...this.readState()};
    })();
  }
  readMedia(id:string):(DiskMediaRecord & {path:string})|undefined {
    const record=this.db.prepare("SELECT id,size,mime,sha256 FROM media WHERE id=?").get(id) as DiskMediaRecord|undefined;
    if(!record)return;this.assertFile(record);return {...record,path:this.media.filePath(record.sha256)};
  }
  private assertFile(record:DiskMediaRecord) {
    let stat;try{stat=lstatSync(this.media.filePath(record.sha256));}catch{throw new DiskStorageError("MISSING_MEDIA","Не найден сохранённый медиафайл.");}
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size!==record.size)throw new DiskStorageError("MISSING_MEDIA","Сохранённый медиафайл повреждён.");
  }
  private async prepareFiles(required:Map<string,MediaAsset>,files:DiskMediaInput[]) {
    unique(files.map(file=>file.id));const prepared=new Map<string,DiskMediaRecord>(),lease=randomUUID();
    try{
      for(const file of files){const asset=required.get(file.id);if(!asset || asset.size!==file.size || asset.mime!==file.mime)throw invalid("Медиафайл не соответствует содержимому идеи.");prepared.set(file.id,await this.media.prepare(file,hash=>{this.db.prepare("INSERT OR IGNORE INTO media_leases VALUES (?,?,?,0,'upload')").run(lease,hash,process.pid);}));}
      return {prepared,lease};
    }catch(error){this.releaseFiles(lease);throw error;}
  }
  private releaseFiles(lease:string){this.db.prepare("DELETE FROM media_leases WHERE token=? AND kind='upload'").run(lease);}
  private attachMedia(required:Map<string,MediaAsset>,prepared:Map<string,DiskMediaRecord>) {
    for(const asset of required.values()){
      const old=this.db.prepare("SELECT id,size,mime,sha256 FROM media WHERE id=?").get(asset.id) as DiskMediaRecord|undefined,next=prepared.get(asset.id);
      if(old && (old.size!==asset.size || old.mime!==asset.mime || next && old.sha256!==next.sha256))throw new DiskStorageError("MEDIA_CHANGED","Идентификатор медиафайла уже связан с другими данными.");
      const record=next || old;if(!record)throw new DiskStorageError("MISSING_MEDIA","Не найден исходный медиафайл.");this.assertFile(record);
      if(!old)this.db.prepare("INSERT INTO media (id,sha256,size,mime) VALUES (?,?,?,?)").run(record.id,record.sha256,record.size,record.mime);
    }
  }
  /** Stage files outside SQL; the final revision check and all metadata changes share one transaction. */
  async commit(change:DiskChanges,expectedRevision:number,files:DiskMediaInput[]=[],operation?:{id:string;fingerprint:string}):Promise<number> {
    const replay=()=>{if(!operation)return;const old=this.readOperation(operation.id);if(old && old.fingerprint!==operation.fingerprint)throw invalid("Идентификатор операции уже использован.");return old?.revision;};
    if(operation && (!/^[a-f0-9-]{36}$/i.test(operation.id) || !/^[a-f0-9]{64}$/.test(operation.fingerprint)))throw invalid();
    const applied=replay();if(applied!==undefined)return applied;
    if(!Number.isSafeInteger(expectedRevision) || expectedRevision<0)throw invalid();
    const state=this.readState();if(state.revision!==expectedRevision)throw stale();
    const sections=change.sections || [],ideas=change.ideas || [],deletedSections=change.deleteSections || [],deletedIdeas=change.deleteIdeas || [];
    unique(sections.map(section=>section.id));unique(ideas.map(idea=>idea.id));unique(deletedSections);unique(deletedIdeas);
    if(sections.some(section=>deletedSections.includes(section.id)) || ideas.some(idea=>deletedIdeas.includes(idea.id)))throw invalid();
    const nextSections=new Map(this.readSections().filter(section=>!deletedSections.includes(section.id)).map(section=>[section.id,section]));for(const section of sections)nextSections.set(section.id,section);
    const checked=parseLibrary(JSON.stringify({version:1,sections:[...nextSections.values()],projects:ideas})),required=assets(checked.projects),{prepared,lease}=await this.prepareFiles(required,files);
    try{return this.db.transaction(()=>{
      const applied=replay();if(applied!==undefined)return applied;
      const current=this.readState();if(current.revision!==expectedRevision)throw stale();
      const revision=current.revision+1;if(!Number.isSafeInteger(revision))throw invalid("Исчерпан счётчик версий библиотеки.");let changed=!current.initialized;
      this.attachMedia(required,prepared);
      for(const section of checked.sections.filter(section=>sections.some(changed=>changed.id===section.id))){
        const old=this.db.prepare("SELECT document FROM sections WHERE id=?").get(section.id) as JsonRow|undefined,document=stable(section);if(old?.document===document)continue;
        if(old)this.db.prepare("UPDATE sections SET document=?,revision=? WHERE id=?").run(document,revision,section.id);
        else this.db.prepare("INSERT INTO sections(id,position,document,revision) VALUES (?,(SELECT coalesce(max(position),-1)+1 FROM sections),?,?)").run(section.id,document,revision);changed=true;
      }
      for(const idea of checked.projects){
        const old=this.ideaIn(idea.id);if(old && stable(old.idea)===stable(idea))continue;
        this.db.prepare("INSERT INTO ideas(id,section_id,search_text,updated_at,document,revision,incarnation) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET section_id=excluded.section_id,search_text=excluded.search_text,updated_at=excluded.updated_at,document=excluded.document,revision=excluded.revision").run(idea.id,idea.sectionId,`${idea.name}\n${idea.description}`.toLowerCase(),Date.parse(idea.updatedAt),stable(summarizeIdea(idea)),revision,randomUUID());
        this.db.prepare("DELETE FROM blocks WHERE idea_id=?").run(idea.id);this.db.prepare("DELETE FROM idea_media WHERE idea_id=?").run(idea.id);
        idea.blocks.forEach((block,index)=>this.db.prepare("INSERT INTO blocks(idea_id,id,position,document) VALUES (?,?,?,?)").run(idea.id,block.id,index,stable(block)));
        for(const id of assets([idea]).keys())this.db.prepare("INSERT INTO idea_media(idea_id,media_id) VALUES (?,?)").run(idea.id,id);changed=true;
      }
      for(const item of change.settleDrafts || [])if(this.draftHead(item.id)===item.revision && this.hasIdea(item.id)){this.db.prepare("DELETE FROM drafts WHERE idea_id=?").run(item.id);this.setDraftHead(item.id,randomUUID());}
      for(const id of deletedIdeas){this.db.prepare("DELETE FROM drafts WHERE idea_id=?").run(id);if(this.db.prepare("DELETE FROM ideas WHERE id=?").run(id).changes)changed=true;}
      for(const id of deletedSections){this.db.prepare("DELETE FROM drafts WHERE idea_id IN (SELECT id FROM ideas WHERE section_id=?)").run(id);if(this.db.prepare("DELETE FROM sections WHERE id=?").run(id).changes)changed=true;}
      if(changed)this.db.prepare("UPDATE app_state SET revision=?,initialized=1 WHERE id=1").run(revision);
      if(operation){
        this.db.prepare("INSERT INTO operations(id,fingerprint,revision) VALUES (?,?,?)").run(operation.id,operation.fingerprint,changed?revision:current.revision);
        this.db.exec("DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations ORDER BY rowid DESC LIMIT -1 OFFSET 256)");
      }
      return changed?revision:current.revision;
    }).immediate();}finally{this.releaseFiles(lease);}
  }
  private draftHead(id:string){return (this.db.prepare("SELECT revision FROM draft_heads WHERE idea_id=?").get(id) as {revision:string}|undefined)?.revision || null;}
  private setDraftHead(id:string,revision:string){this.db.prepare("INSERT INTO draft_heads VALUES (?,?) ON CONFLICT(idea_id) DO UPDATE SET revision=excluded.revision").run(id,revision);}
  readDraftContext(id:string):DiskDraftContext{return this.db.transaction(()=>{const idea=this.db.prepare("SELECT incarnation FROM ideas WHERE id=?").get(id) as {incarnation:string}|undefined;return {instance:idea?.incarnation || null,head:this.draftHead(id),draft:this.readDraft(id) || null};})();}
  readDraft(id:string):DiskDraft|undefined {
    const saved=this.db.prepare("SELECT document,revision,saved_at FROM drafts WHERE idea_id=?").get(id) as {document:string;revision:string;saved_at:string}|undefined;
    if(saved){const value=JSON.parse(saved.document);if(value.base?.id!==id || value.project?.id!==id)throw new DiskStorageError("INVALID_DATABASE","Повреждён сохранённый черновик.");return {base:checkedProject(value.base),project:checkedProject(value.project),revision:saved.revision,savedAt:saved.saved_at};}
  }
  async saveDraft(base:Project,project:Project,expected:string|null,files:DiskMediaInput[]=[],session?:{instance:string;next:string}):Promise<DiskDraft> {
    base=checkedProject(base);project=checkedProject(project);if(base.id!==project.id)throw invalid();
    const document=stable({base,project}),next=session?.next || randomUUID();
    const check=()=>{const context=this.readDraftContext(project.id);if(!context.instance || session && context.instance!==session.instance)throw stale();if(context.draft?.revision===next && stable({base:context.draft.base,project:context.draft.project})===document)return context.draft;if(context.head!==expected)throw stale();};
    const replay=check();if(replay)return replay;
    const required=assets([base,project]),{prepared,lease}=await this.prepareFiles(required,files);
    try{return this.db.transaction(()=>{
      const replay=check();if(replay)return replay;const old=this.readDraft(project.id);
      this.attachMedia(required,prepared);
      if(old && stable({base:old.base,project:old.project})===document)return old;
      const revision=next,savedAt=new Date().toISOString();
      this.db.prepare("INSERT INTO drafts(idea_id,revision,document,saved_at) VALUES (?,?,?,?) ON CONFLICT(idea_id) DO UPDATE SET revision=excluded.revision,document=excluded.document,saved_at=excluded.saved_at").run(project.id,revision,document,savedAt);
      this.db.prepare("DELETE FROM draft_media WHERE idea_id=?").run(project.id);
      for(const id of required.keys())this.db.prepare("INSERT INTO draft_media(idea_id,media_id) VALUES (?,?)").run(project.id,id);
      this.setDraftHead(project.id,revision);
      return {base,project,revision,savedAt};
    }).immediate();}finally{this.releaseFiles(lease);}
  }
  removeDraft(id:string,expected:string|null,next:string=randomUUID(),instance?:string) {
    this.db.transaction(()=>{const context=this.readDraftContext(id);if(!context.instance || instance && context.instance!==instance)throw stale();if(context.head===next && !context.draft)return;if(context.head!==expected)throw stale();this.db.prepare("DELETE FROM drafts WHERE idea_id=?").run(id);this.setDraftHead(id,next);}).immediate();
  }
  /** Explicit reset never reads bodies or files, and invalidates all old draft instances. */
  clear(expected:number,operation:{id:string;fingerprint:string}){
    return this.db.transaction(()=>{
      const old=this.readOperation(operation.id);if(old){if(old.fingerprint!==operation.fingerprint)throw invalid();return old.revision;}
      const state=this.readState();if(state.revision!==expected)throw stale();
      this.db.exec("DELETE FROM drafts;DELETE FROM sections;");
      const revision=state.revision+1;this.db.prepare("UPDATE app_state SET revision=?,initialized=1 WHERE id=1").run(revision);
      this.db.prepare("INSERT INTO operations VALUES (?,?,?)").run(operation.id,operation.fingerprint,revision);this.db.exec("DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations ORDER BY rowid DESC LIMIT -1 OFFSET 256)");return revision;
    }).immediate();
  }
  /** Pin an immutable ZIP snapshot while the browser reads its files. */
  beginBackup(){return this.db.transaction(()=>{const snapshot=this.readSnapshot(),token=randomUUID();for(const file of assets(snapshot.library.projects).values()){const media=this.readMedia(file.id);if(!media)throw new DiskStorageError("MISSING_MEDIA","Не найден сохранённый медиафайл.");this.db.prepare("INSERT OR IGNORE INTO media_leases VALUES (?,?,?,?,'backup')").run(token,media.sha256,process.pid,Date.now()+900000);}return {...snapshot,token};}).immediate();}
  releaseBackup(token:string){this.db.prepare("DELETE FROM media_leases WHERE token=? AND kind='backup'").run(token);}
  renewBackup(token:string){this.db.prepare("UPDATE media_leases SET expires=? WHERE token=? AND kind='backup'").run(Date.now()+900000,token);}
  /** The SQL write lock fences publication leases; only app-owned regular files are removed. */
  collectGarbage(){return this.db.transaction(()=>{
    const living=new Map<number,boolean>(),alive=(pid:number)=>{if(living.has(pid))return living.get(pid)!;let result=true;if(Number.isSafeInteger(pid) && pid>0)try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==="ESRCH")result=false;}living.set(pid,result);return result;};
    const leases=this.db.prepare("SELECT token,pid,expires,kind FROM media_leases").all() as {token:string;pid:number;expires:number;kind:string}[];
    for(const lease of leases)if(lease.kind==="upload" && !alive(lease.pid) || lease.kind==="backup" && lease.expires<Date.now())this.db.prepare("DELETE FROM media_leases WHERE token=?").run(lease.token);
    this.db.exec("DELETE FROM media WHERE NOT EXISTS (SELECT 1 FROM idea_media WHERE media_id=media.id) AND NOT EXISTS (SELECT 1 FROM draft_media WHERE media_id=media.id) AND NOT EXISTS (SELECT 1 FROM media_leases WHERE sha256=media.sha256)");
    const kept=new Set((this.db.prepare("SELECT sha256 FROM media UNION SELECT sha256 FROM media_leases").all() as {sha256:string}[]).map(row=>row.sha256));let files=0,bytes=0;
    const remove=(directory:string,name:string)=>{const target=path.resolve(directory,name),relative=path.relative(directory,target);if(!relative || relative.startsWith("..") || path.isAbsolute(relative))throw invalid();const stat=lstatSync(target);if(!stat.isFile() || stat.isSymbolicLink())return;try{unlinkSync(target);files++;bytes+=stat.size;}catch(error){if(!["ENOENT","EBUSY","EPERM","EACCES"].includes((error as NodeJS.ErrnoException).code || ""))throw error;}};
    for(const entry of readdirSync(this.settings.media,{withFileTypes:true}))if(entry.isFile() && /^[a-f0-9]{64}\.bin$/.test(entry.name) && !kept.has(entry.name.slice(0,64)))remove(this.settings.media,entry.name);
    for(const entry of readdirSync(this.settings.temporary,{withFileTypes:true})){const owner=/^(\d+)-[a-f0-9-]{36}\.tmp$/.exec(entry.name);if(entry.isFile() && owner && !alive(Number(owner[1])))remove(this.settings.temporary,entry.name);}
    return {files,bytes};
  }).immediate();}
  }

import { DiskLibraryStore,DiskStorageError } from "./disk-library";
import { type Project,type Section } from "./ideas";
import { AgentError,applyIdeaPatch,checkedIdea,decodeVersion,encodeVersion,fingerprint,missing,operationId,type AgentBackend,type AgentFile,type EditVersion,type IdeaPatch } from "./mcp-domain";

/** Uses the exact SQLite transaction and replay receipts used by the application. */
export class LocalAgentBackend implements AgentBackend {
  readonly mode="local" as const;
  readonly scope:string;
  constructor(readonly db:DiskLibraryStore,readonly owns=false){this.scope=fingerprint(["disk",db.settings.root]);}
  async sections(){return this.db.readSections();}
  async page(options:{limit:number;cursor?:string;sectionId?:string}){
    let cursor:{offset:number;revision:number;sectionId?:string}|undefined;
    try{cursor=options.cursor?JSON.parse(Buffer.from(options.cursor,"base64url").toString()):undefined;if(cursor && (!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.sectionId!==options.sectionId))throw 0;}catch{throw new AgentError("INVALID_CURSOR","Restart the search without a cursor.");}
    const page=this.db.readPage({limit:options.limit,offset:cursor?.offset,sectionId:options.sectionId});
    if(cursor && cursor.revision!==page.revision)throw new AgentError("STALE_CURSOR","The library changed. Restart the search.");
    return {ideas:page.ideas,cursor:page.nextOffset===null?null:Buffer.from(JSON.stringify({offset:page.nextOffset,revision:page.revision,sectionId:options.sectionId})).toString("base64url"),total:page.total,revision:String(page.revision)};
  }
  private response(idea:Project,revision:number){const value:EditVersion={v:1,mode:this.mode,scope:this.scope,id:idea.id,at:new Date().toISOString(),hash:fingerprint(idea),revision};return {idea,version:encodeVersion(value)};}
  async read(id:string){const saved=this.db.readIdeaSnapshot(id);if(!saved)throw missing();return this.response(saved.idea,saved.libraryRevision);}
  private replay(operation:string,hash:string){const old=this.db.readOperation(operation);if(old && old.fingerprint!==hash)throw new AgentError("OPERATION_REUSED","Use a new operation_id for a different change.");return !!old;}
  private async commit(...args:Parameters<DiskLibraryStore["commit"]>){try{return await this.db.commit(...args);}catch(error){if(error instanceof DiskStorageError && error.code==="STALE_WRITE")throw new AgentError("CONFLICT","The library changed during saving. Read the idea and review the change again.");throw error;}}
  async create(operation:string,input:Parameters<AgentBackend["create"]>[1]){
    const id=operationId(operation,"idea"),hash=fingerprint({action:"create",input});
    if(this.replay(operation,hash))return this.read(id);
    if(this.db.hasIdea(id))throw new AgentError("OPERATION_REUSED","This idea operation has already been used.",{idea_id:id});
    const state=this.db.readState(),idea=checkedIdea({id,sectionId:input.section_id,name:input.name,description:input.description || "",cover:input.cover || "forest",updatedAt:new Date().toISOString(),blocks:(input.blocks || []).map((block,index)=>({...block,id:operationId(operation,`initial-block:${index}`)}))},this.db.readSections());
    const revision=await this.commit({ideas:[idea]},state.revision,[],{id:operation,fingerprint:hash});return this.response(idea,revision);
  }
  async update(operation:string,id:string,rawVersion:string,patch:IdeaPatch,file?:AgentFile,placement?:{blockId?:string;cover?:boolean}){
    const hash=fingerprint({action:"update",id,rawVersion,patch,file:file?{asset:file.asset,sha256:file.sha256 || file.cloud?.sha256}:undefined,placement});
    if(this.replay(operation,hash))return this.read(id);
    const version=decodeVersion(rawVersion,this.scope,id),saved=this.db.readIdeaSnapshot(id);if(!saved)throw missing();
    if(version.mode!==this.mode || fingerprint(saved.idea)!==version.hash)throw new AgentError("CONFLICT","The idea changed. Read it again and review your changes.",{idea_id:id});
    const next=checkedIdea(applyIdeaPatch(saved.idea,patch,operation,version.at,file,placement),this.db.readSections());
    const revision=await this.commit({ideas:[next]},saved.libraryRevision,file?.disk?[file.disk]:[],{id:operation,fingerprint:hash});
    setTimeout(()=>{try{this.db.collectGarbage();}catch{}},25).unref();return this.response(next,revision);
  }
  async createSection(operation:string,input:Omit<Section,"id">){
    const id=operationId(operation,"section"),hash=fingerprint({action:"create-section",input});
    if(this.replay(operation,hash)){const old=this.db.readSections().find(section=>section.id===id);if(!old)throw new AgentError("NOT_FOUND","The created section has since been removed.");return old;}
    const section={id,...input};await this.commit({sections:[section]},this.db.readState().revision,[],{id:operation,fingerprint:hash});return section;
  }
  close(){if(this.owns)this.db.close();}
}

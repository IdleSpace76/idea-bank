import { B2Storage } from "./b2-storage";
import { EntityStorage } from "./entity-storage";
import { assembleLibrary,entityKey,flattenLibrary,keyParts,stable,type EntityMap,type EntityChange } from "./entity-sync";
import { saveAndNotify,publishSyncEvent } from "./sync-events-server";
import { type Library,type Project,type Section } from "./ideas";
import { AgentError,applyIdeaPatch,checkedIdea,decodeVersion,encodeVersion,fingerprint,operationId,type AgentBackend,type AgentFile,type EditVersion,type IdeaPatch } from "./mcp-domain";

export class CloudAgentBackend implements AgentBackend {
  readonly mode="github" as const;
  readonly scope:string;
  readonly entities:EntityStorage;
  constructor(readonly storage:B2Storage){this.entities=new EntityStorage(storage);this.scope=fingerprint(["cloud",storage.settings.endpoint,storage.settings.bucket,process.env.IDEA_BANK_OWNER_ID]);}
  async sections(){return (await this.entities.catalog().readSections()).flatMap(row=>{const section=row.variants.find((value):value is Section=>!!value);return section?[{...section,...(row.conflicted?{conflicted:true}:{})}]:[];});}
  async page(options:{limit:number;cursor?:string;sectionId?:string}){
    const page=await this.entities.catalog().readPage(options);
    return {ideas:page.ideas.flatMap(row=>{const idea=row.variants.find((value):value is Omit<Project,"blocks">=>!!value);return idea?[{...idea,...(row.conflicted?{conflicted:true}:{})}]:[];}),cursor:page.nextCursor,total:page.total,revision:page.revision};
  }
  private response(idea:Project,context:Pick<EditVersion,"heads"|"index">){return {idea,version:encodeVersion({v:1,mode:this.mode,scope:this.scope,id:idea.id,at:new Date().toISOString(),hash:fingerprint(idea),...context})};}
  async read(id:string){const value=await this.entities.catalog().readIdea(id);if(!("idea" in value))throw new AgentError("NOT_FOUND","The idea was not found.");return this.response(value.idea,{heads:value.editBase.heads,index:value.editBase.index});}
  private async base(raw:string,id:string){
    const version=decodeVersion(raw,this.scope,id);
    if(version.mode!==this.mode || !Array.isArray(version.heads) || version.heads.length>16 || !version.index || Object.keys(version.index).length>10000)throw new AgentError("INVALID_VERSION","Read the idea again.");
    const values:EntityMap={};
    for(const [key,refs] of Object.entries(version.index)){
      const part=keyParts(key);if(part.kind==="media" || part.kind!=="section" && part.ids[0]!==id || !Array.isArray(refs) || refs.length!==1)throw new AgentError("INVALID_VERSION","Read the idea again.");
      values[key]=(await this.entities.version(key,refs[0])).value;
    }
    const library=assembleLibrary(values),idea=library.projects.find(row=>row.id===id);
    if(!idea || fingerprint(idea)!==version.hash)throw new AgentError("INVALID_VERSION","The edit version does not match the idea.");
    return {version,library,idea,values};
  }
  private async save(operation:string,version:EditVersion,before:EntityMap,next:EntityMap){
    const changes:EntityChange[]=Object.keys({...before,...next}).filter(key=>stable(before[key] ?? null)!==stable(next[key] ?? null)).map(key=>({key,base:version.index?.[key] || [],value:next[key] ?? null}));
    if(!changes.length)return {heads:version.heads!,index:version.index!};
    const result=await saveAndNotify(()=>this.entities.save({operationId:operation,heads:version.heads || [],changes}),process.env,fetch,changes);
    const index={...version.index};for(const change of changes)index[change.key]=[result.revision];return {heads:[result.revision],index};
  }
  async create(operation:string,input:Parameters<AgentBackend["create"]>[1]){
    const id=operationId(operation,"idea"),read=await this.entities.readScoped({kind:"idea",id}),values:EntityMap={};
    if(Object.hasOwn(read.index,entityKey("idea",id))){
      const existing=await this.read(id);const supplied={name:input.name,description:input.description || "",sectionId:input.section_id,cover:input.cover || "forest",blocks:(input.blocks || []).map((block,index)=>({...block,id:operationId(operation,`initial-block:${index}`)}))};
      if(fingerprint({...existing.idea,id:"",updatedAt:""})!==fingerprint({...supplied,id:"",updatedAt:""}))throw new AgentError("OPERATION_REUSED","The idea was already created or changed. Do not create a duplicate.",{idea_id:id});
      if(read.heads[0])await publishSyncEvent(read.heads[0]);return existing;
    }
    for(const row of read.records){if((read.index[row.key] || []).length!==1)throw new AgentError("CONFLICT","Resolve the section conflict in Idea Bank first.");values[row.key]=row.value;}
    const library=assembleLibrary(values),idea=checkedIdea({id,sectionId:input.section_id,name:input.name,description:input.description || "",cover:input.cover || "forest",updatedAt:new Date().toISOString(),blocks:(input.blocks || []).map((block,index)=>({...block,id:operationId(operation,`initial-block:${index}`)}))},library.sections);
    const next=flattenLibrary({...library,projects:[idea]}),context=await this.save(operation,{v:1,mode:this.mode,scope:this.scope,id,at:idea.updatedAt,hash:fingerprint(idea),heads:read.heads,index:read.index},values,next);
    return this.response(idea,context);
  }
  async update(operation:string,id:string,raw:string,patch:IdeaPatch,file?:AgentFile,placement?:{blockId?:string;cover?:boolean}){
    const base=await this.base(raw,id);
    if(patch.section_id && !base.library.sections.some(row=>row.id===patch.section_id)){
      const sections=await this.entities.readScoped({kind:"section",id:patch.section_id});
      const record=sections.records.find(row=>row.key===entityKey("section",patch.section_id!));
      if(!record?.value || sections.index[record.key]?.length!==1)throw new AgentError("CONFLICT","The destination section is missing or conflicted.");
      base.library.sections.push(record.value as Section);base.values[record.key]=record.value;base.version.index![record.key]=[record.revision];
      // Keep the original frontier so a lost-response retry has the same operation digest.
      // The storage validator rejects a destination created/changed after that frontier.
    }
    const nextIdea=checkedIdea(applyIdeaPatch(base.idea,patch,operation,base.version.at,file,placement),base.library.sections),next=flattenLibrary({...base.library,projects:[nextIdea]});
    if(file?.cloud){
      const key=entityKey("media",file.cloud.id),refs=(await this.entities.catalogIndex(base.version.heads)).index[key] || [];
      // Reuse immutable shared media from the original frontier, including on a lost-response retry.
      if(refs.length){
        if(refs.length!==1)throw new AgentError("CONFLICT","The attachment metadata has conflicting versions.");
        const record=await this.entities.version(key,refs[0]);
        if(stable(record.value)!==stable(file.cloud))throw new AgentError("CONFLICT","The saved attachment metadata differs from this file.");
        base.values[key]=record.value;base.version.index![key]=refs;
      }
      next[key]=file.cloud;
    }
    const context=await this.save(operation,base.version,base.values,next);
    // File records are dependencies, not part of a future idea edit token.
    for(const key of Object.keys(context.index))if(keyParts(key).kind==="media")delete context.index[key];
    return this.response(nextIdea,context);
  }
  async createSection(operation:string,input:Omit<Section,"id">){
    const id=operationId(operation,"section"),read=await this.entities.readScoped({kind:"section",id}),key=entityKey("section",id),section={id,...input};
    if(read.index[key]){const old=read.records.find(row=>row.key===key)?.value;if(fingerprint(old)!==fingerprint(section))throw new AgentError("OPERATION_REUSED","This section operation has already been used.");return section;}
    await saveAndNotify(()=>this.entities.save({operationId:operation,heads:read.heads,changes:[{key,base:[],value:section}]}),process.env,fetch,[{key}]);return section;
  }
  close(){this.storage.client.destroy();}
}

import { createHash } from "node:crypto";
import { parseLibrary, type Project, type Section, type TextBlock, type MediaAsset } from "./ideas";
import { stable, type EntityIndex } from "./entity-sync";
import type { CloudMedia } from "./cloud-library";
import type { DiskMediaInput } from "./disk-media";

export class AgentError extends Error {
  constructor(readonly code:string,message:string,readonly details?:Record<string,unknown>){super(message);}
}
export const fingerprint=(value:unknown)=>createHash("sha256").update(stable(value)).digest("hex");
export function operationId(operation:string,label:string){const value=fingerprint(["idea-bank-mcp",operation,label]).slice(0,32).split("");value[12]="4";value[16]="8";const id=value.join("");return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;}
export type EditVersion={v:1;mode:"local"|"github";scope:string;id:string;at:string;hash:string;revision?:number;heads?:string[];index?:EntityIndex};
export const encodeVersion=(value:EditVersion)=>Buffer.from(JSON.stringify(value)).toString("base64url");
/** Version data is a causal edit base, never an authorization credential. */
export function decodeVersion(raw:string,scope:string,id:string):EditVersion {
  try{if(raw.length>64000)throw 0;const value=JSON.parse(Buffer.from(raw,"base64url").toString());if(value.v!==1 || value.scope!==scope || value.id!==id || !["local","github"].includes(value.mode) || typeof value.hash!=="string" || !/^[a-f0-9]{64}$/.test(value.hash) || !Number.isFinite(Date.parse(value.at)))throw 0;return value;}
  catch{throw new AgentError("INVALID_VERSION","Read the idea again to obtain a valid version.");}
}
export type AgentRead={idea:Project;version:string};
export type AgentFile={asset:MediaAsset;sha256?:string;cloud?:CloudMedia;disk?:DiskMediaInput};
export type BlockChange={action:"add"|"update"|"remove"|"move";id?:string;heading?:string;text?:string;width?:"full"|"half"|"third";text_position?:"above"|"below";heading_font_size?:number;before_id?:string};
export type IdeaPatch={name?:string;description?:string;section_id?:string;cover?:Project["cover"];block_changes?:BlockChange[]};
export type AgentBackend={
  mode:"local"|"github";scope:string;
  sections():Promise<Section[]>;
  page(options:{limit:number;cursor?:string;sectionId?:string}):Promise<{ideas:(Omit<Project,"blocks">&{conflicted?:boolean})[];cursor:string|null;total:number;revision:string}>;
  read(id:string):Promise<AgentRead>;
  create(operation:string,input:{section_id:string;name:string;description?:string;cover?:Project["cover"];blocks?:Omit<TextBlock,"id">[]}):Promise<AgentRead>;
  update(operation:string,id:string,version:string,patch:IdeaPatch,file?:AgentFile,placement?:{blockId?:string;cover?:boolean}):Promise<AgentRead>;
  createSection(operation:string,input:Omit<Section,"id">):Promise<Section>;
  close():void;
};
export function applyIdeaPatch(base:Project,patch:IdeaPatch,operation:string,at:string,file?:AgentFile,placement?:{blockId?:string;cover?:boolean}):Project {
  const next=structuredClone(base);
  if(patch.name!==undefined)next.name=patch.name;if(patch.description!==undefined)next.description=patch.description;
  if(patch.section_id!==undefined)next.sectionId=patch.section_id;if(patch.cover!==undefined){next.cover=patch.cover;delete next.coverImage;}
  for(const [index,change] of (patch.block_changes || []).entries()){
    let block=next.blocks.find(row=>row.id===change.id);
    if(change.action==="add"){
      block={id:operationId(operation,`block:${index}`),heading:change.heading || "",text:change.text || "",width:change.width || "full"};
      if(next.blocks.some(row=>row.id===block!.id))throw new AgentError("OPERATION_REUSED","This block operation has already been used.");
      next.blocks.push(block);
    }else if(!block)throw new AgentError("BLOCK_NOT_FOUND","The requested block does not exist.",{block_id:change.id});
    if(change.action==="remove"){next.blocks=next.blocks.filter(row=>row!==block);continue;}
    if(change.action==="add" || change.action==="update"){
      if(change.heading!==undefined)block.heading=change.heading;
      if(change.text!==undefined){block.text=change.text;delete block.richText;}
      if(change.width!==undefined)block.width=change.width;
      if(change.text_position!==undefined)block.textPosition=change.text_position;
      if(change.heading_font_size!==undefined)block.headingFontSize=change.heading_font_size;
    }
    if(change.action==="move" || change.before_id!==undefined){
      next.blocks=next.blocks.filter(row=>row!==block);const target=change.before_id?next.blocks.findIndex(row=>row.id===change.before_id):next.blocks.length;
      if(target<0)throw new AgentError("BLOCK_NOT_FOUND","The destination block does not exist.");next.blocks.splice(target,0,block);
    }
  }
  if(file){
    if(placement?.cover){if(file.asset.kind!=="image")throw new AgentError("INVALID_MEDIA","An idea cover must be an image.");next.coverImage=file.asset;}
    else{
      let block=placement?.blockId?next.blocks.find(row=>row.id===placement.blockId):undefined;
      if(placement?.blockId && !block)throw new AgentError("BLOCK_NOT_FOUND","The requested block does not exist.");
      if(!block){block={id:operationId(operation,"media-block"),heading:"",text:"",width:"full"};next.blocks.push(block);}
      if(!(block.media || []).some(asset=>asset.id===file.asset.id))block.media=[...(block.media || []),file.asset];
    }
  }
  if(fingerprint({...next,updatedAt:""})!==fingerprint({...base,updatedAt:""}))next.updatedAt=at;
  return next;
}
export function checkedIdea(idea:Project,sections:Section[]){try{return parseLibrary(JSON.stringify({version:1,sections,projects:[idea]})).projects[0];}catch{throw new AgentError("INVALID_IDEA","The idea, section or block data is invalid.");}}
export const missing=()=>new AgentError("NOT_FOUND","The idea was not found.");

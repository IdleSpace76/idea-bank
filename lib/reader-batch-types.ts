import type { CatalogPage } from "./catalog-storage";
import type { EntityIndex,EntityVersion } from "./entity-sync";
import type { ScopedRead } from "./scoped-types";
export type ReaderQuery={query?:string;sectionId?:string;cursor?:string;limit?:number};
export type ReaderBatchRequest={since?:string[];pages?:ReaderQuery[];bodies?:string[];watch?:string[];media?:string[];sidebar?:boolean;mediaOnly?:boolean};
export type ReaderBatchResponse={heads:string[];revision:string;reset:boolean;pages:{query:ReaderQuery;page:CatalogPage}[];
  changes:{index:EntityIndex;records:EntityVersion[];previous:EntityVersion[]};
  bodies:{id:string;read?:ScopedRead;error?:{code:string;message:string}}[];
  media:{id:string;download?:{url:string;expiresIn:number;media:import("./cloud-library").CloudMedia};error?:{code:string;message:string}}[]};
export function readerPageKey(options:ReaderQuery={}) {
  const params=new URLSearchParams();
  if(options.query?.trim())params.set("q",options.query.trim());
  if(options.sectionId)params.set("sectionId",options.sectionId);
  if(options.cursor)params.set("cursor",options.cursor);
  params.set("limit",String(options.limit ?? 24));return params.toString();
}
export function readerCursor(options:ReaderQuery,revision:string,offset:number) {
  const value={revision,offset,...(options.sectionId?{sectionId:options.sectionId}:{}),query:options.query?.trim().toLowerCase() || ""};
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
export function readerCursorOffset(cursor?:string|null) {
  if(!cursor)return 0;
  try{return Number(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cursor.replace(/-/g,"+").replace(/_/g,"/")),char=>char.charCodeAt(0)))).offset) || 0;}catch{return 0;}
}

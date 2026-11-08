import {diskEndpoint,diskMedia} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){const {id}=await params;return diskEndpoint(request,false,db=>diskMedia(request,db,id));}
export const HEAD=GET;

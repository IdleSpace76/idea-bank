import {diskEndpoint,diskDraft} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
async function handle(request:Request,{params}:{params:Promise<{id:string}>}){const {id}=await params;return diskEndpoint(request,request.method!=="GET",db=>diskDraft(request,db,id));}
export {handle as GET,handle as POST,handle as DELETE};

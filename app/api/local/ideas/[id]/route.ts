import {diskEndpoint} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  return diskEndpoint(request,false,db=>{const saved=db.readIdeaSnapshot(id);return saved?{idea:saved.idea,ideaRevision:saved.revision,revision:saved.libraryRevision}:Response.json({error:{code:"NOT_FOUND",message:"Идея не найдена."}},{status:404,headers:{"Cache-Control":"no-store"}});});
}

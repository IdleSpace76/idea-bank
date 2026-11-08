import {diskEndpoint,diskBackup} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
async function handle(request:Request){return diskEndpoint(request,request.method!=="GET",db=>diskBackup(request,db));}
export {handle as GET,handle as POST};

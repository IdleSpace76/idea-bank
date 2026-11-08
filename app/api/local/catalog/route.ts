import {diskCatalog,diskEndpoint} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){return diskEndpoint(request,false,db=>diskCatalog(db,new URL(request.url).searchParams));}

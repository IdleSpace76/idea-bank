import {diskEndpoint,writeDisk} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){return diskEndpoint(request,false,db=>new URL(request.url).searchParams.has("state")?db.readState():db.readSnapshot());}
export async function POST(request:Request){return diskEndpoint(request,true,db=>writeDisk(request,db));}

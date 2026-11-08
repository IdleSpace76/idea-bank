import {diskEndpoint,diskExample} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){return diskEndpoint(request,true,db=>diskExample(request,db));}

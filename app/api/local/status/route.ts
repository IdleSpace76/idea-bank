import {diskStatus,localEndpoint} from "@/lib/disk-api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request){return localEndpoint(request,false,diskStatus);}

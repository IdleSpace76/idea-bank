import {handleAgentMcp} from "@/lib/mcp-http";
import {prepareAgentAttachment} from "@/lib/mcp-upload";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export const POST=(request:Request)=>handleAgentMcp(request,prepareAgentAttachment);
export const GET=(request:Request)=>handleAgentMcp(request);
export const DELETE=(request:Request)=>handleAgentMcp(request);

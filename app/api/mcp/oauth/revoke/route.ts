import {revokeAgentToken} from "@/lib/mcp-auth";
import {agentErrorResponse,agentHeaders,boundedAgentBody} from "@/lib/mcp-http";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{await revokeAgentToken(await boundedAgentBody(request,true));return new Response(null,{status:200,headers:agentHeaders});}catch(error){return agentErrorResponse(error);}}

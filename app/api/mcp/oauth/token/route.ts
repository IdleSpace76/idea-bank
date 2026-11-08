import {exchangeAgentToken} from "@/lib/mcp-auth";
import {agentErrorResponse,agentHeaders,boundedAgentBody} from "@/lib/mcp-http";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{return Response.json(await exchangeAgentToken(await boundedAgentBody(request,true)),{headers:agentHeaders});}catch(error){return agentErrorResponse(error);}}

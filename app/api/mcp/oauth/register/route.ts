import {registerAgentClient} from "@/lib/mcp-auth";
import {agentErrorResponse,agentHeaders,boundedAgentBody} from "@/lib/mcp-http";
export const dynamic="force-dynamic";
export async function POST(request:Request){try{return Response.json(registerAgentClient(await boundedAgentBody(request)),{status:201,headers:agentHeaders});}catch(error){return agentErrorResponse(error);}}

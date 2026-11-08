import {mcpSettings} from "@/lib/mcp-auth";
import {agentErrorResponse,agentHeaders} from "@/lib/mcp-http";
export const dynamic="force-dynamic";
export function GET(){try{const settings=mcpSettings();return Response.json({resource:settings.resource,authorization_servers:[settings.issuer],scopes_supported:["ideas:read","ideas:write"],bearer_methods_supported:["header"]},{headers:{...agentHeaders,"Access-Control-Allow-Origin":"*"}});}catch(error){return agentErrorResponse(error);}}

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createIdeaMcpServer } from "./mcp-server";
import { CloudAgentBackend } from "./mcp-cloud-backend";
import { B2Storage,readB2Settings } from "./b2-storage";
import { AgentAuthError,mcpSettings,verifyAgentPrincipal } from "./mcp-auth";
import { AgentError } from "./mcp-domain";
import { StorageError } from "./cloud-library";

export const agentHeaders={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
export async function boundedAgentBody(request:Request,form=false){
  if(form?!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers.get("content-type") || ""):!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || ""))throw new AgentAuthError("invalid_request","Unexpected request content type.");
  const chunks:Uint8Array[]=[];let size=0;
  if(!request.body)throw new AgentAuthError("invalid_request","A request body is required.");
  for await(const part of request.body as unknown as AsyncIterable<Uint8Array>){size+=part.byteLength;if(size>(form?64000:3*1024*1024))throw new AgentAuthError("invalid_request","The request is too large.",413);chunks.push(part);}
  const text=Buffer.concat(chunks).toString();
  try{return form?new URLSearchParams(text):JSON.parse(text);}catch{throw new AgentAuthError("invalid_request","The request body is invalid.");}
}
export function agentErrorResponse(error:unknown){
  const known=error instanceof AgentAuthError?error:error instanceof AgentError?new AgentAuthError(error.code,error.message,error.code==="CONFLICT"?409:400):error instanceof StorageError && error.status===409?new AgentAuthError("CONFLICT","The idea changed. Ask the agent to read it again and review the attachment before retrying.",409):new AgentAuthError("temporarily_unavailable","The operation could not be completed. Retry later.",503);
  return Response.json({error:known.code,error_description:known.message},{status:known.status,headers:agentHeaders});
}
export async function handleAgentMcp(request:Request,prepareAttachment?:(input:Record<string,unknown>)=>Promise<unknown>){
  let server:ReturnType<typeof createIdeaMcpServer>|undefined;
  try{
    const settings=mcpSettings(),origin=request.headers.get("origin");
    if(origin && origin!==settings.issuer || request.headers.get("sec-fetch-site")==="cross-site")throw new AgentAuthError("access_denied","This Origin is not allowed.",403);
    const bearer=/^Bearer ([A-Za-z0-9._-]+)$/i.exec(request.headers.get("authorization") || "");
    let principal;
    try{if(!bearer)throw 0;principal=verifyAgentPrincipal(bearer[1]);}
    catch{return Response.json({error:"invalid_token"},{status:401,headers:{...agentHeaders,"WWW-Authenticate":`Bearer resource_metadata="${settings.issuer}/.well-known/oauth-protected-resource/api/mcp", scope="ideas:read ideas:write"`}});}
    if(request.method!=="POST")return new Response(null,{status:405,headers:{...agentHeaders,Allow:"POST"}});
    const body=await boundedAgentBody(request),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    server=createIdeaMcpServer({backend:async()=>new CloudAgentBackend(new B2Storage(readB2Settings())),scopes:principal.scopes,origin:settings.issuer,prepareAttachment});
    await server.connect(transport);
    const response=await transport.handleRequest(request,{parsedBody:body,authInfo:{token:bearer![1],clientId:principal.client,scopes:principal.scopes,resource:new URL(settings.resource)}});
    const bytes=await response.arrayBuffer(),headers=new Headers(response.headers);for(const [key,value] of Object.entries(agentHeaders))headers.set(key,value);
    return new Response(bytes.byteLength?bytes:null,{status:response.status,headers});
  }catch(error){return agentErrorResponse(error);}
  finally{await server?.close().catch(()=>{});}
}

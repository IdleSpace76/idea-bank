import {getOwnerSession} from "@/auth";
import {AgentAuthError,mcpSettings,openAgentValue,sealAgentValue} from "./mcp-auth";
import {agentErrorResponse,agentHeaders,boundedAgentBody} from "./mcp-http";
import {B2Storage,readB2Settings} from "./b2-storage";
import {CloudAgentBackend} from "./mcp-cloud-backend";
import {parseCloudMedia,type CloudMedia} from "./cloud-library";
import {AgentError,type AgentFile} from "./mcp-domain";

type Attachment={operation_id:string;idea_id:string;version:string;block_id?:string;as_cover:boolean};
export async function prepareAgentAttachment(input:Record<string,unknown>){
  const settings=mcpSettings(),ticket=sealAgentValue("attachment",{input},3600);
  if(ticket.length>24000)throw new AgentError("UPLOAD_PAGE_TOO_LARGE","This idea has too many version references for an upload link. Provide the original through attach_media instead.");
  return {pending:true,upload_url:`${settings.issuer}/mcp/upload#ticket=${encodeURIComponent(ticket)}`,expires_in:3600,next:"Ask the user to open this page and choose the original file. After they confirm completion, use get_idea to read the new version. Do not poll or report the file as attached before completion."};
}
export async function agentUpload(request:Request){
  let backend:CloudAgentBackend|undefined;
  try{
    const settings=mcpSettings();
    if(request.headers.get("origin")!==settings.issuer || request.headers.get("sec-fetch-site")==="cross-site" || !await getOwnerSession())throw new AgentAuthError("access_denied","Sign in as the owner before uploading.",403);
    const body=await boundedAgentBody(request) as {ticket:string;action:string;file:CloudMedia;name:string;kind:AgentFile["asset"]["kind"]};
    const session=openAgentValue<{input:Attachment}>("attachment",body.ticket),file=parseCloudMedia(body.file),name=typeof body.name==="string"?body.name.split(/[\\/]/).pop()!.slice(0,250):"attachment";
    const kind=file.mime.startsWith("image/")?"image":file.mime.startsWith("audio/")?"audio":file.mime.startsWith("video/")?"video":"model";
    if(kind!==body.kind || session.input.as_cover&&kind!=="image")throw new AgentAuthError("invalid_request","The media type does not match the requested attachment.");
    backend=new CloudAgentBackend(new B2Storage(readB2Settings()));
    if(body.action==="prepare")return Response.json(await backend.storage.createUpload(file),{headers:agentHeaders});
    if(body.action!=="finish")throw new AgentAuthError("invalid_request","Unexpected upload action.");
    const {operation_id,idea_id,version,block_id,as_cover}=session.input;
    const result=await backend.update(operation_id,idea_id,version,{}, {asset:{id:file.id,name,kind,mime:file.mime,size:file.size},cloud:file},{blockId:block_id,cover:as_cover});
    return Response.json({idea_id:result.idea.id,idea_url:`${settings.issuer}/#/project/${encodeURIComponent(result.idea.id)}`,version:result.version},{headers:agentHeaders});
  }catch(error){return agentErrorResponse(error);}
  finally{backend?.close();}
}

import { createHash } from "node:crypto";
import { readFile,realpath,stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList,isIP } from "node:net";
import path from "node:path";
import {pathToFileURL} from "node:url";
import { AgentError,operationId,type AgentBackend,type AgentFile } from "./mcp-domain";
import type {CloudAgentBackend} from "./mcp-cloud-backend";
import type {MediaAsset} from "./ideas";
import type {LocalAgentBackend} from "./mcp-local-backend";

export const AGENT_FILE_LIMIT=64*1024*1024;
const extensions:Record<string,string>={png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",webp:"image/webp",gif:"image/gif",avif:"image/avif",bmp:"image/bmp",mp4:"video/mp4",webm:"video/webm",mov:"video/quicktime",mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",m4a:"audio/mp4",flac:"audio/flac",glb:"model/gltf-binary",gltf:"model/gltf+json"};
const private4=new BlockList();
for(const [net,bits] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const)private4.addSubnet(net,bits,"ipv4");
const global6=new BlockList();global6.addSubnet("2000::",3,"ipv6");
const private6=new BlockList();private6.addSubnet("2001::",23,"ipv6");private6.addSubnet("2001:db8::",32,"ipv6");private6.addSubnet("2002::",16,"ipv6");
export function publicAddress(address:string){const kind=isIP(address);return kind===4?!private4.check(address,"ipv4"):kind===6 && global6.check(address,"ipv6") && !private6.check(address,"ipv6");}
const failed=()=>new AgentError("FILE_UNAVAILABLE","Could not obtain the original file. Use a local allowed path, a public HTTPS download URL, or prepare_attachment.");

/** Resolve once, reject private addresses, and pin DNS for the actual TLS request. */
type RemoteFileInfo={mime?:string};
export async function downloadAgentFile(raw:string,redirects=0,info?:RemoteFileInfo):Promise<Buffer>{
  let url:URL;try{url=new URL(raw);}catch{throw failed();}
  if(url.protocol!=="https:" || url.username || url.password || url.port && url.port!=="443" || redirects>3)throw failed();
  const host=url.hostname.replace(/^\[|\]$/g,"");
  const records=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true}).catch(()=>{throw failed();});
  if(!records.length || records.some(row=>!publicAddress(row.address)))throw failed();
  const selected=records[0];
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{method:"GET",headers:{Accept:"*/*","User-Agent":"IdeaBank-MCP/1"},family:selected.family,
      lookup:(_host,_options,callback)=>callback(null,selected.address,selected.family),timeout:20000},response=>{
      if([301,302,303,307,308].includes(response.statusCode || 0) && response.headers.location){response.resume();void downloadAgentFile(new URL(response.headers.location,url).href,redirects+1,info).then(resolve,reject);return;}
      if(response.statusCode!==200 || Number(response.headers["content-length"] || 0)>AGENT_FILE_LIMIT){response.destroy();reject(failed());return;}
      if(info)info.mime=response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      const chunks:Buffer[]=[];let size=0;
      response.on("data",chunk=>{size+=chunk.length;if(size>AGENT_FILE_LIMIT){response.destroy();reject(new AgentError("FILE_TOO_LARGE","Direct MCP file transfer supports up to 64 MiB. Use prepare_attachment for a larger file."));}else chunks.push(chunk);});
      response.on("end",()=>size?resolve(Buffer.concat(chunks)):reject(failed()));response.on("error",()=>reject(failed()));
    });
    request.on("timeout",()=>request.destroy());request.on("error",()=>reject(failed()));request.end();
    const deadline=setTimeout(()=>request.destroy(),60000);deadline.unref();request.once("close",()=>clearTimeout(deadline));
  });
}
export type AgentFileInput={path?:string;download_url?:string;file_id?:string;name?:string;mime?:string;file_name?:string;mime_type?:string};
export async function loadAgentFile(input:AgentFileInput,backend:AgentBackend,operation:string,roots:string[],download=downloadAgentFile):Promise<AgentFile>{
  let bytes:Buffer,name=input.file_name || input.name,mime=input.mime_type || input.mime;
  if(input.path){
    if(backend.mode!=="local" || !path.isAbsolute(input.path))throw new AgentError("FILE_ACCESS_DENIED","Local paths are available only to the local MCP server.");
    const actual=await realpath(input.path).catch(()=>{throw failed();}),allowed=await Promise.all(roots.map(root=>realpath(root).catch(()=>"")));
    if(!allowed.some(root=>{const relative=root?path.relative(root,actual):"..";return root && relative && !relative.startsWith(`..${path.sep}`) && relative!==".." && !path.isAbsolute(relative);}))throw new AgentError("FILE_ACCESS_DENIED","The file is outside the configured --allow-files folders.");
    const metadata=await stat(actual);if(!metadata.isFile() || metadata.size<1 || metadata.size>AGENT_FILE_LIMIT)throw new AgentError("FILE_TOO_LARGE","Direct MCP files must be between 1 byte and 64 MiB.");
    const extension=path.extname(actual).slice(1).toLowerCase();if(!extensions[extension])throw new AgentError("INVALID_MEDIA","Only supported image, audio, video and GLB/glTF files can be attached.");
    bytes=await readFile(actual);name=name || path.basename(actual);mime=mime || extensions[extension];
  }else if(input.download_url){const info:RemoteFileInfo={};bytes=await download(input.download_url,0,info);name=name || path.posix.basename(new URL(input.download_url).pathname) || "attachment";if(!mime && /^(image|audio|video|model)\//.test(info.mime || ""))mime=info.mime;}
  else throw new AgentError("FILE_UNAVAILABLE","The client did not provide original file bytes or a downloadable URL. Use prepare_attachment.");
  mime=mime || extensions[path.extname(name || "").slice(1).toLowerCase()];
  const kind:MediaAsset["kind"]|null=mime?.startsWith("image/")?"image":mime?.startsWith("audio/")?"audio":mime?.startsWith("video/")?"video":["model/gltf-binary","model/gltf+json"].includes(mime || "")?"model":null;
  if(!kind || !mime || mime==="image/svg+xml")throw new AgentError("INVALID_MEDIA","A supported passive media MIME type is required.");
  if(mime==="model/gltf+json"){
    try{const model=JSON.parse(bytes.toString());const refs=[...(model.buffers || []),...(model.images || [])].map((row:{uri?:string})=>row.uri).filter((uri:unknown):uri is string=>typeof uri==="string");if(refs.some((uri:string)=>!uri.startsWith("data:")))throw 0;}
    catch{throw new AgentError("MODEL_RESOURCES_REQUIRED","Use a GLB or self-contained glTF. External model resources must be bundled first.");}
  }
  const sha256=createHash("sha256").update(bytes).digest("hex"),md5=createHash("md5").update(bytes).digest("hex"),size=bytes.length;
  const cloud={id:`${sha256}-${md5}`,sha256,md5,size,mime},asset={id:backend.mode==="local"?operationId(operation,"attachment"):cloud.id,name:(name || "attachment").split(/[\\/]/).pop()!.slice(0,250),kind,mime,size};
  if(backend.mode==="local")return {asset,sha256,disk:{id:asset.id,size,mime,data:bytes}};
  const storage=(backend as CloudAgentBackend).storage,upload=await storage.createUpload(cloud);
  if(!upload.alreadyUploaded){
    const response=await fetch(upload.url!,{method:"PUT",headers:upload.headers,body:bytes as unknown as BodyInit,redirect:"error",signal:AbortSignal.timeout(120000)});
    if(!response.ok)throw new AgentError("UPLOAD_FAILED","The attachment could not be uploaded. The idea has not been changed.");
  }
  return {asset,cloud};
}
export async function readAgentMedia(backend:AgentBackend,ideaId:string,mediaId:string,preview:boolean){
  const {idea}=await backend.read(ideaId),asset=[...(idea.coverImage?[idea.coverImage]:[]),...idea.blocks.flatMap(block=>block.media || [])].find(row=>row.id===mediaId);
  if(!asset)throw new AgentError("NOT_FOUND","This attachment does not belong to the selected idea.");
  let url:string,bytes:Buffer|undefined;
  if(backend.mode==="local"){
    const saved=(backend as LocalAgentBackend).db.readMedia(asset.id);if(!saved)throw failed();url=pathToFileURL(saved.path).href;
    if(preview && asset.kind==="image" && asset.size<=8*1024*1024){bytes=await readFile(saved.path);if(bytes.length!==asset.size || createHash("sha256").update(bytes).digest("hex")!==saved.sha256)throw new AgentError("MEDIA_INTEGRITY","The attachment failed its integrity check.");}
  }else{
    const saved=await (backend as CloudAgentBackend).entities.catalog().readMedia(asset.id);url=saved.url;
    if(preview && asset.kind==="image" && asset.size<=8*1024*1024){bytes=await downloadAgentFile(url);if(bytes.length!==asset.size || createHash("sha256").update(bytes).digest("hex")!==saved.media.sha256 || createHash("md5").update(bytes).digest("hex")!==saved.media.md5)throw new AgentError("MEDIA_INTEGRITY","The attachment failed its integrity check.");}
  }
  return {metadata:{idea_id:ideaId,asset,url,...(backend.mode==="github"?{expires_in:300}:{})},...(bytes?{image:{type:"image" as const,data:bytes.toString("base64"),mimeType:asset.mime}}:{})};
}

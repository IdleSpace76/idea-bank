import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DiskLibraryStore } from "../lib/disk-library";
import { LocalAgentBackend } from "../lib/mcp-local-backend";
import { createIdeaMcpServer } from "../lib/mcp-server";

const root=fileURLToPath(new URL("../",import.meta.url));process.chdir(root);process.env.IDEA_BANK_AUTH_MODE="local";
const require=createRequire(import.meta.url),{loadEnvConfig}=require("@next/env");
// stdout is reserved exclusively for MCP JSON-RPC frames.
loadEnvConfig(root,false, {info:()=>{},error:()=>console.error("Could not load the local environment.")});
if(process.env.VERCEL)throw new Error("Local MCP cannot run on Vercel.");
const args=process.argv.slice(2),roots:string[]=[];let readOnly=false,appUrl="http://127.0.0.1:3000";
for(let index=0;index<args.length;index++){
  if(args[index]==="--data-dir" && args[index+1])process.env.IDEA_BANK_DATA_DIR=path.resolve(root,args[++index]);
  else if(args[index]==="--allow-files" && args[index+1])roots.push(path.resolve(root,args[++index]));
  else if(args[index]==="--read-only")readOnly=true;
  else if(args[index]==="--app-url" && args[index+1]){const url=new URL(args[++index]);if(url.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname!=="/")throw new Error("--app-url must be a local loopback HTTP origin.");appUrl=url.origin;}
  else throw new Error("Expected --data-dir <folder>, --allow-files <folder>, --app-url <origin>, or --read-only.");
}
if(!roots.length)roots.push(path.join(root,"public","examples"));
let backend:LocalAgentBackend|undefined;
const server=createIdeaMcpServer({backend:async()=>backend ||= new LocalAgentBackend(await DiskLibraryStore.open(),true),scopes:readOnly?["ideas:read"]:["ideas:read","ideas:write"],fileRoots:roots,keepOpen:true,origin:appUrl});
const stop=async()=>{await server.close();backend?.close();};
process.once("SIGINT",()=>{void stop();});process.once("SIGTERM",()=>{void stop();});process.stdin.once("end",()=>{void stop();});
await server.connect(new StdioServerTransport());

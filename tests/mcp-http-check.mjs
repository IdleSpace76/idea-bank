import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {mkdir,mkdtemp,rm,readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID,createHash} from "node:crypto";
import {encode} from "next-auth/jwt";
import {chromium,expect} from "@playwright/test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {sealAgentValue} from "../lib/mcp-auth.ts";

const root=fileURLToPath(new URL("../",import.meta.url)),cache=path.join(root,".cache");await mkdir(cache,{recursive:true});
const directory=await mkdtemp(path.join(cache,"mcp-http-")),secret="mcp-isolated-session-secret-with-thirty-two-characters";
let child,browser,client,origin,env;
async function start(mode){
  const probe=createServer();await new Promise(resolve=>probe.listen(0,"127.0.0.1",resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));origin=`http://127.0.0.1:${port}`;
  env={...process.env,VERCEL:"",IDEA_BANK_AUTH_MODE:mode,IDEA_BANK_MCP_ENABLED:"true",IDEA_BANK_DATA_DIR:path.join(directory,"data"),AUTH_URL:origin,AUTH_SECRET:secret,AUTH_GITHUB_ID:"fixture",AUTH_GITHUB_SECRET:"fixture-secret",IDEA_BANK_OWNER_ID:"12345",B2_S3_ENDPOINT:"https://s3.eu-central-003.backblazeb2.com",B2_REGION:"eu-central-003",B2_BUCKET_NAME:"mcp-fixture-bucket",B2_KEY_ID:"fixture",B2_APPLICATION_KEY:"fixture",ABLY_API_KEY:""};
  child=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.resume();child.stderr.resume();for(let n=0;;n++){try{await fetch(origin);break;}catch{if(n>100||child.exitCode!==null)throw new Error("Isolated MCP server did not start");await delay(100);}}
}
async function stop(){if(!child)return;const process=child;child=null;process.kill("SIGTERM");await new Promise(resolve=>process.exitCode!==null?resolve():process.once("exit",resolve));}
try{
  await start("local");assert.equal((await fetch(`${origin}/api/mcp`)).status,404);
  browser=await chromium.launch({channel:"msedge",headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem("idea-bank.language","en"));const page=await context.newPage();
  await page.goto(origin);await expect(page.locator(".project-card strong").filter({hasText:"Example"})).toBeVisible();
  const calls=[];page.on("request",request=>{if(new URL(request.url()).pathname.startsWith("/api/"))calls.push(new URL(request.url()).pathname);});
  client=new Client({name:"live-browser-check",version:"1"});await client.connect(new StdioClientTransport({command:process.execPath,args:["--import","tsx","scripts/mcp-local.mts","--data-dir",env.IDEA_BANK_DATA_DIR],cwd:root,env:Object.fromEntries(Object.entries(env).filter(([,value])=>typeof value==="string")),stderr:"pipe"}));
  const call=async(name,args={})=>{const response=await client.callTool({name,arguments:args});assert.ok(!response.isError,JSON.stringify(response.structuredContent));return response.structuredContent;};
  const section=(await call("list_sections")).sections[0],created=await call("create_idea",{operation_id:randomUUID(),section_id:section.id,name:"Visible MCP idea",blocks:[{heading:"First heading",text:"Saved body"}]});
  await expect(page.locator(".project-card strong").filter({hasText:"Visible MCP idea"})).toBeVisible();
  await page.locator(".project-card").filter({hasText:"Visible MCP idea"}).click();await expect(page.getByRole("heading",{name:"First heading",exact:true})).toBeVisible();
  const current=await call("get_idea",{idea_id:created.idea.id});await call("update_idea",{operation_id:randomUUID(),idea_id:created.idea.id,version:current.version,block_changes:[{action:"update",id:current.idea.blocks[0].id,heading:"Updated by MCP"}]});
  await expect(page.getByRole("heading",{name:"Updated by MCP",exact:true})).toBeVisible();
  const count=calls.length;await delay(1800);assert.equal(calls.length,count,"Idle local MCP browser does not poll data APIs");
  await page.getByRole("button",{name:"Edit block 1",exact:true}).click();await page.getByLabel("Block heading",{exact:true}).fill("Unsaved browser draft");
  const beforeDraft=await call("get_idea",{idea_id:created.idea.id});await call("update_idea",{operation_id:randomUUID(),idea_id:created.idea.id,version:beforeDraft.version,description:"Concurrent agent edit"});
  await delay(600);await expect(page.getByLabel("Block heading",{exact:true})).toHaveValue("Unsaved browser draft");
  page.once("dialog",dialog=>dialog.accept());await page.locator(".editor-actions").getByRole("button",{name:"Cancel",exact:true}).click();await expect(page.getByText("Concurrent agent edit",{exact:true})).toBeVisible();
  await client.close();client=null;await context.close();await stop();
  console.log("MCP local browser: standalone agent changes appear without reload, bodies refresh and idle pages do not poll.");

  await start("github");
  const unauthorized=await fetch(`${origin}/api/mcp`);assert.equal(unauthorized.status,401);assert.ok(unauthorized.headers.get("www-authenticate").includes("resource_metadata"));
  const metadata=await (await fetch(`${origin}/.well-known/oauth-protected-resource/api/mcp`)).json();assert.equal(metadata.resource,`${origin}/api/mcp`);
  const token=sealAgentValue("access",{owner:"12345",client:"fixture",resource:`${origin}/api/mcp`,scopes:["ideas:read"]},300,env);
  client=new Client({name:"http-browser-fixture",version:"1"});await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));assert.equal((await client.listTools()).tools.length,4);await client.close();client=null;
  const registration=await (await fetch(`${origin}/api/mcp/oauth/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Codex <fixture>",redirect_uris:["http://127.0.0.1/callback"],token_endpoint_auth_method:"none"})})).json();
  const verifier="a".repeat(43),params=new URLSearchParams({client_id:registration.client_id,redirect_uri:"http://127.0.0.1:45001/callback",response_type:"code",code_challenge_method:"S256",code_challenge:createHash("sha256").update(verifier).digest("base64url"),state:"client-state",scope:"ideas:read ideas:write",resource:`${origin}/api/mcp`}),authorize=`${origin}/api/mcp/oauth/authorize?${params}`;
  const anonymous=await fetch(authorize,{redirect:"manual"});assert.equal(anonymous.status,303);const login=new URL(anonymous.headers.get("location"));assert.equal(login.pathname,"/");assert.ok(login.searchParams.get("agentReturn").startsWith("/api/mcp/oauth/authorize?"));
  const loginHtml=await (await fetch(login)).text();assert.ok(loginHtml.includes('name="agentReturn"'),"Owner sign-in retains the MCP return path");
  const owner=`authjs.session-token=${await encode({secret,salt:"authjs.session-token",token:{sub:"12345",name:"Owner"},maxAge:300})}`;
  const consent=await fetch(authorize,{headers:{Cookie:owner}});assert.equal(consent.status,200);const html=await consent.text();assert.ok(html.includes("Codex &lt;fixture&gt;"));assert.ok(!html.includes("Codex <fixture>"));
  const pending=/name="request" value="([^"]+)"/.exec(html)[1],nonce=consent.headers.getSetCookie()[0].split(";")[0],form=new URLSearchParams({request:pending,decision:"allow"});
  assert.equal((await fetch(`${origin}/api/mcp/oauth/authorize`,{method:"POST",headers:{Cookie:`${owner}; ${nonce}`,"Content-Type":"application/x-www-form-urlencoded"},body:form})).status,403);
  const approved=await fetch(`${origin}/api/mcp/oauth/authorize`,{method:"POST",redirect:"manual",headers:{Cookie:`${owner}; ${nonce}`,Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body:form});assert.equal(approved.status,303);
  const github=new URL(approved.headers.get("location"));assert.equal(github.origin,"https://github.com");assert.equal(github.searchParams.get("scope"),"offline_access");assert.equal(github.searchParams.get("redirect_uri"),`${origin}/api/mcp/oauth/callback`);
  const providerCookie=approved.headers.getSetCookie().find(row=>row.startsWith("idea-bank-mcp-provider=")).split(";")[0],callback=new URL(`${origin}/api/mcp/oauth/callback`);callback.searchParams.set("state",github.searchParams.get("state"));callback.searchParams.set("code","synthetic-one-time-provider-code");
  assert.equal((await fetch(callback,{redirect:"manual"})).status,403);
  const returned=await fetch(callback,{redirect:"manual",headers:{Cookie:providerCookie}});assert.equal(returned.status,303);const native=new URL(returned.headers.get("location"));assert.equal(native.origin,"http://127.0.0.1:45001");assert.equal(native.searchParams.get("state"),"client-state");assert.equal(native.searchParams.get("iss"),origin);assert.ok(native.searchParams.get("code").startsWith("ib1."));
  assert.equal((await fetch(`${origin}/api/local/events`)).status,404);
  const uploadContext=await browser.newContext();await uploadContext.addCookies([{name:"authjs.session-token",value:owner.split("=")[1],url:origin,httpOnly:true,sameSite:"Lax"}]);const uploadPage=await uploadContext.newPage();let uploaded=false,finished=false;
  const picture=await readFile(path.join(root,"public/examples/little-robot.png"));
  await uploadContext.route("**/api/mcp/uploads",async route=>{const body=route.request().postDataJSON();assert.equal(body.ticket,"synthetic-ticket");assert.equal(body.file.sha256,createHash("sha256").update(picture).digest("hex"));if(body.action==="prepare")return route.fulfill({json:{url:`${origin}/fixture-upload`,headers:{"Content-Type":"image/png"}}});assert.ok(uploaded);finished=true;return route.fulfill({json:{idea_url:`${origin}/#/project/synthetic`}});});
  await uploadContext.route("**/fixture-upload",async route=>{assert.equal(route.request().method(),"PUT");assert.deepEqual(route.request().postDataBuffer(),picture);uploaded=true;return route.fulfill({status:200,body:""});});
  await uploadPage.goto(`${origin}/mcp/upload#ticket=synthetic-ticket`);await uploadPage.getByLabel("Choose an attachment",{exact:true}).setInputFiles({name:"robot.png",mimeType:"image/png",buffer:picture});await uploadPage.getByRole("button",{name:"Attach",exact:true}).click();await expect(uploadPage.getByText("Attachment saved. You can return to the agent.",{exact:true})).toBeVisible();assert.ok(finished);await uploadContext.close();
  console.log("MCP HTTP: discovery, SDK handshake, permissions, owner login continuation, escaped consent, CSRF and callback binding passed without contacting GitHub or B2.");
}finally{await client?.close().catch(()=>{});await browser?.close();await stop();const relative=path.relative(cache,directory);if(!relative||relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Unsafe cleanup");await rm(directory,{recursive:true,force:true});}

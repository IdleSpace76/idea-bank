// Opt-in real-model integration. Uses the existing Codex login and only synthetic disk data.
import assert from "node:assert/strict";
import {mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {DiskLibraryStore} from "../lib/disk-library.ts";

const root=fileURLToPath(new URL("../",import.meta.url)),cache=path.join(root,".cache");await mkdir(cache,{recursive:true});
const directory=await mkdtemp(path.join(cache,"mcp-codex-")),data=path.join(directory,"data"),image=path.join(root,"public/examples/little-robot.png"),result=path.join(directory,"result.txt");
const toml=value=>JSON.stringify(value.replaceAll("\\","/")),operationIds=Array.from({length:4},()=>randomUUID());
const args=["exec","--ephemeral","--ignore-user-config","--json","--color","never","--sandbox","read-only","--cd",root,"--image",image,"--output-last-message",result,
  "-c",`mcp_servers.idea_bank.command=${toml(process.execPath)}`,"-c",`mcp_servers.idea_bank.args=[${["--import","tsx",path.join(root,"scripts/mcp-local.mts"),"--data-dir",data,"--allow-files",path.dirname(image)].map(toml).join(",")}]`,"-c","mcp_servers.idea_bank.startup_timeout_sec=30","-c","mcp_servers.idea_bank.tool_timeout_sec=90","-c",'mcp_servers.idea_bank.tools.update_idea.approval_mode="approve"',
  `This is an authorized end-to-end MCP integration test. Use only idea_bank MCP tools for data changes. Do not change repository files, use shell commands to change data, access credentials, or call cloud services. All requested writes are authorized in the temporary library.\n1. List sections.\n2. Create section "MCP verification" using operation_id ${operationIds[0]}.\n3. Create idea "Лесная станция" in that section with description "Исследование леса и заброшенной станции", one block heading "Замысел", text "Игрок исследует станцию и собирает заметки." Use operation_id ${operationIds[1]}.\n4. Attach the ORIGINAL supplied image at local path ${image} to that block using operation_id ${operationIds[2]}.\n5. Read the idea, then use get_media with preview=true to inspect its image.\n6. Update the block text to "Игрок исследует станцию, собирает заметки и восстанавливает связь." Use the latest version and operation_id ${operationIds[3]}.\n7. Search for "лесная станцыя" and verify the idea is found. Read it and summarize the saved idea and image briefly in Russian. Report success only after tool results confirm the changes. Do not call unrelated tools or load unrelated ideas.`];
const events=[];let child;
try{
  child=spawn(process.env.IDEA_BANK_CODEX_BINARY || (process.platform==="win32"?"codex.exe":"codex"),args,{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let pending="";child.stdout.on("data",chunk=>{pending+=String(chunk);let index;while((index=pending.indexOf("\n"))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const event=JSON.parse(line);events.push(event);if(event.type==="item.completed"){const item=event.item;console.log(`Codex: ${item.type}${item.tool?` ${item.tool}`:""}`);}}catch{}}});
  const diagnostics=[];child.stderr.on("data",chunk=>diagnostics.push(String(chunk)));
  const timeout=setTimeout(()=>child.kill(),300000);let exit;try{exit=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});}finally{clearTimeout(timeout);}
  assert.equal(exit,0,diagnostics.join("").slice(-500));
  await writeFile(path.join(cache,"mcp-codex-last-result.txt"),await readFile(result,"utf8"));
  await writeFile(path.join(cache,"mcp-codex-last-tools.json"),JSON.stringify(events.filter(event=>event.item?.type==="mcp_tool_call"),null,2));
  const tools=events.filter(event=>event.type==="item.completed"&&event.item?.type==="mcp_tool_call").map(event=>event.item.tool);
  for(const tool of ["list_sections","create_section","create_idea","attach_media","get_media","update_idea","search_ideas","get_idea"])assert.ok(tools.includes(tool),`Real Codex did not call ${tool}`);
  const db=await DiskLibraryStore.open({...process.env,IDEA_BANK_AUTH_MODE:"local",VERCEL:"",IDEA_BANK_DATA_DIR:data});
  try{
    const snapshot=db.readSnapshot();assert.equal(snapshot.library.sections.length,1);assert.equal(snapshot.library.projects.length,1);
    const idea=snapshot.library.projects[0];assert.equal(idea.name,"Лесная станция");assert.equal(idea.blocks[0].text,"Игрок исследует станцию, собирает заметки и восстанавливает связь.");assert.equal(idea.blocks[0].media.length,1);
    const stored=db.readMedia(idea.blocks[0].media[0].id);assert.deepEqual(await readFile(stored.path),await readFile(image));
  }finally{db.close();}
  const answer=await readFile(result,"utf8");assert.ok(answer.trim());
  await writeFile(path.join(cache,"mcp-codex-last-result.txt"),answer);
  console.log("Real Codex MCP check passed: natural-language planning, original attached image, image preview, fuzzy search, persisted edit and final summary. Test library removed.");
}finally{
  if(child && child.exitCode===null)child.kill();
  const relative=path.relative(cache,directory);if(!relative||relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Unsafe fixture cleanup");await rm(directory,{recursive:true,force:true});
}

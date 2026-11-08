import assert from "node:assert/strict";
import {createHash,randomBytes} from "node:crypto";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {mcpSettings,registerAgentClient,parseAuthorization,sealAgentValue,openAgentValue,exchangeAgentToken,verifyAgentPrincipal,revokeAgentToken} from "../lib/mcp-auth.ts";
import {handleAgentMcp} from "../lib/mcp-http.ts";

const env={IDEA_BANK_MCP_ENABLED:"true",IDEA_BANK_AUTH_MODE:"github",AUTH_URL:"http://127.0.0.1:35483",AUTH_SECRET:"fixture-auth-secret-at-least-thirty-two-characters",AUTH_GITHUB_ID:"fixture-client",AUTH_GITHUB_SECRET:"fixture-provider-secret",IDEA_BANK_OWNER_ID:"12345",B2_S3_ENDPOINT:"https://s3.eu-central-003.backblazeb2.com",B2_REGION:"eu-central-003",B2_BUCKET_NAME:"fixture-bucket",B2_KEY_ID:"fixture-key",B2_APPLICATION_KEY:"fixture-secret"};
const settings=mcpSettings(env),client=registerAgentClient({client_name:"Codex fixture",redirect_uris:["http://127.0.0.1/callback/test"],token_endpoint_auth_method:"none"},env),verifier=randomBytes(48).toString("base64url"),challenge=createHash("sha256").update(verifier).digest("base64url");
const params=new URLSearchParams({client_id:client.client_id,redirect_uri:"http://127.0.0.1:35484/callback/test",response_type:"code",scope:"ideas:read ideas:write offline_access",state:"client-state",resource:settings.resource,code_challenge:challenge,code_challenge_method:"S256"});
const authorization=parseAuthorization(params,env);assert.equal(authorization.redirect,params.get("redirect_uri"));
for(const uri of ["http://example.com/callback","javascript:alert(1)",Object.assign(new URL("https://example.com/callback"),{username:"user",password:"pass"}).href,"https://example.com/#fragment"])assert.throws(()=>registerAgentClient({client_name:"bad",redirect_uris:[uri]},env));
assert.throws(()=>parseAuthorization(new URLSearchParams({...Object.fromEntries(params),redirect_uri:"http://127.0.0.1:35484/stolen"}),env));
assert.throws(()=>parseAuthorization(new URLSearchParams({...Object.fromEntries(params),scope:"admin"}),env));
assert.throws(()=>mcpSettings({...env,IDEA_BANK_MCP_ENABLED:""}));
assert.throws(()=>mcpSettings({...env,IDEA_BANK_AUTH_MODE:"local"}));
let owner="12345",count=0;const usedCodes=new Set(),refreshes=new Set(),revoked=new Set(),calls=[];
const provider=async(url,init={})=>{
  calls.push(String(url));
  if(String(url)==="https://github.com/login/oauth/access_token"){
    const body=new URLSearchParams(init.body);
    assert.equal(body.get("client_secret"),env.AUTH_GITHUB_SECRET);
    if(body.get("grant_type")==="refresh_token"){
      const old=body.get("refresh_token");if(!refreshes.delete(old))return Response.json({error:"bad_refresh_token"});
    }else{const code=body.get("code");if(usedCodes.has(code))return Response.json({error:"bad_verification_code"});usedCodes.add(code);assert.equal(body.get("redirect_uri"),settings.callback);}
    const access=`provider-access-${++count}`,refresh=`provider-refresh-${count}`;refreshes.add(refresh);
    return Response.json({access_token:access,refresh_token:refresh,expires_in:28800,refresh_token_expires_in:15552000});
  }
  if(String(url)==="https://api.github.com/user"){if(revoked.has(init.headers.Authorization?.slice(7)))return new Response(null,{status:401});return Response.json({id:owner});}
  if(String(url)===`https://api.github.com/applications/${env.AUTH_GITHUB_ID}/token`){assert.equal(init.method,"DELETE");revoked.add(JSON.parse(init.body).access_token);return new Response(null,{status:204});}
  throw new Error("Unexpected provider request");
};
const wrap=providerCode=>sealAgentValue("code",{authorization,providerCode},300,env),grant=(code,extra={})=>new URLSearchParams({grant_type:"authorization_code",client_id:client.client_id,redirect_uri:authorization.redirect,code,code_verifier:verifier,resource:settings.resource,...extra});
await assert.rejects(exchangeAgentToken(grant(wrap("wrong-verifier"),{code_verifier:"x".repeat(64)}),env,provider));assert.equal(calls.length,0,"PKCE is checked before contacting any provider");
const code=wrap("single-use-code"),tokens=await exchangeAgentToken(grant(code),env,provider),principal=verifyAgentPrincipal(tokens.access_token,env);
assert.equal(principal.owner,env.IDEA_BANK_OWNER_ID);assert.ok(principal.scopes.includes("ideas:write"));assert.equal(tokens.expires_in,300);
assert.ok(!tokens.access_token.includes("provider-access"));assert.ok(!tokens.refresh_token.includes("provider-refresh"));
await assert.rejects(exchangeAgentToken(grant(code),env,provider));
const refresh=new URLSearchParams({grant_type:"refresh_token",client_id:client.client_id,refresh_token:tokens.refresh_token,resource:settings.resource});
await assert.rejects(exchangeAgentToken(new URLSearchParams({...Object.fromEntries(refresh),scope:"ideas:read admin"}),env,provider));
const renewed=await exchangeAgentToken(refresh,env,provider);assert.notEqual(renewed.refresh_token,tokens.refresh_token);await assert.rejects(exchangeAgentToken(refresh,env,provider));
await revokeAgentToken(new URLSearchParams({client_id:client.client_id,token:renewed.refresh_token}),env,provider);assert.equal(revoked.size,1);
assert.throws(()=>verifyAgentPrincipal(tokens.access_token,{...env,IDEA_BANK_OWNER_ID:"777"}));
const original=Date.now;try{Date.now=()=>original()+301000;assert.throws(()=>verifyAgentPrincipal(tokens.access_token,env));}finally{Date.now=original;}
owner="777";await assert.rejects(exchangeAgentToken(grant(wrap("foreign-owner")),env,provider));owner="12345";
const readAuth={...authorization,scopes:["ideas:read"]},readCode=sealAgentValue("code",{authorization:readAuth,providerCode:"readonly-code"},300,env),readonly=await exchangeAgentToken(grant(readCode),env,provider);
const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
try{
  const denied=await handleAgentMcp(new Request(settings.resource,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}));assert.equal(denied.status,401);assert.ok(denied.headers.get("www-authenticate").includes("oauth-protected-resource"));
  const cross=await handleAgentMcp(new Request(settings.resource,{method:"POST",headers:{Origin:"https://foreign.example",Authorization:`Bearer ${readonly.access_token}`,"Content-Type":"application/json"},body:"{}"}));assert.equal(cross.status,403);
  const transport=new StreamableHTTPClientTransport(new URL(settings.resource),{requestInit:{headers:{Authorization:`Bearer ${readonly.access_token}`}},fetch:async(url,init)=>handleAgentMcp(new Request(url,init))});
  const sdkClient=new Client({name:"http-protocol-check",version:"1.0.0"});
  await sdkClient.connect(transport);assert.equal((await sdkClient.listTools()).tools.length,4);
  const deniedWrite=await sdkClient.callTool({name:"create_section",arguments:{operation_id:"b7f4d3c0-7372-42be-8b7c-e4d7ef66eb64",name:"Must not write"}});assert.equal(deniedWrite.structuredContent.error.code,"FORBIDDEN");await sdkClient.close();
  assert.ok(calls.every(url=>url.startsWith("https://github.com/") || url.startsWith("https://api.github.com/")),"Authorization and idle MCP discovery never access B2");
}finally{for(const [key,value] of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;}
console.log("MCP authorization: closed defaults, stateless registration, exact/loopback redirects, PKCE, single-use provider codes, owner/resource checks, encrypted credentials, rotated refresh tokens, revocation, expiry, reduced scopes, HTTP SDK and zero B2 authorization calls passed.");

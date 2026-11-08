import { createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,timingSafeEqual } from "node:crypto";
import { readAuthSettings } from "./auth-settings";
import { readB2Settings } from "./b2-storage";
import { AgentError } from "./mcp-domain";

export const MCP_ACCESS_SECONDS=300;
export type AgentPrincipal={owner:string;client:string;scopes:string[];resource:string};
export type OAuthClient={name:string;redirects:string[]};
export type Authorization={client:string;redirect:string;state:string;scopes:string[];challenge:string;resource:string};
type ProviderTokens={access_token:string;refresh_token?:string;expires_in?:number;refresh_token_expires_in?:number;error?:string};
export class AgentAuthError extends Error {constructor(readonly code:string,message:string,readonly status=400){super(message);}}
export function mcpSettings(env:NodeJS.ProcessEnv=process.env){
  const auth=readAuthSettings(env);if(env.IDEA_BANK_MCP_ENABLED!=="true" || auth.mode!=="github")throw new AgentAuthError("not_found","MCP is not enabled.",404);
  readB2Settings(env);
  const issuer=new URL(env.AUTH_URL!).origin,resource=`${issuer}/api/mcp`,key=createHmac("sha256",auth.secret).update(`idea-bank-mcp:v1:${resource}:${auth.ownerId}`).digest();
  return {...auth,issuer,resource,key,callback:`${issuer}/api/mcp/oauth/callback`};
}
/** Opaque authenticated envelopes keep provider tokens out of client-visible plaintext and logs. */
export function sealAgentValue(kind:string,value:Record<string,unknown>,seconds:number,env:NodeJS.ProcessEnv=process.env){
  const settings=mcpSettings(env),iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",settings.key,iv);cipher.setAAD(Buffer.from(`${settings.resource}:${kind}`));
  const encrypted=Buffer.concat([cipher.update(JSON.stringify({...value,exp:Math.floor(Date.now()/1000)+seconds})),cipher.final()]);
  return `ib1.${iv.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}
export function openAgentValue<T>(kind:string,token:string,env:NodeJS.ProcessEnv=process.env):T{
  try{
    if(token.length>32000)throw 0;const settings=mcpSettings(env),parts=token.split(".");if(parts.length!==4 || parts[0]!=="ib1")throw 0;
    const decipher=createDecipheriv("aes-256-gcm",settings.key,Buffer.from(parts[1],"base64url"));decipher.setAAD(Buffer.from(`${settings.resource}:${kind}`));decipher.setAuthTag(Buffer.from(parts[3],"base64url"));
    const value=JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[2],"base64url")),decipher.final()]).toString());if(!Number.isSafeInteger(value.exp)||value.exp<=Date.now()/1000)throw 0;return value as T;
  }catch{throw new AgentAuthError("invalid_grant","This authorization has expired or is invalid.");}
}
function callbackAllowed(raw:string){
  try{const url=new URL(raw);return !url.username&&!url.password&&!url.hash&&url.href.length<=2000&&(url.protocol==="https:" || url.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(url.hostname));}catch{return false;}
}
/** Stateless DCR needs no B2 operation and cannot register credentials for a confidential client. */
export function registerAgentClient(input:unknown,env:NodeJS.ProcessEnv=process.env){
  const row=input as {client_name?:string;redirect_uris?:string[];token_endpoint_auth_method?:string;grant_types?:string[];response_types?:string[]};
  if(!row || typeof row.client_name!=="string" || !row.client_name.trim() || row.client_name.length>100 || !Array.isArray(row.redirect_uris)||row.redirect_uris.length<1||row.redirect_uris.length>5||row.redirect_uris.some(uri=>typeof uri!=="string"||!callbackAllowed(uri)) || row.token_endpoint_auth_method && row.token_endpoint_auth_method!=="none" || row.grant_types && (!Array.isArray(row.grant_types) || row.grant_types.some(value=>!["authorization_code","refresh_token"].includes(value))) || row.response_types && (!Array.isArray(row.response_types) || row.response_types.some(value=>value!=="code")))throw new AgentAuthError("invalid_client_metadata","A public client with valid redirect URIs is required.");
  const client={name:row.client_name,redirects:[...new Set(row.redirect_uris)]};
  return {client_id:sealAgentValue("client",client,365*86400,env),client_name:client.name,redirect_uris:client.redirects,token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]};
}
export function parseAuthorization(params:URLSearchParams,env:NodeJS.ProcessEnv=process.env):Authorization{
  const settings=mcpSettings(env),client=params.get("client_id") || "",known=openAgentValue<OAuthClient>("client",client,env),redirect=params.get("redirect_uri") || "";
  if(!callbackAllowed(redirect))throw new AgentAuthError("invalid_request","The redirect URI is not registered.");
  // RFC 8252 permits a native client to choose a loopback port at login.
  const matches=known.redirects.some(value=>{
    if(value===redirect)return true;const registered=new URL(value),actual=new URL(redirect);
    return registered.protocol==="http:"&&["127.0.0.1","localhost","[::1]"].includes(registered.hostname)&&!registered.port&&registered.hostname===actual.hostname&&registered.protocol===actual.protocol&&registered.pathname===actual.pathname&&registered.search===actual.search;
  });
  if(!callbackAllowed(redirect) || !matches)throw new AgentAuthError("invalid_request","The redirect URI is not registered.");
  const scopes=[...new Set((params.get("scope") || "ideas:read ideas:write").split(/\s+/).filter(Boolean))];
  if(!scopes.length || scopes.some(scope=>!["ideas:read","ideas:write","offline_access"].includes(scope)))throw new AgentAuthError("invalid_scope","Supported permissions are ideas:read and ideas:write.");
  if(scopes.includes("ideas:write")&&!scopes.includes("ideas:read"))scopes.push("ideas:read");
  const challenge=params.get("code_challenge") || "",state=params.get("state") || "";
  if(params.get("response_type")!=="code" || params.get("code_challenge_method")!=="S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length>2000 || params.get("resource") && params.get("resource")!==settings.resource)throw new AgentAuthError("invalid_request","Authorization code with PKCE S256 and the correct resource is required.");
  return {client,redirect,state,scopes,challenge,resource:settings.resource};
}
export function verifyAgentPrincipal(token:string,env:NodeJS.ProcessEnv=process.env):AgentPrincipal{
  const principal=openAgentValue<AgentPrincipal>("access",token,env),settings=mcpSettings(env);
  if(principal.owner!==settings.ownerId || principal.resource!==settings.resource || !Array.isArray(principal.scopes) || principal.scopes.some(scope=>!["ideas:read","ideas:write","offline_access"].includes(scope)))throw new AgentAuthError("invalid_token","The token is not valid for this Idea Bank instance.",401);
  return principal;
}
async function providerRequest(body:Record<string,string>,env:NodeJS.ProcessEnv,send:typeof fetch){
  const settings=mcpSettings(env),response=await send("https://github.com/login/oauth/access_token",{method:"POST",headers:{Accept:"application/json","Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:settings.clientId,client_secret:settings.clientSecret,...body}),redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)});
  const tokens=await response.json() as ProviderTokens;
  if(!response.ok || tokens.error || typeof tokens.access_token!=="string")throw new AgentAuthError("invalid_grant","GitHub rejected or already consumed this authorization. Connect again.");
  const owner=await send("https://api.github.com/user",{headers:{Authorization:`Bearer ${tokens.access_token}`,Accept:"application/vnd.github+json","User-Agent":"IdeaBank-MCP"},redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(!owner.ok || String((await owner.json()).id)!==settings.ownerId)throw new AgentAuthError("access_denied","Only the configured Idea Bank owner can authorize this connection.",403);
  return tokens;
}
function issuedTokens(principal:AgentPrincipal,tokens:ProviderTokens,env:NodeJS.ProcessEnv){
  const expires=Math.min(MCP_ACCESS_SECONDS,tokens.expires_in || MCP_ACCESS_SECONDS);
  return {access_token:sealAgentValue("access",{...principal,providerAccess:tokens.access_token},expires,env),token_type:"Bearer",expires_in:expires,scope:principal.scopes.join(" "),...(tokens.refresh_token?{refresh_token:sealAgentValue("refresh",{...principal,providerRefresh:tokens.refresh_token,providerAccess:tokens.access_token},Math.min(tokens.refresh_token_expires_in || 15552000,15552000),env)}:{})};
}
/** GitHub consumes authorization codes and rotates refresh tokens atomically; no B2 auth ledger. */
export async function exchangeAgentToken(params:URLSearchParams,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch){
  const settings=mcpSettings(env),client=params.get("client_id") || "";openAgentValue<OAuthClient>("client",client,env);
  if(params.get("resource") && params.get("resource")!==settings.resource)throw new AgentAuthError("invalid_target","The requested resource is not this MCP server.");
  if(params.get("grant_type")==="authorization_code"){
    const code=openAgentValue<{authorization:Authorization;providerCode:string}>("code",params.get("code") || "",env),auth=code.authorization,verifier=params.get("code_verifier") || "";
    const digest=createHash("sha256").update(verifier).digest("base64url");
    if(auth.client!==client || auth.redirect!==params.get("redirect_uri") || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || digest.length!==auth.challenge.length || !timingSafeEqual(Buffer.from(digest),Buffer.from(auth.challenge)))throw new AgentAuthError("invalid_grant","The client, redirect or PKCE verifier does not match.");
    const tokens=await providerRequest({code:code.providerCode,redirect_uri:settings.callback,code_verifier:verifier},env,send);
    return issuedTokens({owner:settings.ownerId,client,scopes:auth.scopes,resource:settings.resource},tokens,env);
  }
  if(params.get("grant_type")==="refresh_token"){
    const old=openAgentValue<AgentPrincipal&{providerRefresh:string}>("refresh",params.get("refresh_token") || "",env);
    if(old.client!==client || old.owner!==settings.ownerId || old.resource!==settings.resource)throw new AgentAuthError("invalid_grant","This refresh token belongs to another connection.");
    const scopes=params.get("scope")?.split(/\s+/).filter(Boolean) || old.scopes;if(scopes.some(scope=>!old.scopes.includes(scope)))throw new AgentAuthError("invalid_scope","Refresh cannot increase permissions.");
    const tokens=await providerRequest({grant_type:"refresh_token",refresh_token:old.providerRefresh},env,send);
    return issuedTokens({owner:old.owner,client:old.client,resource:old.resource,scopes},tokens,env);
  }
  throw new AgentAuthError("unsupported_grant_type","Use authorization_code or refresh_token.");
}
export async function revokeAgentToken(params:URLSearchParams,env:NodeJS.ProcessEnv=process.env,send:typeof fetch=fetch){
  const client=params.get("client_id") || "",token=params.get("token") || "",settings=mcpSettings(env);let value:AgentPrincipal&{providerAccess:string};
  try{value=openAgentValue("refresh",token,env);}catch{try{value=openAgentValue("access",token,env);}catch{return;}}
  if(value.client!==client)return;
  const response=await send(`https://api.github.com/applications/${encodeURIComponent(settings.clientId)}/token`,{method:"DELETE",headers:{Authorization:`Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`,Accept:"application/vnd.github+json","Content-Type":"application/json","User-Agent":"IdeaBank-MCP"},body:JSON.stringify({access_token:value.providerAccess}),redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(!response.ok && response.status!==404)throw new AgentAuthError("temporarily_unavailable","GitHub could not revoke the connection. Retry later.",503);
}

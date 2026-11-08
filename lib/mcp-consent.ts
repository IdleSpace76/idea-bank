import {randomBytes,createHash,timingSafeEqual} from "node:crypto";
import {getOwnerSession} from "@/auth";
import {NextResponse} from "next/server";
import {AgentAuthError,mcpSettings,openAgentValue,parseAuthorization,sealAgentValue,type Authorization,type OAuthClient} from "./mcp-auth";
import {agentErrorResponse,agentHeaders,boundedAgentBody} from "./mcp-http";

const consentCookie="idea-bank-mcp-consent",providerCookie="idea-bank-mcp-provider";
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const cookie=(request:Request,name:string)=>request.headers.get("cookie")?.split(";").map(value=>value.trim()).find(value=>value.startsWith(`${name}=`))?.slice(name.length+1) || "";
const equal=(left:string,right:string)=>left.length===right.length&&timingSafeEqual(Buffer.from(left),Buffer.from(right));
const escape=(value:string)=>value.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]!);
function setCookie(response:NextResponse,name:string,value:string,maxAge=600){response.cookies.set(name,value,{httpOnly:true,secure:new URL(mcpSettings().issuer).protocol==="https:",sameSite:"lax",path:"/api/mcp/oauth",maxAge});}
function redirectClient(authorization:Authorization,params:Record<string,string>){const url=new URL(authorization.redirect);for(const [key,value] of Object.entries({...params,state:authorization.state,iss:mcpSettings().issuer}))url.searchParams.set(key,value);return NextResponse.redirect(url,303);}
export async function agentConsent(request:Request){
  try{
    const settings=mcpSettings();
    if(request.method==="GET"){
      const authorization=parseAuthorization(new URL(request.url).searchParams),owner=await getOwnerSession();
      if(!owner){const signIn=new URL("/",settings.issuer);signIn.searchParams.set("agentReturn",`/api/mcp/oauth/authorize?${new URL(request.url).searchParams}`);return NextResponse.redirect(signIn,303);}
      const client=openAgentValue<OAuthClient>("client",authorization.client),nonce=randomBytes(24).toString("base64url"),pending=sealAgentValue("consent",{authorization,nonce:hash(nonce)},600),canWrite=authorization.scopes.includes("ideas:write");
      const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect agent · Idea Bank</title><style>body{font:17px/1.6 system-ui;background:#202328;color:#eef0f3;max-width:620px;margin:8vh auto;padding:24px}main{padding:28px;border:1px solid #68727e;border-radius:20px;background:#2b3037}h1{font-size:26px;line-height:1.25}button{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid #8898aa;margin:12px 8px 0 0;cursor:pointer}button[value=allow]{background:#bccde0;color:#19232d}small{display:block;overflow-wrap:anywhere;color:#b5bec9}</style><main><h1>Connect ${escape(client.name)} to Idea Bank?</h1><p>The agent will be allowed to ${canWrite?"read, create and edit":"read"} your saved ideas and attachments.</p><p>Only approve this if you started the connection yourself.</p><small>Return address: ${escape(authorization.redirect)}</small><form method="post"><input type="hidden" name="request" value="${escape(pending)}"><button name="decision" value="allow">Allow access</button><button name="decision" value="deny">Cancel</button></form><p><small>Access tokens last five minutes. You can revoke this authorization in GitHub → Settings → Applications → Authorized GitHub Apps. Existing access tokens may remain valid for up to five minutes.</small></p></main></html>`;
      const response=new NextResponse(html,{headers:{...agentHeaders,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});setCookie(response,consentCookie,nonce);return response;
    }
    if(request.headers.get("origin")!==settings.issuer || request.headers.get("sec-fetch-site")==="cross-site" || !await getOwnerSession())throw new AgentAuthError("access_denied","Owner sign-in and same-origin consent are required.",403);
    const form=await boundedAgentBody(request,true) as URLSearchParams,pending=openAgentValue<{authorization:Authorization;nonce:string}>("consent",form.get("request") || "");
    if(!equal(pending.nonce,hash(cookie(request,consentCookie))))throw new AgentAuthError("access_denied","The consent session expired. Start the connection again.",403);
    if(form.get("decision")!=="allow"){const response=redirectClient(pending.authorization,{error:"access_denied",error_description:"The owner declined access."});setCookie(response,consentCookie,"",0);return response;}
    const nonce=randomBytes(24).toString("base64url"),state=sealAgentValue("provider-state",{authorization:pending.authorization,nonce:hash(nonce)},600),url=new URL("https://github.com/login/oauth/authorize");
    for(const [key,value] of Object.entries({client_id:settings.clientId,redirect_uri:settings.callback,state,scope:"offline_access",code_challenge:pending.authorization.challenge,code_challenge_method:"S256"}))url.searchParams.set(key,value);
    const response=NextResponse.redirect(url,303);setCookie(response,consentCookie,"",0);setCookie(response,providerCookie,nonce);return response;
  }catch(error){return agentErrorResponse(error);}
}
export function agentProviderCallback(request:Request){
  try{
    mcpSettings();const params=new URL(request.url).searchParams,pending=openAgentValue<{authorization:Authorization;nonce:string}>("provider-state",params.get("state") || "");
    if(!equal(pending.nonce,hash(cookie(request,providerCookie))))throw new AgentAuthError("access_denied","The GitHub callback does not belong to this browser session.",403);
    const providerCode=params.get("code");
    const response=params.has("error")?redirectClient(pending.authorization,{error:"access_denied",error_description:"GitHub authorization was cancelled."}):providerCode && providerCode.length<2000?redirectClient(pending.authorization,{code:sealAgentValue("code",{authorization:pending.authorization,providerCode},300)}):(()=>{throw new AgentAuthError("invalid_request","GitHub did not return an authorization code.");})();
    setCookie(response,providerCookie,"",0);return response;
  }catch(error){return agentErrorResponse(error);}
}

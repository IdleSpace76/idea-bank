"use client";
import {useEffect,useState} from "react";
import {createMD5,createSHA256} from "hash-wasm";
import {useI18n} from "./language-picker";

export function AgentUploadForm({authenticated}:{authenticated:boolean}){
  const {t}=useI18n(),[ticket,setTicket]=useState(""),[login,setLogin]=useState(""),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[status,setStatus]=useState(""),[error,setError]=useState(""),[result,setResult]=useState("");
  useEffect(()=>{setTicket(new URLSearchParams(window.location.hash.slice(1)).get("ticket") || "");setLogin(`/?agentReturn=${encodeURIComponent(window.location.pathname+window.location.hash)}`);},[]);
  async function send(action:string,metadata:unknown,name:string,kind:string){
    const response=await fetch("/api/mcp/uploads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticket,action,file:metadata,name,kind}),redirect:"error"});
    const data=await response.json();if(!response.ok)throw new Error(data.error_description || t("Не удалось прикрепить файл. Попросите агента обновить версию идеи и повторить действие."));return data;
  }
  async function upload(){
    if(!file || busy)return;setBusy(true);setError("");
    try{
      if(file.size<1 || file.size>1024*1024*1024)throw new Error(t("Выберите файл размером до 1 ГиБ."));
      const mime=/\.glb$/i.test(file.name)?"model/gltf-binary":/\.gltf$/i.test(file.name)?"model/gltf+json":file.type;
      const kind=mime.startsWith("image/")?"image":mime.startsWith("audio/")?"audio":mime.startsWith("video/")?"video":"model";
      if(mime==="model/gltf+json"){
        const model=JSON.parse(await file.text()),refs=[...(model.buffers || []),...(model.images || [])].flatMap(row=>typeof row.uri==="string"?[row.uri]:[]);
        if(refs.some(uri=>!uri.startsWith("data:")))throw new Error(t("Выберите GLB или самодостаточный glTF без внешних файлов."));
      }
      setStatus(t("Проверяем файл…"));const [sha,md5]=await Promise.all([createSHA256(),createMD5()]);sha.init();md5.init();
      const reader=file.stream().getReader();try{for(;;){const part=await reader.read();if(part.done)break;sha.update(part.value);md5.update(part.value);}}finally{reader.releaseLock();}
      const sha256=sha.digest("hex"),digest=md5.digest("hex"),metadata={id:`${sha256}-${digest}`,sha256,md5:digest,size:file.size,mime};
      const prepared=await send("prepare",metadata,file.name,kind);setStatus(t("Загружаем вложение…"));
      if(!prepared.alreadyUploaded){const response=await fetch(prepared.url,{method:"PUT",headers:prepared.headers,body:file,redirect:"error"});if(!response.ok)throw new Error(t("Загрузка файла не завершена. Повторите попытку."));}
      setStatus(t("Прикрепляем файл к идее…"));const saved=await send("finish",metadata,file.name,kind);setResult(saved.idea_url);setStatus(t("Вложение сохранено. Можно вернуться к агенту."));
    }catch(reason){setStatus("");setError(reason instanceof Error?reason.message:t("Не удалось прикрепить файл. Попросите агента обновить версию идеи и повторить действие."));}
    finally{setBusy(false);}
  }
  return <main className="agent-upload-page"><h1>{t("Прикрепить файл к идее")}</h1>{!authenticated?<><p>{t("Для загрузки войдите как владелец Idea Bank.")}</p><a className="primary-button" href={login}>{t("Войти через GitHub")}</a></>:result?<><p role="status">{status}</p><a className="primary-button" href={result}>{t("Открыть идею")}</a></>:<><p>{t("Выберите оригинал изображения, видео, аудио или 3D-модели для идеи, подготовленной агентом.")}</p><input type="file" aria-label={t("Выбрать вложение")} accept="image/*,audio/*,video/*,.glb,.gltf" disabled={busy || !ticket} onChange={event=>setFile(event.target.files?.[0] || null)} /><button className="primary-button" disabled={!file || busy || !ticket} onClick={()=>{void upload();}}>{t("Прикрепить")}</button>{status&&<p role="status">{status}</p>}{error&&<p role="alert" className="backup-error">{error}</p>}{!ticket&&<p role="alert">{t("Ссылка загрузки отсутствует. Попросите агента подготовить её заново.")}</p>}</>}</main>;
}

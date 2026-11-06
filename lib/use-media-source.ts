"use client";
import { translate as t } from "./i18n";
import { useEffect, useState, type RefObject } from "react";
import { getMediaFile } from "./media-cache";
import { useMediaScope } from "../components/media-scope";
import { retryCloudAccess } from "./cloud-access";

/** Load at first visibility, then keep the source until the file changes or the preview unmounts. */
export function useMediaSource(id?: string, file?: Blob, target?: RefObject<HTMLElement | null>) {
  const scope = useMediaScope();
  const [source,setSource] = useState(""), [error,setError] = useState("");
  const [visible,setVisible] = useState(!target), [attempt,setAttempt] = useState(0);
  const retry=()=>{if(scope)retryCloudAccess();setAttempt(value=>value+1);};
  useEffect(()=>{
    if(!target?.current || typeof IntersectionObserver==="undefined"){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:"200px"});
    observer.observe(target.current);return()=>observer.disconnect();
  },[target]);
  useEffect(()=>{if(!error)return;const online=()=>setAttempt(value=>value+1);window.addEventListener("online",online);return()=>window.removeEventListener("online",online);},[error]);
  useEffect(()=>{
    let cancelled=false,url="";
    setSource("");setError("");
    if(!id || !visible)return;
    async function load(){
      try{
        const blob=file || await getMediaFile(id!,scope);
        if(cancelled)return;
        if(!blob){setError(t("Файл не найден на этом устройстве."));return;}
        url=URL.createObjectURL(blob);setSource(url);
      }catch(reason){if(!cancelled)setError(reason instanceof Error?reason.message:t("Не удалось открыть файл из хранилища браузера."));}
    }
    void load();
    return()=>{cancelled=true;if(url)URL.revokeObjectURL(url);};
  },[id,file,scope,visible,attempt]);
  return {source,error,setError,retry};
}

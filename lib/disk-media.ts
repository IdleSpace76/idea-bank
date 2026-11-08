import { createHash,randomUUID } from "node:crypto";
import { mkdir,lstat,open,rename,unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { DiskSettings } from "./disk-settings";

export type DiskMediaInput={id:string;size:number;mime:string;data:Uint8Array|Blob|AsyncIterable<Uint8Array>};
export type DiskMediaRecord={id:string;size:number;mime:string;sha256:string};
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==="ENOENT";
const digestPattern=/^[a-f0-9]{64}$/;

async function* chunks(data:DiskMediaInput["data"]):AsyncGenerator<Uint8Array> {
  if(data instanceof Uint8Array){yield data;return;}
  if(data instanceof Blob){
    const reader=data.stream().getReader();
    try{for(;;){const item=await reader.read();if(item.done)break;yield item.value;}}
    finally{reader.releaseLock();}
  }else for await(const chunk of data)yield chunk;
}

/** Immutable, content-addressed files; media IDs and names never become filesystem paths. */
export class DiskMediaStore {
  constructor(readonly settings:DiskSettings){}
  async initialize() {
    for(const directory of [this.settings.root,this.settings.media,this.settings.temporary]){
      await mkdir(directory,{recursive:true,mode:0o700});
      const stat=await lstat(directory);if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error("Папка хранилища должна быть обычным каталогом.");
    }
  }
  filePath(sha256:string) {
    if(!digestPattern.test(sha256))throw new Error("Некорректный хеш медиафайла.");
    return path.join(this.settings.media,`${sha256}.bin`);
  }
  /** Finish and flush a temporary file before atomically publishing its immutable name. */
  async prepare(input:DiskMediaInput,protect?:(sha256:string)=>void):Promise<DiskMediaRecord> {
    if(typeof input.id!=="string" || !input.id.trim() || !Number.isSafeInteger(input.size) || input.size<0 || typeof input.mime!=="string" || !input.mime.trim())throw new Error("Некорректное описание медиафайла.");
    const temporary=path.join(this.settings.temporary,`${process.pid}-${randomUUID()}.tmp`),handle=await open(temporary,"wx",0o600),hash=createHash("sha256");let size=0;
    try{
      for await(const bytes of chunks(input.data)){
        if(!(bytes instanceof Uint8Array))throw new Error("Некорректные данные медиафайла.");
        size+=bytes.byteLength;if(size>input.size)throw new Error("Размер медиафайла не совпадает с описанием.");
        hash.update(bytes);let offset=0;
        while(offset<bytes.byteLength){const {bytesWritten}=await handle.write(bytes,offset,bytes.byteLength-offset);if(!bytesWritten)throw new Error("Не удалось записать медиафайл.");offset+=bytesWritten;}
      }
      if(size!==input.size)throw new Error("Размер медиафайла не совпадает с описанием.");
      await handle.sync();await handle.close();
      const sha256=hash.digest("hex"),record={id:input.id,size,mime:input.mime,sha256},destination=this.filePath(sha256);
      protect?.(sha256);
      if(await this.matches(record)){await unlink(temporary);return record;}
      try{await rename(temporary,destination);}
      catch(error){if(!await this.matches(record))throw error;await unlink(temporary);}
      // Directory fsync makes the published name durable where the platform supports it.
      let directory:Awaited<ReturnType<typeof open>>|undefined;
      try{directory=await open(this.settings.media,"r");await directory.sync();}
      catch(error){if(!["EISDIR","EINVAL","EPERM","EACCES","ENOTSUP"].includes((error as NodeJS.ErrnoException).code || ""))throw error;}
      finally{await directory?.close();}
      return record;
    }catch(error){await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error;}
  }
  private async matches(record:DiskMediaRecord):Promise<boolean> {
    const file=this.filePath(record.sha256);let stat;
    try{stat=await lstat(file);}catch(error){if(missing(error))return false;throw error;}
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size!==record.size)throw new Error("Существующий медиафайл повреждён.");
    const hash=createHash("sha256");for await(const bytes of createReadStream(file))hash.update(bytes);
    if(hash.digest("hex")!==record.sha256)throw new Error("Существующий медиафайл повреждён.");return true;
  }
}

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import ts from "typescript";
const directory = new URL("../.cache/entity-check/",import.meta.url);
await mkdir(directory,{ recursive:true });
for (const name of ["example-media","rich-text","ideas","cloud-library","b2-storage","entity-sync","entity-storage","catalog-storage","storage-read-cache","i18n","translations","library-store","local-database","cloud-state","media-store","cloud-sync","cloud-access","entity-client","media-cache-store","scoped-types","scoped-store","scoped-client","scoped-overlay","reader-cache","reader-batch-types","shared-reader-check","sync-lock"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`,import.meta.url),"utf8");
  await writeFile(new URL(`${name}.js`,directory),ts.transpileModule(source,{ compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true } }).outputText);
}
const require = createRequire(import.meta.url);
export const { B2Storage } = require(fileURLToPath(new URL("b2-storage.js",directory)));
export const { EntityStorage } = require(fileURLToPath(new URL("entity-storage.js",directory)));
export const client = require(fileURLToPath(new URL("entity-client.js",directory)));
export const schema = require(fileURLToPath(new URL("entity-sync.js",directory)));
export const storageCache = require(fileURLToPath(new URL("storage-read-cache.js",directory)));
export function memoryStorage() {
  const storage = new B2Storage({ endpoint:"https://s3.eu-central-003.backblazeb2.com",region:"eu-central-003",bucket:"fixture-bucket",keyId:`fixture-key-${randomUUID()}`,applicationKey:"fixture-secret" });
  const objects = new Map(); let puts = [], getCount = 0;
  storage.client.send = async command => {
    const input=command.input, name=command.constructor.name;
    if (name === "ListObjectsV2Command") return { Contents:[...objects.keys()].filter(k => k.startsWith(input.Prefix)).map(Key=>({Key})) };
    if (name === "PutObjectCommand") {
      if (objects.has(input.Key)) { if (String(objects.get(input.Key).body) !== String(input.Body)) throw new Error("Immutable object overwritten"); }
      objects.set(input.Key,{ body:input.Body,type:input.ContentType,metadata:input.Metadata,md5:createHash("md5").update(input.Body).digest("hex") }); puts.push(input.Key); return {};
    }
    if (name === "DeleteObjectCommand") { objects.delete(input.Key); return {}; }
    const object=objects.get(input.Key); if (!object) { const error = new Error("Missing fixture object"); error.name="NotFound"; throw error; }
    if (name === "HeadObjectCommand") return { ContentLength:Buffer.byteLength(object.body),ContentType:object.type,Metadata:object.metadata,ETag:`"${object.md5}"` };
    if (name === "GetObjectCommand") { getCount++; return { ContentLength:Buffer.byteLength(object.body),Body:{ transformToString:async()=>String(object.body) } }; }
    throw new Error(`Unexpected ${name}`);
  };
  return { storage,objects,puts,get getCount(){return getCount;},entities:()=>new EntityStorage(storage) };
}

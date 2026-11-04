import { createHash, randomUUID } from "node:crypto";
import { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MAX_CLOUD_JSON_BYTES, StorageError, parseCloudMedia, parseCloudSave, parseCloudSnapshot, revisionPattern, type CloudMedia, type CloudSnapshot } from "./cloud-library";

export type B2Settings = { endpoint: string; region: string; bucket: string; keyId: string; applicationKey: string };
const noStore = { "Cache-Control": "private, no-store" };
export { noStore };

/** B2 is optional; partial configuration fails closed instead of falling back to another bucket. */
export function readB2Settings(env: Record<string, string | undefined> = process.env): B2Settings {
  const keys = ["B2_S3_ENDPOINT", "B2_REGION", "B2_BUCKET_NAME", "B2_KEY_ID", "B2_APPLICATION_KEY"];
  if (keys.some(key => !env[key]?.trim())) throw new StorageError(503, "STORAGE_NOT_CONFIGURED", "Хранилище B2 не настроено.");
  const region = env.B2_REGION!, endpoint = env.B2_S3_ENDPOINT!.replace(/\/$/, ""), bucket = env.B2_BUCKET_NAME!;
  if (!/^[a-z0-9-]+$/.test(region) || endpoint !== `https://s3.${region}.backblazeb2.com` || !/^[a-zA-Z0-9][a-zA-Z0-9-]{4,61}[a-zA-Z0-9]$/.test(bucket)) throw new StorageError(503, "STORAGE_NOT_CONFIGURED", "Проверь регион, адрес и имя хранилища B2.");
  return { endpoint, region, bucket, keyId: env.B2_KEY_ID!, applicationKey: env.B2_APPLICATION_KEY! };
}
function missing(error: unknown) { const e = error as { name?: string; $metadata?: { httpStatusCode?: number } }; return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404; }

/** Immutable snapshot graph preserves concurrent saves, including across serverless instances. */
export class B2Storage {
  readonly client: S3Client;
  constructor(readonly settings: B2Settings, readonly prefix = "idea-bank/v1") {
    if (!/^[a-zA-Z0-9/-]+$/.test(prefix) || prefix.includes("..")) throw new Error("Invalid storage prefix");
    this.client = new S3Client({ endpoint: settings.endpoint, region: settings.region, credentials: { accessKeyId: settings.keyId, secretAccessKey: settings.applicationKey }, forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 2, requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 } });
  }
  private mediaKey(file: CloudMedia) { return `${this.prefix}/media/${file.sha256}-${file.md5}`; }
  private revisionKey(revision: string, parents: string[]) { return `${this.prefix}/revisions/${parents.join("+") || "root"}_${revision}.json`; }

  /** Paginated listing exposes branches rather than choosing an arbitrary last writer. */
  async listRevisions() {
    const revisions = new Map<string, { parents: string[]; key: string }>();
    const prefix = `${this.prefix}/revisions/`;
    let continuation: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.settings.bucket, Prefix: prefix, ContinuationToken: continuation }));
      for (const object of page.Contents || []) {
        const name = object.Key?.slice(prefix.length);
        const match = name && /^(root|[a-f0-9+-]+)_([a-f0-9-]{36})\.json$/.exec(name);
        const parents = match?.[1] === "root" ? [] : (match?.[1] || "").split("+");
        if (!match || !revisionPattern.test(match[2]) || parents.length > 16 || parents.some(id => !revisionPattern.test(id)) || new Set(parents).size !== parents.length || revisions.has(match[2])) throw new StorageError(502, "INVALID_HISTORY", "История библиотеки повреждена.");
        revisions.set(match[2], { parents, key: object.Key! });
        if (revisions.size > 10000) throw new StorageError(507, "HISTORY_LIMIT", "Достигнут лимит в 10 000 версий библиотеки.");
      }
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !continuation) throw new StorageError(502, "INVALID_HISTORY", "Не удалось прочитать историю целиком.");
    } while (continuation);
    const parents = new Set<string>();
    for (const entry of revisions.values()) for (const parent of entry.parents) {
      if (!revisions.has(parent)) throw new StorageError(502, "INVALID_HISTORY", "В истории отсутствует родительская версия.");
      parents.add(parent);
    }
    const heads = [...revisions.keys()].filter(id => !parents.has(id)).sort();
    // Iterative DFS handles long histories and merge nodes without recursion limits.
    const states = new Map<string, number>();
    for (const id of revisions.keys()) {
      const stack: [string, boolean][] = [[id, false]];
      while (stack.length) {
        const [current, exit] = stack.pop()!;
        if (exit) { states.set(current, 2); continue; }
        if (states.get(current) === 2) continue;
        if (states.get(current) === 1) throw new StorageError(502, "INVALID_HISTORY", "В истории найден цикл.");
        states.set(current, 1); stack.push([current, true]);
        for (const parent of revisions.get(current)!.parents) stack.push([parent, false]);
      }
    }
    return { revisions, heads };
  }

  async readLibrary(revision?: string): Promise<{ snapshot: CloudSnapshot | null; heads: string[] }> {
    if (revision && !revisionPattern.test(revision)) throw new StorageError(400, "INVALID_REVISION", "Неверный номер версии.");
    const history = await this.listRevisions();
    if (!revision && history.heads.length > 1) throw new StorageError(409, "CONFLICT", "Есть одновременные изменения. Обе версии сохранены.", history.heads);
    const selected = revision || history.heads[0];
    if (!selected) return { snapshot: null, heads: [] };
    const entry = history.revisions.get(selected);
    if (!entry) throw new StorageError(404, "NOT_FOUND", "Версия не найдена.");
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.settings.bucket, Key: entry.key }));
    if (!object.Body || !object.ContentLength || object.ContentLength > MAX_CLOUD_JSON_BYTES) throw new StorageError(502, "INVALID_SNAPSHOT", "Неверный размер облачной библиотеки.");
    let snapshot: CloudSnapshot;
    try { snapshot = parseCloudSnapshot(JSON.parse(await object.Body.transformToString())); }
    catch { throw new StorageError(502, "INVALID_SNAPSHOT", "Облачная библиотека не прошла проверку."); }
    if (snapshot.revision !== selected || JSON.stringify(snapshot.parents) !== JSON.stringify(entry.parents)) throw new StorageError(502, "INVALID_SNAPSHOT", "Версия библиотеки не совпадает с историей.");
    return { snapshot, heads: history.heads };
  }

  /** Check every referenced object before publishing metadata; existing snapshots are never overwritten. */
  async saveLibrary(input: unknown) {
    const saved = parseCloudSave(input);
    await this.assertLegacyWritable();
    const before = await this.listRevisions();
    if (JSON.stringify(before.heads) !== JSON.stringify(saved.baseRevisions)) throw new StorageError(409, "CONFLICT", "Библиотека изменилась на другом устройстве. Локальные изменения не перезаписаны.", before.heads);
    for (let start = 0; start < saved.media.length; start += 12) await Promise.all(saved.media.slice(start, start + 12).map(file => this.verifyMedia(file)));
    const snapshot: CloudSnapshot = { format: "idea-bank-cloud", version: 1, revision: randomUUID(), parents: saved.baseRevisions, createdAt: new Date().toISOString(), library: saved.library, media: saved.media };
    const body = JSON.stringify(snapshot);
    if (Buffer.byteLength(body) > MAX_CLOUD_JSON_BYTES) throw new StorageError(413, "LIBRARY_TOO_LARGE", "Текстовое описание библиотеки превышает 3 МиБ.");
    await this.assertLegacyWritable();
    await this.client.send(new PutObjectCommand({ Bucket: this.settings.bucket, Key: this.revisionKey(snapshot.revision, snapshot.parents), Body: body, ContentType: "application/json", ContentMD5: createHash("md5").update(body).digest("base64") }));
    await this.assertLegacyWritable();
    const after = await this.listRevisions();
    if (after.heads.length !== 1 || after.heads[0] !== snapshot.revision) throw new StorageError(409, "CONFLICT", "Обнаружено одновременное сохранение. Обе версии сохранены.", after.heads);
    return { snapshot, heads: after.heads };
  }

  async verifyMedia(value: unknown) {
    const file = parseCloudMedia(value);
    let head;
    try { head = await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: this.mediaKey(file) })); }
    catch (error) { if (missing(error)) throw new StorageError(422, "MEDIA_MISSING", "Сначала загрузи все вложения в B2."); throw error; }
    if (head.ContentLength !== file.size || head.ContentType !== file.mime || head.Metadata?.sha256 !== file.sha256 || head.ETag?.replaceAll('"', "") !== file.md5) throw new StorageError(422, "MEDIA_MISMATCH", "Размер или контрольная сумма вложения не совпадают.");
    return file;
  }

  /** The browser receives a scoped URL, never the B2 application key. */
  async createUpload(value: unknown) {
    const file = parseCloudMedia(value);
    try { await this.verifyMedia(file); return { alreadyUploaded: true, media: file }; }
    catch (error) { if (!(error instanceof StorageError) || error.code !== "MEDIA_MISSING") throw error; }
    const md5 = Buffer.from(file.md5, "hex").toString("base64");
    const command = new PutObjectCommand({ Bucket: this.settings.bucket, Key: this.mediaKey(file), ContentLength: file.size, ContentType: file.mime, ContentMD5: md5, Metadata: { sha256: file.sha256 } });
    const url = await getSignedUrl(this.client, command, { expiresIn: 300, signableHeaders: new Set(["content-type", "content-md5", "content-length"]), unhoistableHeaders: new Set(["x-amz-meta-sha256"]) });
    return { alreadyUploaded: false, media: file, url, method: "PUT", expiresIn: 300, headers: { "Content-Type": file.mime, "Content-MD5": md5, "x-amz-meta-sha256": file.sha256 } };
  }

  async createDownload(revision: string, mediaId: string) {
    const { snapshot } = await this.readLibrary(revision);
    const file = snapshot?.media.find(item => item.id === mediaId);
    if (!file) throw new StorageError(404, "NOT_FOUND", "Вложение не найдено в этой версии.");
    return this.signDownload(file);
  }

  async assertLegacyWritable() {
    try { await this.client.send(new HeadObjectCommand({ Bucket: this.settings.bucket, Key: `${this.prefix}/sync-v2/legacy-lock.json` })); }
    catch (error) { if (missing(error)) return; throw error; }
    throw new StorageError(409, "CLIENT_UPGRADE_REQUIRED", "Обнови приложение: используется новая синхронизация.");
  }
  async signDownload(value: CloudMedia) {
    const file = await this.verifyMedia(value);
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.settings.bucket, Key: this.mediaKey(file), ResponseContentDisposition: "attachment", ResponseContentType: file.mime }), { expiresIn: 300 });
    return { url, expiresIn: 300, media: file };
  }
}

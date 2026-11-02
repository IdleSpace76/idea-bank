import { describeMediaFile } from "./media-store";
import type { MediaAsset } from "./ideas";

/** Embeds explicitly selected glTF resources so the saved/downloaded model is self-contained. */
export async function prepareMediaFiles(files: File[]) {
  const assets: MediaAsset[] = [], blobs = new Map<string, Blob>(), errors: string[] = [];
  const consumed = new Set<File>(), candidates = files.filter(file => /\.gltf$/i.test(file.name));
  const folder = files.some(file => !!file.webkitRelativePath);
  for (const file of candidates) {
    try {
      const doc = JSON.parse(await file.text());
      if (!doc || String(doc.asset?.version) !== "2.0") throw new Error("нужен glTF версии 2.0");
      const dependencies = new Set<File>();
      for (const entry of [...(doc.buffers || []), ...(doc.images || [])]) {
        if (typeof entry.uri !== "string" || /^data:/i.test(entry.uri)) continue;
        if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(entry.uri)) throw new Error("внешние ссылки не загружаются; добавь ресурсы локально или экспортируй GLB");
        const path = decodeURIComponent(entry.uri).replaceAll("\\", "/").split(/[?#]/)[0];
        const name = path.split("/").pop();
        const relative = decodeURIComponent(new URL(entry.uri, `https://model.local/${file.webkitRelativePath || file.name}`).pathname).slice(1);
        const exact = files.filter(resource => resource !== file && resource.webkitRelativePath === relative);
        const matches = exact.length ? exact : files.filter(resource => resource !== file && resource.name === name);
        if (matches.length !== 1) throw new Error(`${matches.length ? "неоднозначное имя ресурса" : "не хватает файла"}: ${path}. Выбери модель и все её ресурсы вместе либо экспортируй GLB`);
        const resource = matches[0];
        const uri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`не удалось прочитать ${resource.name}`)); reader.readAsDataURL(resource); });
        entry.uri = uri; dependencies.add(resource);
      }
      const blob = new Blob([JSON.stringify(doc)], { type: "model/gltf+json" });
      const asset = describeMediaFile(file)!; asset.size = blob.size;
      assets.push(asset); blobs.set(asset.id, blob); dependencies.forEach(resource => consumed.add(resource));
    } catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : "не удалось прочитать модель"}`); }
    consumed.add(file);
  }
  for (const file of files) {
    if (consumed.has(file) || (folder && !/\.(glb|gltf)$/i.test(file.name))) continue;
    const asset = describeMediaFile(file);
    if (asset) { assets.push(asset); blobs.set(asset.id, file); }
    else errors.push(`${file.name}: поддерживаются фото, видео, аудио и модели GLB/glTF (кроме SVG)`);
  }
  // Keep the user's file order after consuming textures and binary model resources.
  assets.sort((a, b) => files.findIndex(file => file.name === a.name) - files.findIndex(file => file.name === b.name));
  if (folder && !assets.length && !errors.length) errors.push("В папке не найдены модели GLB или glTF.");
  return { assets, blobs, errors };
}

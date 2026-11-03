import type { MediaAsset } from "./ideas";

export const exampleMedia: MediaAsset[] = [
  {
    "id": "example-robot-image",
    "name": "little-robot.png",
    "kind": "image",
    "mime": "image/png",
    "size": 12309,
    "displaySize": {
      "width": 220,
      "height": 260
    }
  },
  {
    "id": "example-robot-model",
    "name": "little-robot.glb",
    "kind": "model",
    "mime": "model/gltf-binary",
    "size": 3188,
    "displaySize": {
      "width": 220,
      "height": 260
    }
  }
];

/** Fetch only bundled public samples, checking their sizes before storing or restoring them. */
export async function loadExampleMedia(): Promise<Map<string, Blob>> {
  const files = new Map<string, Blob>();
  for (const asset of exampleMedia) {
    const response = await fetch(`/examples/${asset.name}`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Could not load Example media.");
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== asset.size) throw new Error("Example media has an unexpected size.");
    files.set(asset.id, new Blob([bytes], { type: asset.mime }));
  }
  return files;
}

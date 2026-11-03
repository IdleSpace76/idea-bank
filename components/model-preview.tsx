"use client";
import { useI18n } from "./language-picker";

import { useEffect, useRef, useState } from "react";
import { Box, LoaderCircle, RotateCcw } from "lucide-react";
import type { Object3D, Material, Texture, Mesh } from "three";

/** A lazy, local-only 3D viewport; owns and releases its GPU resources. */
export default function ModelPreview({ source, name }: { source: string; name: string }) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const reset = useRef<() => void>(() => {});
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setActive(entries[0].isIntersecting), { rootMargin: "150px" });
    observer.observe(host.current!); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let cleanup = () => {};
    setStatus("loading"); setError("");
    function release(object: Object3D) {
      const textures = new Set<Texture>(), materials = new Set<Material>();
      object.traverse(node => {
        const mesh = node as Mesh;
        mesh.geometry?.dispose();
        for (const material of mesh.material ? Array.isArray(mesh.material) ? mesh.material : [mesh.material] : []) materials.add(material);
      });
      materials.forEach(material => { for (const value of Object.values(material)) if (value && typeof value === "object" && value.isTexture) textures.add(value as Texture); material.dispose(); });
      textures.forEach(texture => { const image = texture.source?.data; if (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) image.close(); texture.dispose(); });
    }
    async function start() {
      const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([import("three"), import("three/addons/loaders/GLTFLoader.js"), import("three/addons/controls/OrbitControls.js")]);
      if (disposed) return;
      const element = host.current!;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.setAttribute("role", "img"); renderer.domElement.setAttribute("aria-label", t("3D-модель {0}", { 0: name }));
      renderer.domElement.tabIndex = 0;
      element.prepend(renderer.domElement);
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, .01, 100);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x778399, 2.5));
      const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(3, 5, 4); scene.add(light);
      const fill = new THREE.DirectionalLight(0xc5dcff, 1.5); fill.position.set(-3, 1, -3); scene.add(fill);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.minDistance = .1; controls.maxDistance = 30;
      controls.cursorStyle = "grab"; controls.listenToKeyEvents(renderer.domElement);
      const render = () => { if (!disposed) renderer.render(scene, camera); };
      controls.addEventListener("change", render);
      const fit = () => {
        const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
        const angle = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
        const distance = 1.15 / Math.sin(angle);
        camera.position.copy(new THREE.Vector3(1, .7, 1).normalize().multiplyScalar(distance));
        controls.target.set(0, 0, 0); controls.update(); render();
      };
      reset.current = fit;
      let object: Object3D | undefined;
      const observer = new ResizeObserver(() => {
        const width = element.clientWidth, height = element.clientHeight;
        if (!width || !height) return;
        camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); render();
      });
      observer.observe(element);
      const contextLost = (event: Event) => { event.preventDefault(); if (!disposed) { setStatus("error"); setError(t("3D-просмотр остановлен браузером. Обнови страницу или скачай модель.")); } };
      renderer.domElement.addEventListener("webglcontextlost", contextLost);
      let cleaned = false;
      cleanup = () => {
        if (cleaned) return; cleaned = true;
        observer.disconnect(); controls.dispose(); controls.removeEventListener("change", render);
        renderer.domElement.removeEventListener("webglcontextlost", contextLost);
        if (object) release(object);
        renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); reset.current = () => {};
      };
      const manager = new THREE.LoadingManager();
      manager.setURLModifier(url => {
        if (url === source || url.startsWith(`blob:${location.origin}/`) || /^data:(?:image\/|application\/octet-stream|application\/gltf-buffer)/i.test(url)) return url;
        throw new Error(t("В модели есть внешние ресурсы. Загрузи glTF вместе с файлами или экспортируй GLB."));
      });
      const gltf = await new GLTFLoader(manager).loadAsync(source);
      if (disposed) { release(gltf.scene); return; }
      object = gltf.scene;
      const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty()) throw new Error(t("В модели нет объектов для отображения."));
      const center = box.getCenter(new THREE.Vector3()), radius = box.getBoundingSphere(new THREE.Sphere()).radius;
      if (!Number.isFinite(radius) || radius <= 0) throw new Error(t("Не удалось определить размеры модели."));
      object.position.sub(center);
      const group = new THREE.Group(); group.add(object); group.scale.setScalar(1 / radius); scene.add(group);
      camera.aspect = element.clientWidth / Math.max(1, element.clientHeight); camera.updateProjectionMatrix();
      renderer.setSize(element.clientWidth, element.clientHeight, false); fit();
      setStatus("ready");
    }
    void start().catch(reason => {
      if (disposed) return;
      cleanup(); setStatus("error");
      const detail = reason instanceof Error ? reason.message : "";
      setError([t("В модели есть внешние ресурсы. Загрузи glTF вместе с файлами или экспортируй GLB."), t("В модели нет объектов для отображения."), t("Не удалось определить размеры модели.")].includes(detail) ? detail : /WebGL/i.test(detail) ? t("Для 3D-просмотра нужен WebGL. Проверь настройки браузера; модель можно скачать.") : t("Не удалось показать модель. Нужен корректный GLB/glTF 2.0 без Draco/KTX2-сжатия. Оригинал можно скачать."));
    });
    return () => { disposed = true; cleanup(); };
  }, [source, name, active]);
  return <div ref={host} className="model-preview" data-state={t(status)} aria-busy={active && status === "loading"}>
    {status !== "ready" && <div className="model-status" role={status === "error" ? "alert" : "status"}>{status === "error" ? <Box /> : <LoaderCircle />}<span>{error || t("Загружаем 3D-модель…")}</span></div>}
    {status === "ready" && <button type="button" className="icon-button model-reset" title={t("Вернуть исходный ракурс")} aria-label={t("Сбросить ракурс {0}", { 0: name })} onClick={() => reset.current()}><RotateCcw /></button>}
  </div>;
}

"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, Download, ImageOff, LoaderCircle, MoveDiagonal2, RotateCcw, X } from "lucide-react";
import type { MediaAsset, MediaDisplaySize } from "@/lib/ideas";
import { useMediaSource } from "@/lib/use-media-source";
import dynamic from "next/dynamic";

const ModelPreview = dynamic(() => import("./model-preview"), { ssr: false, loading: () => <div className="media-loading"><LoaderCircle />Загружаем 3D-просмотр…</div> });

type ResizeMedia = (id: string, size: MediaDisplaySize | undefined) => void;

export function MediaGallery({ assets, pending, onRemove, onReorder, onResize }: { assets: MediaAsset[]; pending?: ReadonlyMap<string, Blob>; onRemove?: (id: string) => void; onReorder?: (assets: MediaAsset[]) => void; onResize?: ResizeMedia }) {
  const gallery = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const element = gallery.current; if (!element) return;
    // Keep the old automatic column density until an individual item is resized.
    const observer = new ResizeObserver(() => setColumns(Math.max(1, Math.min(assets.length, Math.floor((element.clientWidth + 14) / 194)))));
    observer.observe(element); return () => observer.disconnect();
  }, [assets.length]);
  if (!assets.length) return null;
  function move(index: number, direction: number) { const next = [...assets]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onReorder?.(next); }
  return <div ref={gallery} className={`media-gallery ${assets.length > 1 ? "multiple-media" : ""}`} style={{ "--default-media-width": `calc((100% - ${(columns - 1) * 14}px) / ${columns})` } as CSSProperties}>{assets.map((asset, index) => <MediaItem key={asset.id} asset={asset} file={pending?.get(asset.id)} onRemove={onRemove} onResize={onResize} reorder={onReorder && assets.length > 1 ? <div className="media-reorder" role="group" aria-label={`Порядок файла ${asset.name}`}><button type="button" className="icon-button" aria-label={`Переместить ${asset.name} влево`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowLeft /></button><span>{index + 1} / {assets.length}</span><button type="button" className="icon-button" aria-label={`Переместить ${asset.name} вправо`} disabled={index === assets.length - 1} onClick={() => move(index, 1)}><ArrowRight /></button></div> : undefined} />)}</div>;
}

function MediaItem({ asset, file, onRemove, reorder, onResize }: { asset: MediaAsset; file?: Blob; onRemove?: (id: string) => void; reorder?: React.ReactNode; onResize?: ResizeMedia }) {
  const { source, error, setError } = useMediaSource(asset.id, file);
  const item = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; width: number; height: number; original: MediaDisplaySize | undefined } | null>(null);
  const callback = useRef(onResize); callback.current = onResize;
  const [measured, setMeasured] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = item.current, frame = viewport.current;
    if (!element || !frame || !onResize) return;
    const observer = new ResizeObserver(() => setMeasured({ width: Math.round(element.getBoundingClientRect().width), height: Math.round(frame.getBoundingClientRect().height) }));
    observer.observe(element); observer.observe(frame); return () => observer.disconnect();
  }, [!!onResize]);
  useEffect(() => {
    function cancel(event: KeyboardEvent) { if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); callback.current?.(asset.id, drag.current.original); drag.current = null; } }
    function blur() { if (drag.current) { callback.current?.(asset.id, drag.current.original); drag.current = null; } }
    document.addEventListener("keydown", cancel, true); window.addEventListener("blur", blur);
    return () => { document.removeEventListener("keydown", cancel, true); window.removeEventListener("blur", blur); };
  }, [asset.id]);
  /** Applies independent dimensions to this file; flex wrapping gives each row its tallest height. */
  function resize(width: number, height: number) {
    const available = Math.max(1, item.current?.parentElement?.clientWidth || 2400);
    callback.current?.(asset.id, { width: Math.round(Math.min(available, Math.max(Math.min(180, available), Math.min(2400, width)))), height: Math.round(Math.max(80, Math.min(1200, height))) });
  }

  const size = asset.size < 1024 * 1024 ? `${Math.max(1, Math.round(asset.size / 1024))} КБ` : `${(asset.size / (1024 * 1024)).toLocaleString("ru", { maximumFractionDigits: 1 })} МБ`;
  return <figure ref={item} className={`media-item media-${asset.kind} ${asset.displaySize ? "is-sized" : ""}`} style={{ "--media-width": asset.displaySize ? `${asset.displaySize.width}px` : undefined, "--media-height": asset.displaySize ? `${asset.displaySize.height}px` : undefined } as CSSProperties}>
    {reorder}
    <div className="media-viewport" ref={viewport}>
    {source && asset.kind === "model" ? <ModelPreview source={source} name={asset.name} /> : source ? <>
      {asset.kind === "image" ? <a className="image-preview" href={source} target="_blank" rel="noreferrer" aria-label={`Открыть изображение ${asset.name}`}><img src={source} alt={asset.name} loading="lazy" onError={() => setError("Не удалось показать изображение. Можно скачать оригинал.")} /></a> : asset.kind === "video" ? <video src={source} controls playsInline preload="metadata" aria-label={asset.name} onError={() => setError("Браузер не поддерживает это видео. Можно скачать оригинал.")} /> : <audio src={source} controls preload="metadata" aria-label={asset.name} onError={() => setError("Браузер не поддерживает этот звук. Можно скачать оригинал.")} />}
    </> : !error && <div className="media-loading"><LoaderCircle />Загрузка…</div>}
    </div>
    {error && <div className="media-error"><ImageOff /><span>{error}</span></div>}
    <figcaption><span><strong>{asset.name}</strong><small>{size}</small></span><span className="media-actions">{source && <a className="icon-button" href={source} download={asset.name} aria-label={`Скачать ${asset.name}`}><Download /></a>}{onRemove && <button type="button" className="icon-button danger" aria-label={`Убрать ${asset.name}`} onClick={() => onRemove(asset.id)}><X /></button>}</span></figcaption>
    {onResize && <div className="media-size-controls"><span aria-live="off" title="Ширина карточки × высота области медиа">{measured.width} × {measured.height} px</span><button type="button" className="media-size-reset" title="Автоматический размер" aria-label={`Сбросить размер ${asset.name}`} disabled={!asset.displaySize} onClick={() => onResize(asset.id, undefined)}><RotateCcw /></button><button type="button" className="media-resize-handle" aria-label={`Изменить размер ${asset.name}`} title="Тяни для изменения размера. Стрелки — точная настройка, Escape — отмена, двойной щелчок — сброс." onDoubleClick={() => onResize(asset.id, undefined)} onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
      drag.current = { x: event.clientX, y: event.clientY, width: item.current!.getBoundingClientRect().width, height: viewport.current!.getBoundingClientRect().height, original: asset.displaySize };
      event.currentTarget.setPointerCapture(event.pointerId);
    }} onPointerMove={event => {
      const start = drag.current; if (!start) return;
      event.preventDefault(); event.stopPropagation(); resize(start.width + event.clientX - start.x, start.height + event.clientY - start.y);
    }} onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { if (drag.current) onResize(asset.id, drag.current.original); drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => {
      if (event.key === "Home") { event.preventDefault(); onResize(asset.id, undefined); return; }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault(); const step = event.shiftKey ? 40 : 10;
      resize(item.current!.getBoundingClientRect().width + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), viewport.current!.getBoundingClientRect().height + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0));
    }}><MoveDiagonal2 /></button></div>}
  </figure>;
}

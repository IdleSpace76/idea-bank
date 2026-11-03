"use client";
import { useI18n } from "./language-picker";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, ImagePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { type BlockWidth, type TextBlock } from "@/lib/ideas";
import { prepareMediaFiles } from "@/lib/model-import";
import { MediaGallery } from "./media-gallery";
import { FormattedText } from "./formatted-text";
import { RichTextEditor } from "./rich-text-editor";

type BlockEditorProps = {
  blocks: TextBlock[];
  onChange: (blocks: TextBlock[]) => void;
  pending: ReadonlyMap<string, Blob>;
  onFiles: (files: Map<string, Blob>) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  onAdd: () => void;
  onImporting: (busy: boolean) => void;
};

export function ProjectBlocks({ blocks, onEdit, readOnly }: { blocks: TextBlock[]; onEdit: (id: string) => void; readOnly?: boolean }) {
  const { t } = useI18n();
  return <div className="content-block-grid">{blocks.map((block, index) => <section id={`block-${block.id}`} className={`content-block block-${block.width || "full"}`} key={block.id}>
    <button type="button" className="icon-button edit-block-button" aria-label={t("Редактировать блок {0}", { 0: index + 1 })} title={t("Редактировать блок")} disabled={readOnly} onClick={() => onEdit(block.id)}><Pencil /></button>
    {block.heading && <h2 style={block.headingFontSize ? { fontSize: `${block.headingFontSize}px` } : undefined}>{block.heading}</h2>}
    {block.textPosition === "above" && <FormattedText text={block.text} document={block.richText} />}
    <MediaGallery assets={block.media || []} />
    {block.textPosition !== "above" && <FormattedText text={block.text} document={block.richText} />}
  </section>)}</div>;
}

export function BlockEditor({ blocks, onChange, pending, onFiles, onError, disabled, onAdd, onImporting }: BlockEditorProps) {
  const { t } = useI18n();
  const currentBlocks = useRef(blocks); currentBlocks.current = blocks;
  const mounted = useRef(true);
  const importing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dragged = useRef<string | null>(null);
  const pointer = useRef({ x: 0, y: 0, startX: 0, startY: 0, active: false, target: "" });
  const grid = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement | null>(null);
  const grabOffset = useRef({ x: 0, y: 0 });
  const order = useRef<string[]>([]);
  const previousRects = useRef(new Map<string, DOMRect>());
  const animations = useRef(new Map<HTMLElement, Animation>());
  const lastReorder = useRef(0);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  function capturePositions() {
    previousRects.current = new Map(Array.from(grid.current?.querySelectorAll<HTMLElement>("[data-block-id]") || []).map(el => [el.dataset.blockId!, el.getBoundingClientRect()]));
  }
  function endDrag() { if (pointer.current.active) capturePositions(); dragged.current = null; pointer.current.active = false; ghost.current?.remove(); ghost.current = null; document.body.classList.remove("is-block-dragging"); setDragging(null); setDropTarget(null); setPreviewOrder(null); }
  function positionGhost() { if (ghost.current) ghost.current.style.transform = `translate3d(${pointer.current.x - grabOffset.current.x}px, ${pointer.current.y - grabOffset.current.y}px, 0)`; }
  function startGhost(id: string) {
    const card = document.getElementById(`block-${id}`)!;
    const rect = card.getBoundingClientRect();
    grabOffset.current = { x: pointer.current.startX - rect.left, y: pointer.current.startY - rect.top };
    const copy = card.cloneNode(true) as HTMLElement;
    [copy, ...copy.querySelectorAll<HTMLElement>("[id], [data-block-id]")].forEach(el => { el.removeAttribute("id"); el.removeAttribute("data-block-id"); });
    copy.querySelectorAll("label").forEach(label => label.removeAttribute("for"));
    const originals = card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select");
    copy.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select").forEach((el, index) => { if (el.type !== "file") el.value = originals[index].value; });
    const overlay = document.createElement("div"); overlay.className = "block-drag-ghost"; overlay.setAttribute("aria-hidden", "true"); overlay.inert = true; overlay.style.width = `${rect.width}px`; overlay.append(copy); document.body.append(overlay); ghost.current = overlay;
    document.body.classList.add("is-block-dragging"); positionGhost();
  }
  function findTarget() {
    // Use the actual grid slots for hit testing, independent of cards moving between them.
    const slots = Array.from(grid.current?.querySelectorAll<HTMLElement>("[data-block-id]") || []).map(el => {
      const rect = el.getBoundingClientRect();
      const transform = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      return { el, left: rect.left - transform.m41, top: rect.top - transform.m42, width: rect.width, height: rect.height };
    });
    const slot = slots.find(rect => pointer.current.x >= rect.left && pointer.current.x <= rect.left + rect.width && pointer.current.y >= rect.top && pointer.current.y <= rect.top + rect.height);
    const target = slot?.el.dataset.blockId;
    pointer.current.target = target || "";
    setDropTarget(target || null);
    if (!target || !slot || target === dragged.current || !dragged.current || performance.now() - lastReorder.current < 60) return;
    const rect = slot;
    const source = slots.find(rect => rect.el.dataset.blockId === dragged.current)!;
    const sameRow = Math.abs(source.top - rect.top) < 25;
    const after = sameRow ? pointer.current.x >= rect.left + rect.width / 2 - 8 : pointer.current.y >= rect.top + rect.height / 2 - 8;
    const next = order.current.filter(id => id !== dragged.current);
    next.splice(next.indexOf(target) + (after ? 1 : 0), 0, dragged.current);
    if (next.join("|") === order.current.join("|")) return;
    capturePositions();
    lastReorder.current = performance.now(); order.current = next; setPreviewOrder(next);
  }
  useLayoutEffect(() => {
    if (!previousRects.current.size) return;
    // Preserve the current visual position when a new move interrupts an unfinished one.
    animations.current.forEach(animation => animation.cancel()); animations.current.clear();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { previousRects.current.clear(); return; }
    grid.current?.querySelectorAll<HTMLElement>("[data-block-id]").forEach(el => {
      if (el.dataset.blockId === dragging) return;
      const old = previousRects.current.get(el.dataset.blockId!); if (!old) return;
      const rect = el.getBoundingClientRect(); const x = old.left - rect.left, y = old.top - rect.top;
      if (Math.abs(x) > .5 || Math.abs(y) > .5) {
        const animation = el.animate([{ transform: `translate3d(${x}px, ${y}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        animations.current.set(el, animation);
        animation.onfinish = () => { if (animations.current.get(el) === animation) animations.current.delete(el); };
      }
    });
    previousRects.current.clear();
  }, [previewOrder, dragging]);
  useEffect(() => () => { ghost.current?.remove(); animations.current.forEach(animation => animation.cancel()); document.body.classList.remove("is-block-dragging"); }, []);
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    function tick() {
      const y = pointer.current.y;
      const delta = y < 85 ? -Math.min(22, (85 - y) / 3) : y > innerHeight - 85 ? Math.min(22, (y - innerHeight + 85) / 3) : 0;
      if (delta) window.scrollBy(0, delta);
      positionGhost(); findTarget();
      frame = requestAnimationFrame(tick);
    }
    function escape(e: KeyboardEvent) { if (e.key === "Escape") endDrag(); }
    frame = requestAnimationFrame(tick); document.addEventListener("keydown", escape); window.addEventListener("blur", endDrag);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", escape); window.removeEventListener("blur", endDrag); };
  }, [dragging]);
  function drop() {
    if (order.current.length === blocks.length && order.current.some((id, index) => id !== blocks[index].id)) {
      const next = order.current.map(id => blocks.find(block => block.id === id)!); onChange(next);
      setAnnouncement(t("Блок перемещён на позицию {0}.", { 0: order.current.indexOf(dragged.current!) + 1 }));
    }
    endDrag();
  }
  function update(id: string, fields: Partial<TextBlock>) { onChange(blocks.map(block => block.id === id ? { ...block, ...fields } : block)); }
  function move(index: number, direction: number) { const next = [...blocks]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; onChange(next); }
  async function addFiles(block: TextBlock, files: File[]) {
    if (!files.length || importing.current) return;
    importing.current = true; onImporting(true); onError("");
    try {
      const result = await prepareMediaFiles(files);
      if (!mounted.current) return;
      if (result.assets.length) { onFiles(result.blobs); onChange(currentBlocks.current.map(current => current.id === block.id ? { ...current, media: [...(current.media || []), ...result.assets] } : current)); }
      onError(result.errors.length ? t("Не удалось добавить: {0}", { 0: result.errors.join("; ") }) : "");
    } catch { if (mounted.current) onError(t("Не удалось прочитать файлы. Попробуй выбрать их ещё раз.")); }
    finally { importing.current = false; if (mounted.current) onImporting(false); }
  }

  const displayedBlocks = previewOrder ? previewOrder.map(id => blocks.find(block => block.id === id)!) : blocks;
  return <><div ref={grid} className={`content-block-grid editor-blocks ${dragging ? "is-sorting" : ""}`} onPointerMove={e => {
    if (!dragged.current) return; pointer.current.x = e.clientX; pointer.current.y = e.clientY;
    if (!pointer.current.active && Math.hypot(e.clientX - pointer.current.startX, e.clientY - pointer.current.startY) > 5) { pointer.current.active = true; startGhost(dragged.current); setDragging(dragged.current); }
    if (pointer.current.active) { positionGhost(); findTarget(); }
  }} onPointerUp={e => { if (!dragged.current) return; if (pointer.current.active) { findTarget(); drop(); } else endDrag(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={endDrag} onLostPointerCapture={() => { if (dragged.current) endDrag(); }}>{displayedBlocks.map((block, index) => <fieldset id={`block-${block.id}`} data-block-id={block.id} className={`editor-block block-${block.width || "full"} ${dragging === block.id ? "is-dragging" : ""} ${dropTarget === block.id && dragging !== block.id ? "is-drop-target" : ""}`} key={block.id} disabled={disabled}>
    <legend>{t("Блок ")}{index + 1}</legend>
    <div className="block-settings"><button type="button" className="icon-button drag-handle" disabled={disabled} aria-label={t("Перетащить блок {0}", { 0: index + 1 })} onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); grid.current!.setPointerCapture(e.pointerId); dragged.current = block.id; order.current = blocks.map(block => block.id); lastReorder.current = 0; pointer.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, active: false, target: "" }; }}><GripVertical /></button><label className="block-width-label">{t("Ширина")}<select aria-label={t("Ширина блока {0}", { 0: index + 1 })} value={block.width || "full"} onChange={e => update(block.id, { width: e.target.value as BlockWidth })}><option value="full">{t("Вся строка")}</option><option value="half">{t("½ строки")}</option><option value="third">{t("⅓ строки")}</option></select></label><div className="block-controls">
      <button type="button" className="icon-button" aria-label={t("Поднять блок {0}", { 0: index + 1 })} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></button>
      <button type="button" className="icon-button" aria-label={t("Опустить блок {0}", { 0: index + 1 })} disabled={index === blocks.length - 1} onClick={() => move(index, 1)}><ArrowDown /></button>
      <button type="button" className="icon-button danger" aria-label={t("Удалить блок {0}", { 0: index + 1 })} onClick={() => { if ((!block.text && !block.heading && !block.media?.length) || window.confirm(t("Удалить этот блок вместе с вложениями?"))) onChange(blocks.filter(b => b.id !== block.id)); }}><Trash2 /></button>
    </div></div>
    <label className="field-label" htmlFor={`heading-${block.id}`}>{t("Заголовок блока")}</label><div className="block-heading-field"><input id={`heading-${block.id}`} value={block.heading} style={block.headingFontSize ? { fontSize: `${block.headingFontSize}px` } : undefined} maxLength={200} placeholder={t("Без заголовка")} onChange={e => update(block.id, { heading: e.target.value })} /><label className="heading-size-label"><span className="sr-only">{t("Размер заголовка блока ")}{index + 1}</span><select aria-label={t("Размер заголовка блока {0}", { 0: index + 1 })} title={t("Размер шрифта заголовка")} value={block.headingFontSize || 24} onChange={e => update(block.id, { headingFontSize: Number(e.target.value) === 24 ? undefined : Number(e.target.value) })}>{[12, 14, 16, 18, 20, 21, 24, 28, 32, 36, 40, 48].map(size => <option key={size} value={size}>{size} px{size === 24 ? t(" · по умолчанию") : ""}</option>)}</select></label></div>
    <label className="text-position-label">{t("Положение текста")}<select aria-label={t("Положение текста блока {0}", { 0: index + 1 })} value={block.textPosition || "below"} onChange={e => update(block.id, { textPosition: e.target.value as "above" | "below" })}><option value="above">{t("Над медиа")}</option><option value="below">{t("Под медиа")}</option></select></label>
    {block.textPosition === "above" && <div key="block-text" className="block-text-field"><label className="field-label" id={`text-${block.id}-label`} htmlFor={`text-${block.id}`}>{t("Текст")}</label><RichTextEditor id={`text-${block.id}`} text={block.text} document={block.richText} disabled={disabled} onChange={fields => update(block.id, fields)} /></div>}
    <MediaGallery assets={block.media || []} pending={pending} onRemove={id => update(block.id, { media: (block.media || []).filter(asset => asset.id !== id) })} onReorder={media => update(block.id, { media })} onResize={(id, displaySize) => update(block.id, { media: (block.media || []).map(asset => asset.id === id ? { ...asset, displaySize } : asset) })} />
    <label className="media-upload"><ImagePlus /><span>{t("Добавить фото, видео, аудио или 3D-модель")}</span><input type="file" multiple accept="image/*,video/*,audio/*,.glb,.gltf,.bin" aria-label={t("Медиа блока {0}", { 0: index + 1 })} onChange={e => { void addFiles(block, Array.from(e.target.files || [])); e.target.value = ""; }} /></label>
    <label className="model-folder-upload">{t("Загрузить папку glTF")}<input type="file" {...{ webkitdirectory: "", directory: "" }} multiple aria-label={t("Папка 3D-модели блока {0}", { 0: index + 1 })} onChange={e => { void addFiles(block, Array.from(e.target.files || [])); e.target.value = ""; }} /></label>
    {block.textPosition !== "above" && <div key="block-text" className="block-text-field"><label className="field-label" id={`text-${block.id}-label`} htmlFor={`text-${block.id}`}>{t("Текст")}</label><RichTextEditor id={`text-${block.id}`} text={block.text} document={block.richText} disabled={disabled} onChange={fields => update(block.id, fields)} /></div>}
  </fieldset>)}</div>
    <button type="button" className="add-block-button" disabled={disabled} onClick={onAdd}><Plus />{t("Добавить блок")}</button><span className="sr-only" role="status" aria-live="polite">{t(announcement)}</span>
  </>;
}

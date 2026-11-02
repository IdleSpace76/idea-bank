"use client";

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { Bold, Code, Italic, Link, RemoveFormatting, Strikethrough, Underline } from "lucide-react";
import { normalizeRichText, plainTextDocument, richTextToPlain, safeColor, safeLink, type RichDocument } from "@/lib/rich-text";

type Props = { id: string; text: string; document?: RichDocument; disabled?: boolean; onChange: (value: { text: string; richText: RichDocument }) => void };

/** Keeps the editor and its selection alive while the parent updates the block draft. */
export function RichTextEditor({ id, text, document, disabled, onChange }: Props) {
  const callback = useRef(onChange); callback.current = onChange;
  const previous = useRef(document || plainTextDocument(text));
  const [error, setError] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [address, setAddress] = useState("");
  const selection = useRef({ from: 1, to: 1 });
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [StarterKit.configure({
      blockquote: false, bulletList: false, codeBlock: false, heading: false,
      horizontalRule: false, listItem: false, listKeymap: false, orderedList: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: false, linkOnPaste: false, isAllowedUri: url => !!safeLink(url) },
    }), TextStyle, Color, FontSize],
    content: previous.current,
    editorProps: { attributes: { id, role: "textbox", "aria-multiline": "true", "aria-labelledby": `${id}-label`, class: "block-prose rich-text-input", "data-placeholder": "Что хочется сохранить?" } },
    onUpdate: ({ editor: current }) => {
      try {
        const richText = normalizeRichText(current.getJSON());
        previous.current = richText; setError("");
        callback.current({ text: richTextToPlain(richText), richText });
      } catch {
        current.commands.setContent(previous.current, { emitUpdate: false });
        setError("В блоке можно сохранить до 50 000 символов. Раздели текст на несколько блоков.");
      }
    },
  });
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  const state = useEditorState({ editor, selector: ({ editor: current }) => current ? {
    bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"),
    strike: current.isActive("strike"), code: current.isActive("code"), link: current.isActive("link"),
    color: safeColor(current.getAttributes("textStyle").color) || "#293127",
    size: current.getAttributes("textStyle").fontSize || "16px",
  } : null });
  function openLink() {
    if (!editor) return;
    selection.current = { from: editor.state.selection.from, to: editor.state.selection.to };
    setAddress(editor.getAttributes("link").href || ""); setError(""); setLinkOpen(true);
  }
  function applyLink() {
    if (!editor) return;
    const href = safeLink(address);
    if (!href) { setError("Введи полный адрес: https://example.com или mailto:name@example.com."); return; }
    const chain = editor.chain().focus().setTextSelection(selection.current).extendMarkRange("link");
    if (selection.current.from === selection.current.to && !editor.isActive("link")) chain.insertContent({ type: "text", text: address.trim(), marks: [{ type: "link", attrs: { href } }] }).run();
    else chain.setLink({ href }).run();
    setLinkOpen(false); setError("");
  }
  const actions = [
    { name: "Жирный", icon: Bold, active: state?.bold, run: () => editor?.chain().focus().toggleBold().run() },
    { name: "Подчёркнутый", icon: Underline, active: state?.underline, run: () => editor?.chain().focus().toggleUnderline().run() },
    { name: "Курсив", icon: Italic, active: state?.italic, run: () => editor?.chain().focus().toggleItalic().run() },
    { name: "Зачёркнутый", icon: Strikethrough, active: state?.strike, run: () => editor?.chain().focus().toggleStrike().run() },
    { name: "Код", icon: Code, active: state?.code, run: () => editor?.chain().focus().toggleCode().run() },
    { name: "Гиперссылка", icon: Link, active: state?.link, run: openLink },
    { name: "Сбросить форматирование", icon: RemoveFormatting, active: false, run: () => editor?.chain().focus().unsetAllMarks().run() },
  ];
  return <div className="rich-text-editor">
    <div className="text-toolbar" role="group" aria-label="Форматирование текста">
      {actions.map(action => <button type="button" key={action.name} className="icon-button" title={action.name === "Код" ? "Код (`текст`)" : action.name} aria-label={action.name} aria-pressed={action.active || false} disabled={disabled || !editor} onMouseDown={e => e.preventDefault()} onClick={action.run}><action.icon /></button>)}
      <label className="text-size-label"><span className="sr-only">Размер шрифта</span><select aria-label="Размер шрифта" value={state?.size || "16px"} disabled={disabled || !editor} onChange={e => { const chain = editor!.chain().focus(); if (e.target.value === "16px") chain.unsetFontSize().run(); else chain.setFontSize(e.target.value).run(); }}>
        {[12, 14, 16, 18, 20, 24, 28, 32, 40, 48].map(size => <option key={size} value={`${size}px`}>{size} px{size === 16 ? " · по умолчанию" : ""}</option>)}
      </select></label>
      <label className="text-color-label" title="Цвет текста"><span className="sr-only">Цвет текста</span><input type="color" aria-label="Цвет текста" value={state?.color || "#293127"} disabled={disabled || !editor} onChange={e => editor?.chain().focus().setColor(e.target.value).run()} /></label>
    </div>
    {linkOpen && <div className="text-link-editor">
      <input autoFocus aria-label="Адрес ссылки" type="url" placeholder="https://example.com" value={address} disabled={disabled} onChange={e => setAddress(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setLinkOpen(false); editor?.commands.focus(); } }} />
      <button type="button" className="button primary" disabled={disabled} onClick={applyLink}>Применить</button>
      <button type="button" className="button" disabled={disabled} onClick={() => { editor?.chain().focus().setTextSelection(selection.current).extendMarkRange("link").unsetLink().run(); setLinkOpen(false); setError(""); }}>Убрать ссылку</button>
      <button type="button" className="button" disabled={disabled} onClick={() => { setLinkOpen(false); setError(""); editor?.commands.focus(); }}>Отмена</button>
    </div>}
    <EditorContent editor={editor} />
    {error && <p className="text-editor-error" role="alert">{error}</p>}
  </div>;
}

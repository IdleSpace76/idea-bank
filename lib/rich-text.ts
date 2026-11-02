export type RichMark = { type: "bold" | "italic" | "underline" | "strike" | "code" } | { type: "textStyle"; attrs: { color?: string; fontSize?: string } } | { type: "link"; attrs: { href: string } };
export type RichInline = { type: "text"; text: string; marks?: RichMark[] } | { type: "hardBreak" };
export type RichParagraph = { type: "paragraph"; content: RichInline[] };
export type RichDocument = { type: "doc"; content: RichParagraph[] };

export function safeLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function safeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(value);
  if (rgb && rgb.slice(1).every(part => Number(part) <= 255)) return "#" + rgb.slice(1).map(part => Number(part).toString(16).padStart(2, "0")).join("");
}

/** Limits stored formatting to the editor's supported nodes, marks and safe attributes. */
export function normalizeRichText(value: unknown): RichDocument {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
  if (!record(value) || value.type !== "doc" || !Array.isArray(value.content)) throw new Error("Invalid text document");
  let count = 0;
  const content: RichParagraph[] = value.content.map(paragraph => {
    if (!record(paragraph) || paragraph.type !== "paragraph") throw new Error("Invalid text paragraph");
    const children = paragraph.content ?? [];
    if (!Array.isArray(children)) throw new Error("Invalid paragraph content");
    return { type: "paragraph", content: children.map((node): RichInline => {
      if (++count > 20000 || !record(node)) throw new Error("Too many text nodes");
      if (node.type === "hardBreak") return { type: "hardBreak" };
      if (node.type !== "text" || typeof node.text !== "string") throw new Error("Invalid text node");
      const marks: RichMark[] = [];
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        if (!record(mark)) continue;
        if (["bold", "italic", "underline", "strike", "code"].includes(String(mark.type))) marks.push({ type: mark.type as "bold" });
        else if (mark.type === "link" && record(mark.attrs) && typeof mark.attrs.href === "string") {
          const href = safeLink(mark.attrs.href); if (href) marks.push({ type: "link", attrs: { href } });
        } else if (mark.type === "textStyle" && record(mark.attrs)) {
          const attrs: { color?: string; fontSize?: string } = {};
          const color = safeColor(mark.attrs.color); if (color) attrs.color = color;
          const size = typeof mark.attrs.fontSize === "string" && /^(\d+(?:\.\d+)?)px$/.exec(mark.attrs.fontSize);
          if (size) attrs.fontSize = `${Math.max(10, Math.min(48, Number(size[1])))}px`;
          if (Object.keys(attrs).length) marks.push({ type: "textStyle", attrs });
        }
      }
      return { type: "text", text: node.text, ...(marks.length ? { marks } : {}) };
    }) };
  });
  const result: RichDocument = { type: "doc", content: content.length ? content : [{ type: "paragraph", content: [] }] };
  if (richTextToPlain(result).length > 50000) throw new Error("Text is too long");
  return result;
}

export function richTextToPlain(doc: RichDocument): string {
  return doc.content.map(paragraph => paragraph.content.map(node => node.type === "text" ? node.text : "\n").join("")).join("\n\n");
}

export function plainTextDocument(text: string): RichDocument {
  return { type: "doc", content: text.split("\n\n").map(paragraph => ({ type: "paragraph", content: paragraph.split("\n").flatMap((line, index): RichInline[] => [...(index ? [{ type: "hardBreak" } as const] : []), ...(line ? [{ type: "text", text: line } as const] : [])]) })) };
}

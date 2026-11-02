import { Fragment, type ReactNode } from "react";
import type { RichDocument, RichInline } from "@/lib/rich-text";
import { safeColor, safeLink } from "@/lib/rich-text";

function inline(node: RichInline, index: number): ReactNode {
  if (node.type === "hardBreak") return <br key={index} />;
  let result: ReactNode = node.text;
  for (const mark of node.marks || []) {
    switch (mark.type) {
      case "bold": result = <strong>{result}</strong>; break;
      case "italic": result = <em>{result}</em>; break;
      case "underline": result = <u>{result}</u>; break;
      case "strike": result = <s>{result}</s>; break;
      case "code": result = <code>{result}</code>; break;
      case "textStyle": result = <span style={{ color: safeColor(mark.attrs.color), fontSize: mark.attrs.fontSize }}>{result}</span>; break;
      case "link": { const href = safeLink(mark.attrs.href); if (href) result = <a href={href} target="_blank" rel="noopener noreferrer">{result}</a>; break; }
    }
  }
  return <Fragment key={index}>{result}</Fragment>;
}

/** Renders the stored document as React elements, without executing stored HTML. */
export function FormattedText({ text, document }: { text: string; document?: RichDocument }) {
  if (!text && !document) return null;
  return <div className="block-prose">{document ? document.content.map((paragraph, index) => <p key={index}>{paragraph.content.length ? paragraph.content.map(inline) : <br />}</p>) : <p>{text}</p>}</div>;
}

/**
 * Notion rich text arrays → plain text and Markdown.
 *
 * A rich text item is `{type: "text"|"mention"|"equation", plain_text, href,
 * annotations: {bold, italic, strikethrough, underline, code, color}}`. Plain text is the
 * concatenation of `plain_text` (Notion already renders mentions there). Markdown wraps
 * each run in its marks and links it.
 */

import type { Json } from "./values.ts";

/** Concatenated plain text; an empty array is "". */
export function plainText(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  let s = "";
  for (const r of rt as Json[]) s += typeof r?.plain_text === "string" ? r.plain_text : "";
  return s;
}

/** Plain text, or NULL when the array is missing or empty. */
export function plainOrNull(rt: unknown): string | null {
  if (!Array.isArray(rt) || rt.length === 0) return null;
  return plainText(rt);
}

/** Escape Markdown punctuation that would otherwise change meaning. */
export function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]<>~])/g, "\\$1");
}

/** Wrap text in a mark, keeping surrounding whitespace outside it (`** a **` is not bold). */
function wrap(s: string, mark: string): string {
  const m = /^(\s*)(.*?)(\s*)$/s.exec(s);
  if (!m || m[2] === "") return s;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

/** One rich text array → inline Markdown. */
export function richTextMarkdown(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  let out = "";
  for (const r of rt as Json[]) {
    const raw = typeof r?.plain_text === "string" ? r.plain_text : "";
    if (raw === "") continue;
    const a = (r.annotations ?? {}) as Json;
    let s: string;
    if (r.type === "equation") s = `$${r.equation?.expression ?? raw}$`;
    else if (a.code) s = raw.includes("`") ? `\`\` ${raw} \`\`` : `\`${raw}\``;
    else {
      s = escapeMd(raw);
      if (a.bold) s = wrap(s, "**");
      if (a.italic) s = wrap(s, "_");
      if (a.strikethrough) s = wrap(s, "~~");
    }
    const href = typeof r.href === "string" && r.href ? r.href : null;
    out += href && r.type !== "equation" ? `[${s}](${href})` : s;
  }
  return out;
}

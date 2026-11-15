/**
 * A Notion block tree → Markdown or plain text.
 *
 * Markdown follows GitHub-flavoured conventions: headings, nested bulleted / numbered /
 * to-do lists (children indented by the marker width), quotes and callouts as `>`
 * blocks, fenced code with its language, `$$` equations, pipe tables, images as
 * `![caption](url)`, files / bookmarks / embeds as links, child pages and databases as
 * their titles. Toggles render as list items with their children nested. Column
 * layouts and synced blocks are flattened into document order.
 *
 * Plain text keeps the same structure without marks: one line per block, list markers
 * kept, table cells tab-separated.
 */

import { plainText, richTextMarkdown } from "./richtext.ts";
import { fileOf, type Json } from "./values.ts";

export interface BlockNode {
  block: Json;
  children: BlockNode[];
}

export type Format = "markdown" | "text";

/** The rich text array of a block, for any block type that has one. */
export function blockRichText(block: Json): Json[] | null {
  const body = block?.[block?.type] as Json | undefined;
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.rich_text)) return body.rich_text as Json[];
  if (Array.isArray(body.caption) && block.type !== "code") return body.caption as Json[];
  return null;
}

/** URL a media / link block points at. */
export function blockUrl(block: Json): string | null {
  const b = (block?.[block?.type] ?? {}) as Json;
  if (typeof b.url === "string") return b.url;
  if (["image", "video", "file", "pdf", "audio"].includes(block?.type)) return fileOf(b).url;
  return null;
}

/** The block's text without marks: rich text, a table row's cells, a child page's title… */
export function blockPlainText(block: Json): string | null {
  const t = block?.type as string;
  const b = (block?.[t] ?? {}) as Json;
  switch (t) {
    case "child_page":
    case "child_database":
      return typeof b.title === "string" ? b.title : null;
    case "equation":
      return typeof b.expression === "string" ? b.expression : null;
    case "table_row":
      return Array.isArray(b.cells) ? b.cells.map((c: unknown) => plainText(c)).join("\t") : null;
    case "code":
      return plainText(b.rich_text);
    case "image":
    case "video":
    case "file":
    case "pdf":
    case "audio":
    case "bookmark":
    case "embed":
    case "link_preview": {
      const cap = plainText(b.caption);
      return cap || blockUrl(block);
    }
    default: {
      const rt = blockRichText(block);
      return rt ? plainText(rt) : null;
    }
  }
}

const indentLines = (s: string, pad: string) =>
  s
    .split("\n")
    .map((l) => (l === "" ? l : pad + l))
    .join("\n");

function inline(rt: unknown, fmt: Format): string {
  return fmt === "markdown" ? richTextMarkdown(rt) : plainText(rt);
}

function renderTable(node: BlockNode, fmt: Format): string {
  const rows = node.children.filter((c) => c.block.type === "table_row");
  const cells = rows.map((r) => ((r.block.table_row?.cells ?? []) as unknown[]).map((c) => inline(c, fmt)));
  if (fmt === "text") return cells.map((r) => r.join("\t")).join("\n");
  const width = Math.max(1, Number(node.block.table?.table_width ?? 0), ...cells.map((r) => r.length));
  const pad = (r: string[]) =>
    Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " "));
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const header = node.block.table?.has_column_header ? (cells[0] ?? []) : Array.from({ length: width }, () => "");
  const body = node.block.table?.has_column_header ? cells.slice(1) : cells;
  return [line(header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** Render one block (and its children) to a chunk; `index` is its 1-based number in a numbered list. */
function renderBlock(node: BlockNode, fmt: Format, index: number): string {
  const block = node.block;
  const t = block.type as string;
  const b = (block[t] ?? {}) as Json;
  const md = fmt === "markdown";
  const kids = (sep = "\n\n") => renderBlocks(node.children, fmt, sep);
  const nested = (marker: string, text: string) => {
    const child = node.children.length ? renderBlocks(node.children, fmt, "\n") : "";
    return child ? `${marker}${text}\n${indentLines(child, " ".repeat(marker.length))}` : `${marker}${text}`;
  };
  switch (t) {
    case "paragraph": {
      const text = inline(b.rich_text, fmt);
      const child = node.children.length ? kids() : "";
      return [text, child].filter((s) => s !== "").join("\n\n");
    }
    case "heading_1":
    case "heading_2":
    case "heading_3":
    case "heading_4": {
      const level = Number(t.slice(-1));
      const head = md ? `${"#".repeat(level)} ${inline(b.rich_text, fmt)}` : inline(b.rich_text, fmt);
      return node.children.length ? `${head}\n\n${kids()}` : head;
    }
    case "bulleted_list_item":
      return nested("- ", inline(b.rich_text, fmt));
    case "numbered_list_item":
      return nested(`${index}. `, inline(b.rich_text, fmt));
    case "to_do":
      return nested(b.checked ? "- [x] " : "- [ ] ", inline(b.rich_text, fmt));
    case "toggle":
      return nested("- ", inline(b.rich_text, fmt));
    case "quote":
    case "callout": {
      const icon = t === "callout" && b.icon?.type === "emoji" ? `${b.icon.emoji} ` : "";
      const body = [icon + inline(b.rich_text, fmt), node.children.length ? kids() : ""]
        .filter((s) => s.trim() !== "")
        .join("\n\n");
      if (!md) return body;
      return body
        .split("\n")
        .map((l) => (l === "" ? ">" : `> ${l}`))
        .join("\n");
    }
    case "code": {
      const code = plainText(b.rich_text);
      if (!md) return code;
      const lang = typeof b.language === "string" && b.language !== "plain text" ? b.language : "";
      const fence = code.includes("```") ? "````" : "```";
      return `${fence}${lang}\n${code}\n${fence}`;
    }
    case "equation":
      return md ? `$$\n${b.expression ?? ""}\n$$` : String(b.expression ?? "");
    case "divider":
      return md ? "---" : "";
    case "image": {
      const url = blockUrl(block) ?? "";
      const cap = plainText(b.caption);
      return md ? `![${cap}](${url})` : cap || url;
    }
    case "video":
    case "file":
    case "pdf":
    case "audio":
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = blockUrl(block) ?? "";
      const label = plainText(b.caption) || (typeof b.name === "string" ? b.name : "") || url;
      return md ? `[${label}](${url})` : label;
    }
    case "child_page":
    case "child_database": {
      // A sub-page's blocks are present only with include_child_pages: inline them under its title.
      const head = md ? `**${b.title ?? ""}**` : String(b.title ?? "");
      return node.children.length ? `${head}\n\n${kids()}` : head;
    }
    case "link_to_page": {
      const id = b.page_id ?? b.database_id ?? b.data_source_id ?? "";
      return md ? `[${id}](https://www.notion.so/${String(id).replace(/-/g, "")})` : String(id);
    }
    case "table":
      return renderTable(node, fmt);
    case "column_list":
    case "column":
    case "synced_block":
    case "template":
    case "meeting_notes":
    case "transcription":
      return [inline(b.rich_text, fmt), kids()].filter((s) => s !== "").join("\n\n");
    case "table_of_contents":
    case "breadcrumb":
    case "unsupported":
      return "";
    default: {
      const rt = blockRichText(block);
      return [rt ? inline(rt, fmt) : "", node.children.length ? kids() : ""].filter((s) => s !== "").join("\n\n");
    }
  }
}

const LIST_TYPES = new Set(["bulleted_list_item", "numbered_list_item", "to_do", "toggle"]);

/** Render siblings; consecutive list items are joined tightly, other blocks by `sep`. */
export function renderBlocks(nodes: BlockNode[], fmt: Format, sep = "\n\n"): string {
  const parts: string[] = [];
  let prevType = "";
  let number = 0;
  for (const n of nodes) {
    const t = n.block.type as string;
    number = t === "numbered_list_item" ? (prevType === "numbered_list_item" ? number + 1 : 1) : 0;
    const chunk = renderBlock(n, fmt, number);
    if (chunk !== "") {
      // Items of one list are joined tightly; bullets, to-dos and toggles share the "-" marker.
      const family = (x: string) => (x === "numbered_list_item" ? "ol" : LIST_TYPES.has(x) ? "ul" : "");
      const tight = family(t) !== "" && family(t) === family(prevType);
      parts.push(parts.length === 0 ? chunk : (tight ? "\n" : sep) + chunk);
    }
    prevType = t;
  }
  return parts.join("");
}

/** A whole page: optional `# Title` heading, then its blocks. */
export function renderPage(title: string | null, nodes: BlockNode[], fmt: Format): string {
  const body = renderBlocks(nodes, fmt);
  if (!title) return body ? `${body}\n` : "";
  const head = fmt === "markdown" ? `# ${title}` : title;
  return body ? `${head}\n\n${body}\n` : `${head}\n`;
}

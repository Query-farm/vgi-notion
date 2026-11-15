/**
 * Page content: `blocks(block_id)` (the block tree as rows), `page_markdown(page_id)`
 * and `page_text(page_id)` (the tree rendered to one document).
 *
 * `blocks` walks children depth-first with its stack of pending parents (block id,
 * depth, sort path, Notion cursor) in scan state, so a large page streams one
 * 100-block page per batch and resumes on any process. Rows are emitted parent before
 * children; `path` (zero-padded positions joined by '.') sorts them into document order.
 */

import { bool, int32, utf8 } from "@query-farm/vgi";
import { asList, type NotionConfig, NotionError, notionRequest } from "./client.ts";
import { normalizeId } from "./ids.ts";
import { pageTitle } from "./properties.ts";
import { type BlockNode, blockPlainText, blockRichText, blockUrl, type Format, renderPage } from "./render.ts";
import { C, defineNotionTable, type ScanStateBase } from "./table.ts";
import { asStr, type Json, userId } from "./values.ts";

/** Block types whose children are never walked: a child database is a database, not blocks. */
const NEVER_DESCEND = new Set(["child_database"]);

export const pad = (n: number) => String(n).padStart(5, "0");

export function shouldDescend(block: Json, depth: number, maxDepth: number, includeChildPages: boolean): boolean {
  if (block?.has_children !== true || depth >= maxDepth) return false;
  if (NEVER_DESCEND.has(block.type)) return false;
  if (block.type === "child_page" && !includeChildPages) return false;
  return true;
}

async function childrenPage(cfg: NotionConfig, id: string, cursor: string) {
  return asList<Json>(
    await notionRequest(cfg, `/v1/blocks/${id}/children`, {
      query: { page_size: "100", start_cursor: cursor || undefined },
    }),
  );
}

// ------------------------------------------------------------------------ blocks()

interface Frame {
  id: string;
  depth: number;
  path: string;
  cursor: string;
  offset: number;
}

interface BlocksState extends ScanStateBase {
  started: boolean;
  stack: Frame[];
}

type BlocksArgs = {
  block_id: string;
  max_depth: bigint | number;
  include_child_pages: boolean;
};

const ctx = (r: Json) => (r.__ctx ?? {}) as Json;

export const blocks = defineNotionTable<BlocksArgs, BlocksState>({
  name: "blocks",
  description: "The block tree of a Notion page or block as rows, with plain text, type and nesting depth",
  title: "Page Blocks",
  category: "content",
  keywords: "notion, blocks, page content, children, rich text, plain text, outline, export, rag",
  docLlm:
    "The block tree under a page or block (by id or URL) as rows: id, parent_id, root_id, depth (1 = direct " +
    "child), position among siblings, path (ORDER BY path gives document order), type (paragraph, " +
    "heading_1/2/3, bulleted_list_item, numbered_list_item, to_do, toggle, quote, callout, code, table, " +
    "table_row, image, child_page, …), text (plain), rich_text (JSON), has_children, checked (to_do), " +
    "language (code), url (media/bookmarks), times and user ids, in_trash, content (type payload JSON). " +
    "max_depth := 10 limits recursion; include_child_pages := true also walks sub-pages. For one " +
    "rendered document use page_markdown or page_text instead.",
  docMd:
    "## blocks(block_id, max_depth := 10, include_child_pages := false)\n\nEvery block under a page, " +
    "depth-first, with plain text. `ORDER BY path` restores document order.",
  args: { block_id: utf8(), max_depth: int32, include_child_pages: bool },
  argDefaults: { max_depth: 10, include_child_pages: false },
  argConstraints: { max_depth: { ge: 1, le: 50 } },
  argDocs: {
    block_id: "Page or block id (or notion.so URL) whose children to list.",
    max_depth: "How deep to recurse: 1 = direct children only (default 10, at most 50).",
    include_child_pages: "Also walk into sub-pages (child_page blocks); off by default.",
  },
  columns: [
    C.str("id", "Block id.", "id", false),
    C.str("parent_id", "Id of the page or block this block is a child of.", (r) => ctx(r).parent, false),
    C.str("root_id", "The block_id argument (normalized), the root of the walk.", (r) => ctx(r).root, false),
    C.int("depth", "Nesting depth: 1 for the root's direct children.", (r) => ctx(r).depth, false),
    C.int("position", "0-based position among its siblings.", (r) => ctx(r).position, false),
    C.str("path", "Sortable document-order key: zero-padded positions joined by '.'.", (r) => ctx(r).path, false),
    C.str(
      "type",
      "Block type: paragraph, heading_1, bulleted_list_item, to_do, code, table_row, child_page, …",
      "type",
      false,
    ),
    C.str("text", "Plain text of the block (table rows: cells tab-separated; child pages: the title).", (r) =>
      blockPlainText(r),
    ),
    C.json("rich_text", "Raw rich text array (annotations, links, mentions), when the block has one.", (r) =>
      blockRichText(r),
    ),
    C.bool("has_children", "true when the block has nested children.", "has_children"),
    C.bool("checked", "to_do blocks: whether the box is ticked.", (r) =>
      r.type === "to_do" ? r.to_do?.checked : null,
    ),
    C.str("language", "code blocks: the language.", (r) => (r.type === "code" ? r.code?.language : null)),
    C.str("url", "Media, file, bookmark and embed blocks: the URL (Notion-hosted file URLs expire).", (r) =>
      blockUrl(r),
    ),
    C.time("created_time", "When the block was created.", "created_time"),
    C.time("last_edited_time", "When the block was last edited.", "last_edited_time"),
    C.str("created_by", "User id of the block's creator.", (r) => userId(r.created_by)),
    C.str("last_edited_by", "User id of the block's last editor.", (r) => userId(r.last_edited_by)),
    C.bool("in_trash", "true when the block is in the trash.", (r) => r.in_trash ?? r.archived),
    C.json(
      "content",
      "The block's type-specific payload as JSON (e.g. the table width, an image's file object).",
      (r) => r[r.type],
    ),
  ],
  initialState: () => ({ done: false, started: false, stack: [] }),
  next: async (scan, state) => {
    const root = normalizeId(scan.args.block_id, "block_id");
    const maxDepth = Number(scan.args.max_depth ?? 10);
    const includePages = scan.args.include_child_pages === true;
    if (!state.started) {
      state.started = true;
      state.stack = [{ id: root, depth: 1, path: "", cursor: "", offset: 0 }];
    }
    const frame = state.stack.pop();
    if (!frame) return { rows: [], done: true };
    const page = await childrenPage(scan.cfg, frame.id, frame.cursor);
    const rows: Json[] = [];
    const kids: Frame[] = [];
    page.results.forEach((b, i) => {
      const position = frame.offset + i;
      const path = frame.path ? `${frame.path}.${pad(position)}` : pad(position);
      rows.push({ ...b, __ctx: { parent: frame.id, root, depth: frame.depth, position, path } });
      if (shouldDescend(b, frame.depth, maxDepth, includePages)) {
        kids.push({ id: String(b.id), depth: frame.depth + 1, path, cursor: "", offset: 0 });
      }
    });
    if (page.has_more && page.next_cursor) {
      state.stack.push({ ...frame, cursor: page.next_cursor, offset: frame.offset + page.results.length });
    }
    // Children on top of the stack (first child next), so the walk is depth-first.
    state.stack.push(...kids.reverse());
    return { rows, done: state.stack.length === 0 };
  },
  pushdown:
    "none: every block under the root (to max_depth) is read; filter in SQL. Sub-pages are walked only " +
    "with include_child_pages := true; child databases never (query them with query_data_source).",
  examples: [
    {
      sql:
        "SELECT depth, type, text FROM notion.main.blocks('1a2b3c4d-0000-4000-8000-00000000a001') " +
        "WHERE type LIKE 'heading_%' ORDER BY path",
      description: "A page's outline: its headings in document order",
    },
    {
      sql:
        "SELECT count(*) FILTER (WHERE checked) AS done, count(*) AS total FROM notion.main.blocks('1a2b3c4d-0000-4000-8000-00000000a001') " +
        "WHERE type = 'to_do'",
      description: "How many to-do items on a page are ticked",
    },
  ],
});

// ------------------------------------------------------------- page_markdown/text

export const MAX_BLOCKS = 20_000;

/** Read a block tree in document order (depth-first), up to `maxDepth` and `maxBlocks`. */
export async function fetchTree(
  cfg: NotionConfig,
  rootId: string,
  maxDepth: number,
  includeChildPages: boolean,
  maxBlocks = MAX_BLOCKS,
): Promise<{ nodes: BlockNode[]; count: number; truncated: boolean }> {
  let count = 0;
  let truncated = false;
  let full = false;
  const walk = async (id: string, depth: number): Promise<BlockNode[]> => {
    const out: BlockNode[] = [];
    let cursor = "";
    for (;;) {
      const page = await childrenPage(cfg, id, cursor);
      for (const b of page.results) {
        if (count >= maxBlocks) {
          truncated = full = true;
          return out;
        }
        count++;
        const descend = shouldDescend(b, depth, maxDepth, includeChildPages);
        // Children exist but max_depth stops us (sub-pages and child databases are excluded on purpose).
        if (!descend && b.has_children === true && shouldDescend(b, 0, 1, includeChildPages)) truncated = true;
        out.push({ block: b, children: descend ? await walk(String(b.id), depth + 1) : [] });
        if (full) return out;
      }
      if (!page.has_more || !page.next_cursor) return out;
      cursor = page.next_cursor;
    }
  };
  const nodes = await walk(rootId, 1);
  return { nodes, count, truncated };
}

type RenderArgs = {
  page_id: string;
  max_depth: bigint | number;
  include_title: boolean;
  include_child_pages: boolean;
};

function renderFunction(name: "page_markdown" | "page_text", fmt: Format) {
  const md = fmt === "markdown";
  const out = md ? "markdown" : "text";
  return defineNotionTable<RenderArgs, ScanStateBase>({
    name,
    description: md
      ? "A Notion page rendered to Markdown (headings, lists, to-dos, code, tables, links), one row"
      : "A Notion page's content as plain text, one row",
    docLlm: md
      ? "Render one page (by id or URL) to GitHub-flavoured Markdown in a single row: page_id, title, url, " +
        "markdown, block_count, truncated. Headings, nested bulleted/numbered/to-do lists, toggles, quotes, " +
        "callouts, fenced code with language, equations, pipe tables, images, files, bookmarks and " +
        "links (bold/italic/strikethrough/code marks kept) are converted; sub-pages show as their title " +
        "unless include_child_pages := true. max_depth := 25. Use it to export pages, feed an LLM / RAG " +
        "pipeline, or diff page content."
      : "One page (by id or URL) as plain text in a single row: page_id, title, url, text, block_count, " +
        "truncated. Same structure as page_markdown (one line per block, list markers kept, table cells " +
        "tab-separated) without Markdown marks. Use it for full-text search, embeddings or word counts.",
    docMd: md
      ? "## page_markdown(page_id, max_depth := 25, include_title := true, include_child_pages := false)\n\n" +
        "A page's content as one Markdown document."
      : "## page_text(page_id, max_depth := 25, include_title := true, include_child_pages := false)\n\n" +
        "A page's content as one plain-text document.",
    title: md ? "Page as Markdown" : "Page as Plain Text",
    category: "content",
    keywords: md
      ? "notion, markdown, export, page content, convert, render, rag, llm, documentation"
      : "notion, plain text, export, page content, full text, rag, embedding, search",
    args: { page_id: utf8(), max_depth: int32, include_title: bool, include_child_pages: bool },
    argDefaults: { max_depth: 25, include_title: true, include_child_pages: false },
    argConstraints: { max_depth: { ge: 1, le: 50 } },
    argDocs: {
      page_id: "Page id or notion.so URL.",
      max_depth: "How deep to follow nested blocks (default 25, at most 50).",
      include_title: md
        ? "Start with '# <page title>' (default true)."
        : "Start with the page title line (default true).",
      include_child_pages: "Also inline the content of sub-pages (default false: a sub-page shows as its title).",
    },
    columns: [
      C.str("page_id", "The page id (normalized).", (r) => r.page_id, false),
      C.str("title", "The page title.", (r) => r.title),
      C.str("url", "The page URL in the Notion app.", (r) => r.url),
      C.str(
        out,
        md ? "The page content as GitHub-flavoured Markdown." : "The page content as plain text.",
        (r) => r.body,
        false,
      ),
      C.int("block_count", "Number of blocks rendered.", (r) => r.count, false),
      C.bool(
        "truncated",
        "true when max_depth or the 20,000-block limit cut the page short.",
        (r) => r.truncated,
        false,
      ),
    ],
    initialState: () => ({ done: false }),
    next: async (scan) => {
      const id = normalizeId(scan.args.page_id, "page_id");
      let page: Json;
      try {
        page = (await notionRequest(scan.cfg, `/v1/pages/${id}`, { query: { filter_properties: "title" } })) as Json;
      } catch (err) {
        if (err instanceof NotionError && err.status === 404) {
          throw new NotionError(`${name}: page ${id} not found or not shared with the integration (${err.message})`);
        }
        throw err;
      }
      const title = pageTitle(page);
      const tree = await fetchTree(
        scan.cfg,
        id,
        Number(scan.args.max_depth ?? 25),
        scan.args.include_child_pages === true,
      );
      const body = renderPage(scan.args.include_title === false ? null : title, tree.nodes, fmt);
      return {
        rows: [{ page_id: id, title, url: asStr(page.url), body, count: tree.count, truncated: tree.truncated }],
        done: true,
      };
    },
    pushdown: "none (one row per call).",
    examples: [
      md
        ? {
            sql: "SELECT title, length(markdown) AS chars FROM notion.main.page_markdown('1a2b3c4d-0000-4000-8000-00000000a001')",
            description: "Render a page to Markdown and measure it",
          }
        : {
            sql:
              "SELECT title, regexp_split_to_array(text, '\\s+') AS words FROM notion.main.page_text('1a2b3c4d-0000-4000-8000-00000000a001') " +
              "WHERE text ILIKE '%launch%'",
            description: "A page's plain text split into words, if it mentions a launch",
          },
    ],
  });
}

export const pageMarkdown = renderFunction("page_markdown", "markdown");
export const pageText = renderFunction("page_text", "text");

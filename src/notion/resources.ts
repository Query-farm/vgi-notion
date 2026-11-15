/**
 * Search, data sources, databases, pages, comments and users.
 */

import { bool, field, list, struct, type TableDescriptor, timestampMicros, utf8 } from "@query-farm/vgi";
import { asList, getAll, type NotionConfig, NotionError, notionRequest } from "./client.ts";
import { dataSourceTitle, eqValues, resolveDataSource, sampleFormulaTypes } from "./datasource.ts";
import { normalizeId } from "./ids.ts";
import { optionsOf, pageTitle, propertyColumns, propertyDefs, propertyText, sqlTypeOf } from "./properties.ts";
import { plainOrNull } from "./richtext.ts";
import { C, type Col, defineCatalogTable, defineNotionTable, type ScanStateBase } from "./table.ts";
import { asStr, fileOf, iconOf, type Json, parentOf, userId } from "./values.ts";

const SCHEMA = "main";

const parentType = (r: Json) => parentOf(r.parent)[0];
const parentId = (r: Json) => parentOf(r.parent)[1];
const inTrash = (r: Json) => r.in_trash ?? r.archived ?? null;

/** Normalize pushed id values; drop anything that is not an id. */
function idsFrom(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const out: string[] = [];
  for (const v of values) {
    try {
      out.push(normalizeId(v));
    } catch {
      // not an id: cannot match any row
    }
  }
  return [...new Set(out)];
}

/** GET an object by id; a 404 (missing or not shared) is no row. */
async function getOrNull(cfg: NotionConfig, path: string): Promise<Json | null> {
  try {
    return (await notionRequest(cfg, path)) as Json;
  } catch (err) {
    if (err instanceof NotionError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

// ------------------------------------------------------------------------ search()

interface CursorState extends ScanStateBase {
  cursor: string;
}

const SEARCH_COLUMNS: Col[] = [
  C.str("object", "'page' or 'data_source'.", "object", false),
  C.str("id", "Page or data source id.", "id", false),
  C.str("title", "Page title, or the data source's name.", (r) =>
    r.object === "page" ? pageTitle(r) : dataSourceTitle(r),
  ),
  C.str("url", "URL in the Notion app.", "url"),
  C.str("public_url", "Public URL when the page is published to the web.", "public_url"),
  C.str("parent_type", "Parent kind: workspace, page_id, block_id, database_id or data_source_id.", parentType),
  C.str("parent_id", "Id of the parent page / block / database / data source (NULL for the workspace).", parentId),
  C.str("database_id", "Database the page's data source belongs to, or the data source's database.", (r) =>
    asStr(r.parent?.database_id),
  ),
  C.time("created_time", "When it was created.", "created_time"),
  C.time("last_edited_time", "When it was last edited.", "last_edited_time"),
  C.str("created_by", "User id of the creator.", (r) => userId(r.created_by)),
  C.str("last_edited_by", "User id of the last editor.", (r) => userId(r.last_edited_by)),
  C.bool("in_trash", "true when it is in the trash.", inTrash),
  C.str("icon", "Icon: an emoji or an image URL.", (r) => iconOf(r.icon)),
];

type SearchArgs = {
  query: string;
};

export const search = defineNotionTable<SearchArgs, CursorState>({
  name: "search",
  description: "Pages and data sources shared with the integration, by title",
  title: "Search Pages and Data Sources",
  category: "search",
  keywords: "notion, search, find, pages, data sources, databases, title, workspace, list",
  docLlm:
    "Search pages and data sources shared with the integration by title (Notion's /v1/search). " +
    "query := '' (default) lists everything; WHERE object = 'page' or 'data_source' pushes down. Columns: " +
    "object, id, title, url, public_url, parent_type, parent_id, database_id (for rows and data sources), " +
    "created_time, last_edited_time, created_by, last_edited_by (user ids), in_trash, icon. Results are " +
    "ordered by last_edited_time descending. Use it to find the id of a page (for blocks, page_markdown) " +
    "or a data source (for query_data_source). Search is title-only and eventually consistent.",
  docMd:
    "## search(query := '')\n\nPages and data sources the integration can see, matched by title. " +
    "Filter `object` to `'page'` or `'data_source'`.",
  args: { query: utf8() },
  argDefaults: { query: "" },
  argDocs: { query: "Text to match in titles; '' (default) lists everything shared with the integration." },
  columns: SEARCH_COLUMNS,
  initialState: () => ({ done: false, cursor: "" }),
  next: async (scan, state) => {
    const kinds = eqValues(scan.filters, "object");
    const body: Json = { page_size: 100, sort: { direction: "descending", timestamp: "last_edited_time" } };
    if (scan.args.query) body.query = scan.args.query;
    if (kinds) {
      const valid = kinds.filter((k) => k === "page" || k === "data_source");
      if (valid.length === 0) return { rows: [], done: true };
      if (valid.length === 1) body.filter = { property: "object", value: valid[0] };
    }
    if (state.cursor) body.start_cursor = state.cursor;
    const page = asList<Json>(await notionRequest(scan.cfg, "/v1/search", { body }));
    state.cursor = page.has_more && page.next_cursor ? page.next_cursor : "";
    return { rows: page.results, done: !state.cursor };
  },
  pushdown: "WHERE object = 'page' | 'data_source' → the search filter. The query argument matches titles.",
  examples: [
    {
      sql:
        "SELECT title, url, last_edited_time FROM notion.main.search(query := 'roadmap') " +
        "WHERE object = 'page' ORDER BY last_edited_time DESC LIMIT 10",
      description: "The ten most recently edited pages whose title mentions 'roadmap'",
    },
    {
      sql: "SELECT object, count(*) AS n FROM notion.main.search() GROUP BY object ORDER BY object",
      description: "How many pages and data sources the integration can see",
    },
  ],
});

// ---------------------------------------------------------------- data_sources

interface FanoutState extends ScanStateBase {
  phase: number;
  cursor: string;
  queue: string[];
  seen: string[];
}

const fanoutInit = (): FanoutState => ({ done: false, phase: 0, cursor: "", queue: [], seen: [] });

const DATA_SOURCE_COLUMNS: Col[] = [
  C.str("id", "Data source id: pass it to query_data_source / data_source_schema.", "id", false),
  C.str("title", "Data source name.", (r) => dataSourceTitle(r)),
  C.str("description", "Data source description (plain text).", (r) => plainOrNull(r.description)),
  C.str("database_id", "The database (container) this data source belongs to.", (r) => asStr(r.parent?.database_id)),
  C.str(
    "database_parent_type",
    "Where the database lives: page_id, block_id or workspace.",
    (r) => parentOf(r.database_parent)[0],
  ),
  C.str("database_parent_id", "Id of the page / block holding the database.", (r) => parentOf(r.database_parent)[1]),
  C.int("property_count", "Number of properties (columns).", (r) => Object.keys(r.properties ?? {}).length),
  C.strList("property_names", "Property names in schema order.", (r) =>
    Object.values((r.properties ?? {}) as Record<string, Json>).map((p) => p.name),
  ),
  C.str("url", "URL in the Notion app.", "url"),
  C.time("created_time", "When it was created.", "created_time"),
  C.time("last_edited_time", "When its schema or rows were last edited.", "last_edited_time"),
  C.bool("in_trash", "true when it is in the trash.", inTrash),
  C.str("icon", "Icon: an emoji or an image URL.", (r) => iconOf(r.icon)),
];

/** Search with `filter.value = 'data_source'`, one page per call. */
async function searchDataSources(cfg: NotionConfig, cursor: string) {
  const body: Json = {
    page_size: 100,
    filter: { property: "object", value: "data_source" },
    sort: { direction: "descending", timestamp: "last_edited_time" },
  };
  if (cursor) body.start_cursor = cursor;
  return asList<Json>(await notionRequest(cfg, "/v1/search", { body }));
}

export const DATA_SOURCES = defineCatalogTable<FanoutState>(
  {
    name: "data_sources",
    description: "Every Notion data source (the row collections inside databases) shared with the integration",
    title: "Data Sources",
    category: "databases",
    keywords: "notion, data sources, databases, tables, schema, list, catalog",
    docLlm:
      "Every data source shared with the integration (a data source is the row collection inside a Notion " +
      "database; most databases have exactly one). Columns: id (pass to query_data_source / " +
      "data_source_schema), title, description, database_id, the database's parent, property_count, " +
      "property_names, url, created_time, last_edited_time, in_trash, icon. WHERE id = '…' or " +
      "database_id = '…' reads those directly instead of searching.",
    docMd:
      "Every data source the integration can query. A Notion database holds one or more data sources; " +
      "query the rows of one with `query_data_source(id)`.",
    columns: DATA_SOURCE_COLUMNS,
    primaryKey: "id",
    initialState: fanoutInit,
    next: async (scan, state) => {
      const ids = idsFrom(eqValues(scan.filters, "id"));
      const dbs = idsFrom(eqValues(scan.filters, "database_id"));
      if (ids) {
        // Pushed id = / IN: read each data source directly.
        const id = ids[state.phase];
        if (!id) return { rows: [], done: true };
        state.phase++;
        const ds = await getOrNull(scan.cfg, `/v1/data_sources/${id}`);
        return { rows: ds ? [ds] : [], done: state.phase >= ids.length };
      }
      if (dbs) {
        // Pushed database_id: list the database's data sources, then read each.
        if (state.phase === 0) {
          for (const d of dbs) {
            const db = await getOrNull(scan.cfg, `/v1/databases/${d}`);
            for (const s of (db?.data_sources ?? []) as Json[]) state.queue.push(String(s.id));
          }
          state.phase = 1;
        }
        const id = state.queue.shift();
        if (!id) return { rows: [], done: true };
        const ds = await getOrNull(scan.cfg, `/v1/data_sources/${id}`);
        return { rows: ds ? [ds] : [], done: state.queue.length === 0 };
      }
      const page = await searchDataSources(scan.cfg, state.cursor);
      state.cursor = page.has_more && page.next_cursor ? page.next_cursor : "";
      return { rows: page.results, done: !state.cursor };
    },
    pushdown:
      "WHERE id = / IN → GET /v1/data_sources/{id} per id; WHERE database_id = / IN → the database's data " +
      "sources; otherwise a search filtered to data sources.",
    examples: [
      {
        sql: "SELECT title, property_count, database_id FROM notion.main.data_sources ORDER BY last_edited_time DESC",
        description: "Every data source the integration can query, most recently edited first",
      },
    ],
  },
  SCHEMA,
);

// -------------------------------------------------------------------- databases

const DS_REF = struct([field("id", utf8()), field("name", utf8())]);

export const DATABASES = defineCatalogTable<FanoutState>(
  {
    name: "databases",
    description: "Notion databases (containers of one or more data sources) shared with the integration",
    title: "Databases",
    category: "databases",
    keywords: "notion, databases, containers, data sources, inline, list, catalog",
    docLlm:
      "Notion databases (containers) shared with the integration: id (the id in the database URL), title, " +
      "description, url, is_inline, is_locked, parent, data_source_ids and data_sources (id, name), times, " +
      "in_trash, icon. Found through the data sources search (the API has no database listing), so a " +
      "database appears once one of its data sources is shared. WHERE id = '…' reads that database " +
      "directly. Use query_database(id) when it has one data source, otherwise query_data_source.",
    docMd:
      "Notion databases with the data sources they contain. A database id (from its URL) works with " +
      "`query_database(id)` when the database has one data source.",
    columns: [
      C.str("id", "Database id (from its URL).", "id", false),
      C.str("title", "Database title.", (r) => plainOrNull(r.title)),
      C.str("description", "Database description (plain text).", (r) => plainOrNull(r.description)),
      C.str("url", "URL in the Notion app.", "url"),
      C.str("public_url", "Public URL when published to the web.", "public_url"),
      C.bool("is_inline", "true for an inline database (inside a page's content).", "is_inline"),
      C.bool("is_locked", "true when the database is locked against edits.", "is_locked"),
      C.str("parent_type", "Where it lives: page_id, block_id or workspace.", parentType),
      C.str("parent_id", "Id of the parent page or block.", parentId),
      C.strList("data_source_ids", "Ids of its data sources.", (r) =>
        ((r.data_sources ?? []) as Json[]).map((d) => d.id),
      ),
      C.any("data_sources", list(DS_REF), 'STRUCT(id VARCHAR, "name" VARCHAR)[]', "Its data sources (id, name).", (r) =>
        ((r.data_sources ?? []) as Json[]).map((d) => ({ id: asStr(d.id), name: asStr(d.name) })),
      ),
      C.time("created_time", "When it was created.", "created_time"),
      C.time("last_edited_time", "When it was last edited.", "last_edited_time"),
      C.bool("in_trash", "true when it is in the trash.", inTrash),
      C.str("icon", "Icon: an emoji or an image URL.", (r) => iconOf(r.icon)),
    ],
    primaryKey: "id",
    initialState: fanoutInit,
    next: async (scan, state) => {
      const ids = idsFrom(eqValues(scan.filters, "id"));
      if (ids && state.phase === 0) {
        state.queue = ids;
        state.phase = 2;
      }
      // Phase 0: discover database ids from data sources (search has no database filter).
      if (state.phase === 0 && state.queue.length === 0) {
        const page = await searchDataSources(scan.cfg, state.cursor);
        state.cursor = page.has_more && page.next_cursor ? page.next_cursor : "";
        if (!state.cursor) state.phase = 2;
        for (const ds of page.results) {
          const db = asStr(ds.parent?.database_id);
          if (db && !state.seen.includes(db)) {
            state.seen.push(db);
            state.queue.push(db);
          }
        }
        return { rows: [], done: state.phase === 2 && state.queue.length === 0 };
      }
      const id = state.queue.shift();
      if (!id) return { rows: [], done: state.phase === 2 };
      const db = await getOrNull(scan.cfg, `/v1/databases/${id}`);
      return { rows: db ? [db] : [], done: state.phase === 2 && state.queue.length === 0 };
    },
    pushdown: "WHERE id = / IN → GET /v1/databases/{id}; otherwise the databases behind every searchable data source.",
    examples: [
      {
        sql: "SELECT title, len(data_source_ids) AS sources, is_inline FROM notion.main.databases ORDER BY title",
        description: "Databases and how many data sources each holds",
      },
    ],
  },
  SCHEMA,
);

// ----------------------------------------------------------------------- users

export const USERS = defineCatalogTable<FanoutState>(
  {
    name: "users",
    description: "People and bots in the Notion workspace",
    title: "Users",
    category: "workspace",
    keywords: "notion, users, people, members, guests, bots, integrations, workspace",
    docLlm:
      "People and bots in the workspace: id (what people, created_by and last_edited_by columns hold), " +
      "type ('person' or 'bot'), name, avatar_url, email (only with the integration's user-email " +
      "capability, otherwise NULL), bot_owner_type, bot_workspace_name. Join people lists with " +
      'list_contains("Assignee", u.id) or unnest. Guests are not listed by the API.',
    docMd: "Workspace members and bots. Emails appear only when the integration may read them.",
    columns: [
      C.str("id", "User id (what people / created_by columns hold).", "id", false),
      C.str("type", "'person' or 'bot'.", "type"),
      C.str("name", "Display name.", "name"),
      C.str("avatar_url", "Avatar image URL.", "avatar_url"),
      C.str(
        "email",
        "Email address; only returned when the integration has the 'read user information including email' capability.",
        (r) => r.person?.email,
      ),
      C.str("bot_owner_type", "Bots: 'workspace' or 'user'.", (r) => r.bot?.owner?.type),
      C.str("bot_workspace_name", "Bots: the workspace name.", (r) => r.bot?.workspace_name),
    ],
    primaryKey: "id",
    initialState: fanoutInit,
    next: async (scan, state) => {
      const ids = idsFrom(eqValues(scan.filters, "id"));
      if (ids) {
        const id = ids[state.phase];
        if (!id) return { rows: [], done: true };
        state.phase++;
        const u = await getOrNull(scan.cfg, `/v1/users/${id}`);
        return { rows: u ? [u] : [], done: state.phase >= ids.length };
      }
      const page = asList<Json>(
        await notionRequest(scan.cfg, "/v1/users", {
          query: { page_size: "100", start_cursor: state.cursor || undefined },
        }),
      );
      state.cursor = page.has_more && page.next_cursor ? page.next_cursor : "";
      return { rows: page.results, done: !state.cursor };
    },
    pushdown: "WHERE id = / IN → GET /v1/users/{id}; otherwise the paged user list.",
    examples: [
      {
        sql: "SELECT type, count(*) AS n FROM notion.main.users GROUP BY type ORDER BY type",
        description: "People versus bots in the workspace",
      },
    ],
  },
  SCHEMA,
);

// ------------------------------------------------------------------------ page()

type PageArgs = {
  page_id: string;
};

export const page = defineNotionTable<PageArgs, ScanStateBase>({
  name: "page",
  description: "One Notion page's metadata: title, parent, data source, times, raw properties",
  title: "Page Metadata",
  category: "content",
  keywords: "notion, page, metadata, title, parent, properties, lookup",
  docLlm:
    "One page's metadata by id or URL: title, url, public_url, parent_type / parent_id, data_source_id and " +
    "database_id when the page is a database row, created/last edited time and user ids, in_trash, " +
    "is_locked, icon, cover, and every property value as raw JSON (properties). For typed property " +
    "columns query the data source; for name/value pairs use page_properties.",
  docMd: "## page(page_id)\n\nOne page's metadata and raw property JSON.",
  args: { page_id: utf8() },
  argDocs: { page_id: "Page id or notion.so URL." },
  columns: [
    C.str("id", "Page id.", "id", false),
    C.str("title", "Page title.", (r) => pageTitle(r)),
    C.str("url", "URL in the Notion app.", "url"),
    C.str("public_url", "Public URL when published to the web.", "public_url"),
    C.str("parent_type", "Parent kind: workspace, page_id, block_id or data_source_id.", parentType),
    C.str("parent_id", "Id of the parent.", parentId),
    C.str("data_source_id", "Data source the page is a row of, if any.", (r) => r.parent?.data_source_id),
    C.str("database_id", "Database the page is a row of, if any.", (r) => r.parent?.database_id),
    C.time("created_time", "When it was created.", "created_time"),
    C.time("last_edited_time", "When it was last edited.", "last_edited_time"),
    C.str("created_by", "User id of the creator.", (r) => userId(r.created_by)),
    C.str("last_edited_by", "User id of the last editor.", (r) => userId(r.last_edited_by)),
    C.bool("in_trash", "true when it is in the trash.", inTrash),
    C.bool("is_locked", "true when the page is locked against edits.", "is_locked"),
    C.str("icon", "Icon: an emoji or an image URL.", (r) => iconOf(r.icon)),
    C.str("cover", "Cover image URL.", (r) => (r.cover ? fileOf(r.cover).url : null)),
    C.json("properties", "All property values as Notion returns them (JSON object keyed by name).", "properties"),
  ],
  initialState: () => ({ done: false }),
  next: async (scan) => {
    const id = normalizeId(scan.args.page_id, "page_id");
    const pg = (await notionRequest(scan.cfg, `/v1/pages/${id}`)) as Json;
    return { rows: [pg], done: true };
  },
  pushdown: "none (one GET per call).",
  examples: [
    {
      sql: "SELECT title, parent_type, data_source_id, last_edited_time FROM notion.main.page('1a2b3c4d-0000-4000-8000-00000000a001')",
      description: "Where a page lives and when it last changed",
    },
  ],
});

// -------------------------------------------------------------- page_properties()

export const pageProperties = defineNotionTable<PageArgs, ScanStateBase>({
  name: "page_properties",
  description: "One Notion page's property values in long form: one row per property with text and JSON",
  title: "Page Properties (Long Form)",
  category: "content",
  keywords: "notion, page, properties, values, key value, long form, unpivot, attributes",
  docLlm:
    "One page's properties in long form: one row per property with page_id, position, property (name), " +
    "property_id, type, text (readable: numbers as text, lists comma-separated, dates 'start → end', " +
    "people by name) and value (the raw JSON payload). Works for any page, including database rows. " +
    "Truncated relation / people lists (over 25) are completed.",
  docMd: "## page_properties(page_id)\n\nA page's property values as name / value rows.",
  args: { page_id: utf8() },
  argDocs: { page_id: "Page id or notion.so URL." },
  columns: [
    C.str("page_id", "The page id.", (r) => r.__page, false),
    C.int("position", "0-based property position in the page object.", (r) => r.__pos, false),
    C.str("property", "Property name.", (r) => r.__name, false),
    C.str("property_id", "Property id (stable across renames).", "id", false),
    C.str("type", "Notion property type.", "type", false),
    C.str("text", "The value as readable text (lists comma-separated, dates 'start → end'); NULL when empty.", (r) =>
      propertyText(r),
    ),
    C.json("value", "The value as Notion returns it (the type-specific payload).", (r) => r[r.type]),
  ],
  initialState: () => ({ done: false }),
  next: async (scan) => {
    const id = normalizeId(scan.args.page_id, "page_id");
    const pg = (await notionRequest(scan.cfg, `/v1/pages/${id}`)) as Json;
    const rows: Json[] = [];
    let pos = 0;
    for (const [name, prop] of Object.entries((pg.properties ?? {}) as Record<string, Json>)) {
      let p = prop;
      if (p?.has_more === true && (p.type === "relation" || p.type === "people")) {
        const items = await getAll<Json>(
          scan.cfg,
          `/v1/pages/${id}/properties/${encodeURIComponent(decodeURIComponent(String(p.id)))}`,
        );
        p = { ...p, has_more: false, [p.type]: items.map((i) => i[p.type]).filter((x) => x != null) };
      }
      rows.push({ ...p, __page: id, __pos: pos++, __name: name });
    }
    return { rows, done: true };
  },
  pushdown: "none (one GET per call; truncated relation / people lists are completed from the property item endpoint).",
  examples: [
    {
      sql:
        "SELECT property, type, text FROM notion.main.page_properties('1a2b3c4d-0000-4000-8000-00000000a001') " +
        "WHERE text IS NOT NULL ORDER BY position",
      description: "A page's non-empty properties as name / value pairs",
    },
  ],
});

// --------------------------------------------------------------------- comments()

type CommentArgs = {
  block_id: string;
};

const ATTACHMENT = struct([
  field("category", utf8()),
  field("url", utf8()),
  field("expiry_time", timestampMicros("UTC")),
]);

export const comments = defineNotionTable<CommentArgs, CursorState>({
  name: "comments",
  description: "Open (unresolved) comments on a Notion page or block",
  title: "Comments",
  category: "content",
  keywords: "notion, comments, discussions, feedback, review, threads",
  docLlm:
    "Unresolved comments on a page (page-level discussion) or on one block (inline comments) by id: id, " +
    "discussion_id (thread), parent_type, parent_id, created_time, last_edited_time, created_by (user id), " +
    "display_name, text (plain), rich_text (JSON), attachments. Needs the integration's 'read comments' " +
    "capability. Resolved comments are not returned by the API.",
  docMd: "## comments(block_id)\n\nOpen comments on a page or block, threaded by `discussion_id`.",
  args: { block_id: utf8() },
  argDocs: { block_id: "Page or block id (or notion.so URL). A page id returns page-level comments." },
  columns: [
    C.str("id", "Comment id.", "id", false),
    C.str("discussion_id", "Thread id: comments in one discussion share it.", "discussion_id"),
    C.str("parent_type", "'page_id' or 'block_id'.", parentType),
    C.str("parent_id", "The page or block commented on.", parentId),
    C.time("created_time", "When it was posted.", "created_time"),
    C.time("last_edited_time", "When it was last edited.", "last_edited_time"),
    C.str("created_by", "User id of the author.", (r) => userId(r.created_by)),
    C.str("display_name", "Author name as shown in Notion (custom names for integrations).", (r) =>
      asStr(r.display_name?.resolved_name),
    ),
    C.str("text", "Comment text (plain).", (r) => plainOrNull(r.rich_text)),
    C.json("rich_text", "Raw rich text (mentions, links).", "rich_text"),
    C.any(
      "attachments",
      list(ATTACHMENT),
      "STRUCT(category VARCHAR, url VARCHAR, expiry_time TIMESTAMP WITH TIME ZONE)[]",
      "Attached files: category (image, pdf, …), URL (expiring) and expiry time.",
      (r) =>
        ((r.attachments ?? []) as Json[]).map((a) => {
          const f = fileOf({ type: "file", file: a.file });
          return { category: asStr(a.category), url: f.url, expiry_time: f.expiry_time };
        }),
    ),
  ],
  initialState: () => ({ done: false, cursor: "" }),
  next: async (scan, state) => {
    const id = normalizeId(scan.args.block_id, "block_id");
    const pg = asList<Json>(
      await notionRequest(scan.cfg, "/v1/comments", {
        query: { block_id: id, page_size: "100", start_cursor: state.cursor || undefined },
      }),
    );
    state.cursor = pg.has_more && pg.next_cursor ? pg.next_cursor : "";
    return { rows: pg.results, done: !state.cursor };
  },
  pushdown: "none: Notion lists comments per page or block.",
  examples: [
    {
      sql:
        "SELECT display_name, text, created_time FROM notion.main.comments('1a2b3c4d-0000-4000-8000-00000000a001') " +
        "ORDER BY created_time",
      description: "The discussion on a page, oldest first",
    },
  ],
});

// ------------------------------------------------------------ data_source_schema()

type SchemaArgs = {
  data_source_id: string;
  rich_text_json: boolean;
};

const OPTION = struct([field("id", utf8()), field("name", utf8()), field("color", utf8()), field("group", utf8())]);

export const dataSourceSchema = defineNotionTable<SchemaArgs, ScanStateBase>({
  name: "data_source_schema",
  description: "The properties of a Notion data source and the SQL column each becomes in query_data_source",
  title: "Data Source Schema",
  category: "databases",
  keywords: "notion, schema, properties, columns, types, select options, status, describe, data source",
  docLlm:
    "The properties of a data source (or a single-source database) and the query_data_source column each " +
    "becomes: position, property, property_id, type, column_name, sql_type, json_column (the __json " +
    "sibling of title / rich_text), description, options (select / multi_select / status options with " +
    "color and status group), number_format, relation_data_source_id, formula_expression, " +
    "rollup_function, rollup_relation_property, rollup_property, unique_id_prefix, config (raw JSON). " +
    "Call it before writing a query_data_source query to get the exact column names and the option " +
    "values to filter on.",
  docMd:
    "## data_source_schema(data_source_id, rich_text_json := true)\n\nEach property, its Notion type and " +
    "the typed SQL column `query_data_source` returns for it.",
  args: { data_source_id: utf8(), rich_text_json: bool },
  argDefaults: { rich_text_json: true },
  argDocs: {
    data_source_id: "Data source id or URL (a database id works when the database has one data source).",
    rich_text_json: "Match query_data_source's rich_text_json setting when computing json_column.",
  },
  columns: [
    C.str("data_source_id", "The resolved data source id.", (r) => r.__ds, false),
    C.str("data_source_title", "The data source's name.", (r) => r.__title),
    C.int("position", "0-based position in the schema.", (r) => r.__pos, false),
    C.str("property", "Property name in Notion.", (r) => r.def.name, false),
    C.str("property_id", "Property id (stable across renames).", (r) => r.def.id, false),
    C.str(
      "type",
      "Notion property type (title, rich_text, number, select, status, date, relation, formula, …).",
      (r) => r.def.type,
      false,
    ),
    C.str(
      "column_name",
      "The query_data_source column holding it (NULL for buttons, which have no value).",
      (r) => r.__col,
    ),
    C.str("sql_type", "That column's DuckDB type.", (r) => r.__sql),
    C.str(
      "json_column",
      "The `__json` raw rich text sibling column, for title / rich_text properties.",
      (r) => r.__json,
    ),
    C.str("description", "Property description.", (r) => r.def.config.description ?? r.__desc),
    C.any(
      "options",
      list(OPTION),
      'STRUCT(id VARCHAR, "name" VARCHAR, color VARCHAR, "group" VARCHAR)[]',
      "select / multi_select / status options (status options name their group: To-do, In progress, Complete).",
      (r) => optionsOf(r.def),
    ),
    C.str("number_format", "number: the display format (number, percent, dollar, …).", (r) =>
      r.def.type === "number" ? r.def.config.format : null,
    ),
    C.str("relation_data_source_id", "relation: the related data source.", (r) =>
      r.def.type === "relation" ? r.def.config.data_source_id : null,
    ),
    C.str("formula_expression", "formula: the expression.", (r) =>
      r.def.type === "formula" ? r.def.config.expression : null,
    ),
    C.str("rollup_function", "rollup: the aggregation (count, sum, show_original, latest_date, …).", (r) =>
      r.def.type === "rollup" ? r.def.config.function : null,
    ),
    C.str("rollup_relation_property", "rollup: the relation property it rolls up through.", (r) =>
      r.def.type === "rollup" ? r.def.config.relation_property_name : null,
    ),
    C.str("rollup_property", "rollup: the property it aggregates on the related pages.", (r) =>
      r.def.type === "rollup" ? r.def.config.rollup_property_name : null,
    ),
    C.str("unique_id_prefix", "unique_id: the prefix shown before the number (e.g. 'TASK').", (r) =>
      r.def.type === "unique_id" ? r.def.config.prefix : null,
    ),
    C.json("config", "The type-specific configuration as Notion returns it.", (r) => r.def.config),
  ],
  initialState: () => ({ done: false }),
  next: async (scan) => {
    const ds = await resolveDataSource(scan.cfg, scan.args.data_source_id, "data_source_id");
    const defs = propertyDefs(ds);
    const cols = propertyColumns(defs, await sampleFormulaTypes(scan.cfg, ds), scan.args.rich_text_json !== false);
    const title = dataSourceTitle(ds);
    const rows = defs.map((def, i) => {
      const main = cols.find((c) => c.def.id === def.id && c.kind !== "rich_json");
      const json = cols.find((c) => c.def.id === def.id && c.kind === "rich_json");
      return {
        def,
        __ds: String(ds.id),
        __title: title,
        __pos: i,
        __col: main?.column ?? null,
        __sql: main ? sqlTypeOf(main.kind) : null,
        __json: json?.column ?? null,
      };
    });
    return { rows, done: true };
  },
  pushdown: "none (one GET per call, plus one sample row when the data source has formulas).",
  examples: [
    {
      sql:
        "SELECT property, type, column_name, sql_type FROM notion.main.data_source_schema('1a2b3c4d-0000-4000-8000-00000000d501') " +
        "ORDER BY position",
      description: "The columns query_data_source will return for a data source",
    },
    {
      sql:
        "SELECT property, unnest(options).name AS option FROM notion.main.data_source_schema('1a2b3c4d-0000-4000-8000-00000000d501') " +
        "WHERE type IN ('select', 'status') ORDER BY property, option",
      description: "Every select and status option, to know which values to filter on",
    },
  ],
});

export const NOTION_TABLES: TableDescriptor[] = [DATA_SOURCES, DATABASES, USERS];

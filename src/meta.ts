/**
 * Discovery metadata: catalog/schema docs, categories and helpers.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these tags.
 * Every function carries `objectTags(...)`: a title, a category from the schema's
 * category list, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "notion";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-notion";

/** Categories group functions in docs and agent tools. */
export const SCHEMA_CATEGORIES = [
  { name: "search", title: "Search", description: "Find pages and data sources shared with the integration." },
  {
    name: "databases",
    title: "Databases",
    description: "Databases, their data sources, data source schemas and typed row queries with filter pushdown.",
  },
  {
    name: "content",
    title: "Content",
    description: "Page metadata and properties, block trees, Markdown / plain-text rendering and comments.",
  },
  { name: "workspace", title: "Workspace", description: "People and bots in the workspace." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Notion API reference](https://developers.notion.com/reference/intro) (version 2026-03-11)\n" +
  "- [Data sources and the 2025-09-03 upgrade](https://developers.notion.com/docs/upgrade-guide-2025-09-03)\n" +
  "- [Query a data source](https://developers.notion.com/reference/query-a-data-source) and [filter objects](https://developers.notion.com/reference/filter-data-source-entries)\n" +
  "- [Property values](https://developers.notion.com/reference/property-value-object) and [block types](https://developers.notion.com/reference/block)\n" +
  "- [Request limits](https://developers.notion.com/reference/request-limits) and [authorization](https://developers.notion.com/docs/authorization)";

export const CATALOG_COMMENT =
  "Notion workspaces as SQL: search, databases and their data sources as typed tables, page properties, block trees, Markdown export, comments and users. Read-only, with filter pushdown.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Notion workspace through the Notion API (Notion-Version 2026-03-11, the " +
  "data-source era: a database is a container of one or more data sources, and rows are pages of a data " +
  "source). Start with search(query := '…') or the data_sources / databases tables to find ids (ids may " +
  "be pasted as notion.so URLs). data_source_schema(id) lists each property and the SQL column it " +
  "becomes; query_data_source(id) (or query_database(database_id) for a single-source database) returns " +
  'the rows with one typed column per property, named verbatim (quote them: "Status"): title/rich_text ' +
  'VARCHAR plain text plus a "<name>__json" raw rich text column, number DOUBLE, checkbox BOOLEAN, ' +
  "select/status VARCHAR, multi_select VARCHAR[], people/relation VARCHAR[] of ids, date STRUCT(start, " +
  "end TIMESTAMPTZ, time_zone, has_time), files LIST(STRUCT), unique_id BIGINT, formula/rollup typed by " +
  "result. WHERE on properties and created_time/last_edited_time pushes into Notion's filter object; " +
  "projection pushes into filter_properties. Page content: blocks(id) gives the block tree as rows " +
  "(type, text, depth, path for document order), page_markdown(id) / page_text(id) render a page to one " +
  "Markdown or plain-text document (for export, search and RAG). page(id) and page_properties(id) give " +
  "one page's metadata and its properties in long form; comments(id) the open comments; users the " +
  "people and bots. Every object needs a `notion` secret: CREATE SECRET (TYPE notion, TOKEN 'ntn_…') " +
  "with an internal integration secret (or OAUTH_ACCESS_TOKEN), and the pages/databases must be shared " +
  "with that integration. Requests are rate-limited client-side to ~3/s and 429 Retry-After is honoured. " +
  "Docs: https://developers.notion.com/reference/intro .";

export const CATALOG_DOC_MD =
  "# Notion\n\n" +
  "Query a Notion workspace from DuckDB: find pages and databases, read any database as a typed table " +
  "(one column per property), and export page content as blocks, Markdown or plain text. Read-only.\n\n" +
  "Create a `notion` secret with an integration token and share the pages and databases you want " +
  "with that integration. WHERE filters on database properties become Notion filter objects and only " +
  "the properties you select are downloaded.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Notion as SQL. Discovery: search(query := '') over pages and data sources (WHERE object = 'page' | " +
  "'data_source' pushes down); tables data_sources and databases (WHERE id = … reads one directly) and " +
  "users. Rows: data_source_schema(id) then query_data_source(id, notion_filter := NULL, notion_sorts := " +
  "NULL, rich_text_json := true) or query_database(database_id). Content: page(id), page_properties(id), " +
  "blocks(id, max_depth := 10, include_child_pages := false), page_markdown(id), page_text(id), " +
  "comments(id). Ids accept dashed UUIDs, 32 hex digits or notion.so URLs.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Search, databases and data sources (schemas and typed row queries with filter pushdown), page " +
  "metadata and properties, block trees, Markdown and plain-text rendering, comments and users.\n\n" +
  "All objects need a `notion` secret.";

/** Fixture ids used in examples and agent tasks (the replay server in test/mock_api serves them). */
export const TASKS_DS = "1a2b3c4d-0000-4000-8000-00000000d501";

export const AGENT_TEST_TASKS = [
  { name: "find_roadmap", prompt: "Find the Notion page titled 'Product Roadmap' and give its URL." },
  { name: "list_data_sources", prompt: "Which Notion data sources can the integration see? Give their titles." },
  { name: "open_tasks", prompt: "In the Notion 'Tasks' data source, which tasks are not Done? Give their names." },
  { name: "tasks_per_status", prompt: "How many tasks are there in each status in the Notion Tasks data source?" },
  { name: "search_tagged", prompt: "Which Notion tasks are tagged 'search'?" },
  { name: "estimate_total", prompt: "What is the total Estimate of all Notion tasks that are In progress?" },
  { name: "status_options", prompt: "What are the possible Status values of the Notion Tasks data source?" },
  { name: "roadmap_headings", prompt: "List the headings of the Product Roadmap page in order." },
  { name: "roadmap_todos", prompt: "How many to-do items on the Product Roadmap page are ticked?" },
  { name: "roadmap_markdown", prompt: "Export the Product Roadmap page as Markdown." },
  { name: "roadmap_comments", prompt: "Who commented on the Product Roadmap page, and what did they say?" },
  { name: "people", prompt: "List the people (not bots) in the Notion workspace." },
  { name: "ada_tasks", prompt: "Which Notion tasks is Ada Lovelace assigned to?" },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Notion",
  "vgi.subtitle": "Notion databases, pages and blocks as typed SQL tables, with filter pushdown and Markdown export.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "notion, notion api, databases, data sources, pages, blocks, markdown, wiki, knowledge base, pkm, notes",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Notion Workspace",
  domain: "knowledge management",
  "vgi.keywords": keywordsArray("notion, search, data sources, databases, pages, blocks, comments, users, markdown"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

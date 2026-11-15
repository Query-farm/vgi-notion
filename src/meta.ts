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
  "data-source era). Key concepts: a database is a container holding one or more data sources; the rows of " +
  "a data source are pages whose properties (title, status, select, people, relation, date, formula, " +
  "rollup, …) become typed columns named exactly as in Notion; a page's body is a tree of blocks that can " +
  "be read as rows or rendered to Markdown / plain text. Typical flow: find an id by title search or by " +
  "listing data sources, inspect the data source's property schema, then query its rows with ordinary SQL — " +
  "WHERE on properties and on created / last edited time is translated into Notion's filter object, and " +
  "only the selected properties are downloaded. Ids may be pasted as notion.so URLs. Reach for it to report " +
  "on Notion task boards and CRMs, join Notion data with other sources, or export page content for search " +
  "and RAG. Everything needs a `notion` secret: CREATE SECRET (TYPE notion, TOKEN 'ntn_…') with an internal " +
  "integration secret (or OAUTH_ACCESS_TOKEN), and the pages and databases must be shared with that " +
  "integration. Requests are rate-limited client-side to about 3 per second and 429 Retry-After is honoured. " +
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
  "Notion as SQL. Discovery objects list what the integration can see (pages and data sources by title, " +
  "databases, people); typed row queries turn one data source into a table whose columns are its " +
  "properties, with WHERE pushed into Notion's filter; content objects read one page's metadata, " +
  "properties, block tree, rendered Markdown / text and comments. Ids accept dashed UUIDs, 32 hex digits " +
  "or notion.so URLs. people / relation columns hold ids: join them to the users table or to another " +
  "data source's id.";

export const SCHEMA_COMMENT =
  "Read-only SQL over the Notion pages, databases, content, comments and people an integration can see.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "A read-only view of a Notion workspace, scoped to what the integration behind the `notion` secret has been " +
  "shared with. Discover pages and data sources by title, then query a data source as a typed table whose " +
  "columns are its properties; `WHERE` predicates on those columns are pushed into Notion's own filter, so only " +
  "matching rows come back.\n\n" +
  "Page content is available as structured blocks or rendered Markdown and plain text, alongside metadata, " +
  "properties and comments. Ids accept dashed UUIDs, 32 hex digits or notion.so URLs, and people and relation " +
  "columns hold ids you can join back to users or to another data source.";

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
  {
    name: "database_sources",
    prompt: "Which Notion database holds more than one data source, and what are they called?",
  },
  {
    name: "done_via_database_url",
    prompt:
      "How many tasks are Done in the database at https://www.notion.so/acme/Tasks-1a2b3c4d00004000800000000000d001 ?",
  },
  {
    name: "task_parent",
    prompt: "Which data source is the Notion page 1a2b3c4d-0000-4000-8000-00000000c001 a row of?",
  },
  {
    name: "task_properties",
    prompt:
      "List the non-empty properties of the Notion page 'Search UI' (id 1a2b3c4d-0000-4000-8000-00000000c004) with their values.",
  },
  { name: "roadmap_word_count", prompt: "Roughly how many words of text does the Product Roadmap page contain?" },
];

/** Guaranteed-runnable probes: they bind each object and show its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "search_columns",
    description: "The search() result columns (binds only; create a notion secret and drop LIMIT 0 for rows)",
    sql: "SELECT object, id, title, url, last_edited_time FROM notion.main.search() LIMIT 0",
  },
  {
    name: "users_columns",
    description: "The users table's columns (binds only; create a notion secret and drop LIMIT 0 for rows)",
    sql: "SELECT id, type, name, email FROM notion.main.users LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Notion Workspace as SQL",
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
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Notion Workspace",
  domain: "knowledge management",
  "vgi.keywords": keywordsArray("notion, search, data sources, databases, pages, blocks, comments, users, markdown"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

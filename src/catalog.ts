/**
 * Assemble the `notion` catalog: schema `main` and the `notion` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { CATALOG_COMMENT, CATALOG_NAME, CATALOG_TAGS, SCHEMA_DOC_MD, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";
import { blocks, pageMarkdown, pageText } from "./notion/blocks.ts";
import { DEFAULT_BASE_URL, DEFAULT_RPS, NOTION_VERSION, SECRET_TYPE } from "./notion/client.ts";
import { queryDatabase, queryDataSource } from "./notion/query.ts";
import { comments, dataSourceSchema, NOTION_TABLES, page, pageProperties, search } from "./notion/resources.ts";

export const FUNCTIONS: VgiFunction[] = [
  search,
  dataSourceSchema,
  queryDataSource,
  queryDatabase,
  page,
  pageProperties,
  blocks,
  pageMarkdown,
  pageText,
  comments,
];

const doc = (text: string) => new Map([["vgi_doc", text]]);
const redacted = (text: string) =>
  new Map([
    ["redact", "true"],
    ["vgi_doc", text],
  ]);

/** CREATE SECRET (TYPE notion, TOKEN 'ntn_…') — or OAUTH_ACCESS_TOKEN for a public integration. */
export const NOTION_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Notion integration token (internal integration secret or OAuth access token)",
  schema: schema(
    [
      field(
        "token",
        utf8(),
        true,
        redacted(
          "Internal integration secret (ntn_… or secret_…) from notion.so/profile/integrations, sent as Bearer.",
        ),
      ),
      field(
        "oauth_access_token",
        utf8(),
        true,
        redacted("A public integration's OAuth 2.0 access token (sent as Bearer)."),
      ),
      field(
        "base_url",
        utf8(),
        true,
        doc(`API base URL (default ${DEFAULT_BASE_URL}); http:// only for 127.0.0.1/localhost, e.g. a fixture server.`),
      ),
      field("notion_version", utf8(), true, doc(`Notion-Version header to send (default ${NOTION_VERSION}).`)),
      field(
        "requests_per_second",
        utf8(),
        true,
        doc(`Client-side average request rate (default ${DEFAULT_RPS}, Notion's documented limit).`),
      ),
    ],
    new Map([["vgi_doc_url", "https://developers.notion.com/docs/authorization"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const tableExamples = NOTION_TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);
const ALL_EXAMPLES = [...stampExampleQueries(FUNCTIONS), ...tableExamples];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [NOTION_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tables: NOTION_TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES) },
    },
  ],
};

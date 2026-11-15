// Unit tests. The SQL-level tests live in test/sql and run through DuckDB against the replay server.

import { describe, expect, test } from "bun:test";
import type { PushdownFilters } from "@query-farm/vgi";
import { CATALOG } from "../src/catalog.ts";
import {
  acquire,
  configFromSecrets,
  type NotionConfig,
  normalizeBaseUrl,
  resetBuckets,
  retryDelayMs,
} from "../src/notion/client.ts";
import { combineFilters, DATE_SLACK_MS, depth, type FilterColumn, FilterTranslator } from "../src/notion/filter.ts";
import { normalizeId } from "../src/notion/ids.ts";
import { extractValue, kindOf, propertyColumns, propertyDefs, propertyText } from "../src/notion/properties.ts";
import { renderBlocks, renderPage } from "../src/notion/render.ts";
import { richTextMarkdown } from "../src/notion/richtext.ts";

// ------------------------------------------------------------------------ helpers

type Expr = PushdownFilters["filters"][number];
const col = (name: string): Expr => ({ node: "column_ref", columnIndex: 0, columnName: name }) as Expr;
const lit = (value: unknown): Expr => ({ node: "literal", valueRef: 0, value }) as unknown as Expr;
const cmp = (op: string, name: string, value: unknown): Expr =>
  ({ node: "comparison", op, left: col(name), right: lit(value) }) as unknown as Expr;
const and = (...children: Expr[]): Expr => ({ node: "and", children }) as Expr;
const or = (...children: Expr[]): Expr => ({ node: "or", children }) as Expr;
const pushed = (...filters: Expr[]) => ({ filters }) as unknown as PushdownFilters;

const COLUMNS = new Map<string, FilterColumn>([
  ["Name", { kind: "property", propertyId: "title", type: "title", valueKind: "text" }],
  ["Status", { kind: "property", propertyId: "st", type: "status", valueKind: "option" }],
  ["Estimate", { kind: "property", propertyId: "est", type: "number", valueKind: "number" }],
  ["Tags", { kind: "property", propertyId: "tag", type: "multi_select", valueKind: "options" }],
  ["Due", { kind: "property", propertyId: "due", type: "date", valueKind: "date" }],
  ["Done", { kind: "property", propertyId: "chk", type: "checkbox", valueKind: "checkbox" }],
  ["created_time", { kind: "timestamp", timestamp: "created_time" }],
]);
const T = new FilterTranslator(COLUMNS);

// ---------------------------------------------------------------------------- ids

test("ids: dashed, bare hex and notion.so URLs normalize to the dashed form", () => {
  const dashed = "1a2b3c4d-0000-4000-8000-00000000d001";
  expect(normalizeId(dashed)).toBe(dashed);
  expect(normalizeId("1A2B3C4D00004000800000000000D001")).toBe(dashed);
  expect(
    normalizeId("https://www.notion.so/acme/Tasks-1a2b3c4d00004000800000000000d001?v=ffffffffffffffffffffffffffffffff"),
  ).toBe(dashed);
  // ?p= opens a page peeked from a database: the page is the object.
  expect(
    normalizeId("https://www.notion.so/acme/db-1a2b3c4d00004000800000000000d001?p=1a2b3c4d00004000800000000000c001"),
  ).toBe("1a2b3c4d-0000-4000-8000-00000000c001");
  expect(() => normalizeId("nope")).toThrow(/does not contain a Notion id/);
  expect(() => normalizeId("")).toThrow(/required/);
});

// --------------------------------------------------------------------- the client

test("client: secret validation", () => {
  expect(() => configFromSecrets({})).toThrow(/no notion secret/);
  expect(() => configFromSecrets({ s: { type: "notion" } })).toThrow(/set TOKEN/);
  const cfg = configFromSecrets({ s: { type: "notion", oauth_access_token: "abc", requests_per_second: "5" } });
  expect(cfg.baseUrl).toBe("https://api.notion.com");
  expect(cfg.token).toBe("abc");
  expect(cfg.rps).toBe(5);
  expect(cfg.notionVersion).toBe("2026-03-11");
  expect(cfg.bucketKey).not.toContain("abc");
  expect(() => configFromSecrets({ s: { type: "notion", token: "x", requests_per_second: "0" } })).toThrow();
  expect(() => normalizeBaseUrl("http://example.com")).toThrow(/https/);
  expect(normalizeBaseUrl("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");
});

test("client: Retry-After in seconds or as an HTTP date", () => {
  expect(retryDelayMs(new Headers({ "Retry-After": "2" }))).toBe(2000);
  expect(retryDelayMs(new Headers({ "Retry-After": "Thu, 01 Jan 2026 00:00:10 GMT" }), Date.UTC(2026, 0, 1))).toBe(
    10_000,
  );
  expect(retryDelayMs(new Headers())).toBeUndefined();
});

test("client: the token bucket allows a burst, then the average rate", async () => {
  resetBuckets();
  const cfg = { rps: 50, bucketKey: "unit" } as NotionConfig;
  const start = performance.now();
  for (let i = 0; i < 60; i++) await acquire(cfg);
  // 50 burst tokens, then 10 more at 50/s ≈ 200 ms.
  const elapsed = performance.now() - start;
  expect(elapsed).toBeGreaterThan(150);
  expect(elapsed).toBeLessThan(2000);
});

// ---------------------------------------------------------------------- pushdown

test("pushdown: a conjunction becomes an `and` of property conditions", () => {
  expect(T.fromPushdown(pushed(cmp("eq", "Status", "Done"), cmp("ge", "Estimate", 3n)))).toEqual({
    and: [
      { property: "st", status: { equals: "Done" } },
      { property: "est", number: { greater_than_or_equal_to: 3 } },
    ],
  });
});

test("pushdown: untranslatable conjuncts are dropped, untranslatable OR branches drop the OR", () => {
  // ne on text is not sent (Notion compares more loosely): only the number survives.
  expect(T.fromPushdown(pushed(cmp("ne", "Name", "x"), cmp("lt", "Estimate", 2)))).toEqual({
    property: "est",
    number: { less_than: 2 },
  });
  // OR with an untranslatable branch is not sent at all.
  expect(T.fromPushdown(pushed(or(cmp("eq", "Status", "Done"), cmp("ne", "Name", "x"))))).toBeUndefined();
  expect(T.fromPushdown(pushed(or(cmp("eq", "Status", "Done"), cmp("eq", "Done", true))))).toEqual({
    or: [
      { property: "st", status: { equals: "Done" } },
      { property: "chk", checkbox: { equals: true } },
    ],
  });
});

test("pushdown: nesting never exceeds Notion's two levels", () => {
  // and( or( and(a, b), c ), d ): the inner AND is narrowed to one conjunct.
  const f = T.fromPushdown(
    pushed(
      or(and(cmp("eq", "Status", "Done"), cmp("gt", "Estimate", 1)), cmp("eq", "Done", true)),
      cmp("eq", "Name", "A"),
    ),
  );
  expect(depth(f)).toBeLessThanOrEqual(2);
  expect(f).toEqual({
    and: [
      {
        or: [
          { property: "st", status: { equals: "Done" } },
          { property: "chk", checkbox: { equals: true } },
        ],
      },
      { property: "title", title: { equals: "A" } },
    ],
  });
});

test("pushdown: IN, list_contains, IS NULL and time ranges", () => {
  const inExpr = {
    node: "in",
    negated: false,
    expression: col("Status"),
    set: { kind: "literal", valueRef: 0, values: ["A", "B"] },
  } as unknown as Expr;
  expect(T.fromPushdown(pushed(inExpr))).toEqual({
    or: [
      { property: "st", status: { equals: "A" } },
      { property: "st", status: { equals: "B" } },
    ],
  });
  const contains = { node: "call", function: "list_contains", arguments: [col("Tags"), lit("x")] } as unknown as Expr;
  expect(T.fromPushdown(pushed(contains))).toEqual({ property: "tag", multi_select: { contains: "x" } });
  const isNull = { node: "is_null", negated: false, expression: col("Status") } as unknown as Expr;
  expect(T.fromPushdown(pushed(isNull))).toEqual({ property: "st", status: { is_empty: true } });

  const us = BigInt(Date.UTC(2026, 10, 1)) * 1000n;
  expect(T.fromPushdown(pushed(cmp("lt", "created_time", us)))).toEqual({
    timestamp: "created_time",
    created_time: { on_or_before: new Date(Date.UTC(2026, 10, 1) + DATE_SLACK_MS).toISOString() },
  });
  // Date range: only a lower bound on .start, never an upper bound.
  const field = (op: string) =>
    ({
      node: "comparison",
      op,
      left: { node: "field_ref", expression: col("Due"), fieldIndex: 0, fieldName: "start" },
      right: lit(us),
    }) as unknown as Expr;
  expect(T.fromPushdown(pushed(field("ge")))).toEqual({
    property: "due",
    date: { on_or_after: new Date(Date.UTC(2026, 10, 1) - DATE_SLACK_MS).toISOString() },
  });
  expect(T.fromPushdown(pushed(field("lt")))).toBeUndefined();
});

test("pushdown: a user filter is ANDed unless that would nest too deep", () => {
  const user = { property: "Tags", multi_select: { contains: "a" } };
  const p = { property: "st", status: { equals: "Done" } };
  expect(combineFilters(user, p)).toEqual({ and: [user, p] });
  expect(combineFilters(undefined, p)).toEqual(p);
  const deep = { or: [{ and: [user, p] }, p] };
  expect(combineFilters(deep, { or: [p, p] })).toEqual(deep);
});

// -------------------------------------------------------------------- properties

const DS = {
  properties: {
    Name: { id: "title", name: "Name", type: "title", title: {} },
    url: { id: "u", name: "url", type: "url", url: {} },
    Status: { id: "s", name: "Status", type: "status", status: { options: [] } },
    status: { id: "s2", name: "status", type: "select", select: { options: [] } },
    F: { id: "f", name: "F", type: "formula", formula: { expression: "1" } },
    R: { id: "r", name: "R", type: "rollup", rollup: { function: "latest_date" } },
    B: { id: "b", name: "B", type: "button", button: {} },
    Place: { id: "p", name: "Place", type: "place", place: {} },
  },
};

test("properties: columns keep names, rename collisions, add __json siblings, skip buttons", () => {
  const cols = propertyColumns(propertyDefs(DS), { f: "number" });
  expect(cols.map((c) => [c.column, c.kind])).toEqual([
    ["Name", "text"],
    ["Name__json", "rich_json"],
    ["url_2", "string"],
    ["Status", "option"],
    ["status_2", "option"],
    ["F", "formula_number"],
    ["R", "rollup_date"],
    ["Place", "json"],
  ]);
  expect(kindOf({ id: "f", name: "F", type: "formula", config: {} })).toBe("formula_string");
});

test("properties: value extraction by kind", () => {
  expect(extractValue({ type: "title", title: [] }, "text")).toBeNull();
  expect(extractValue({ type: "title", title: [{ plain_text: "a" }, { plain_text: "b" }] }, "text")).toBe("ab");
  expect(extractValue({ type: "date", date: { start: "2026-11-03", end: null, time_zone: null } }, "date")).toEqual({
    start: BigInt(Date.UTC(2026, 10, 3)) * 1000n,
    end: null,
    time_zone: null,
    has_time: false,
  });
  expect(extractValue({ type: "unique_id", unique_id: { prefix: "T", number: 7 } }, "unique_id")).toBe(7n);
  expect(extractValue({ type: "formula", formula: { type: "string", string: null } }, "formula_number")).toBeNull();
  expect(
    extractValue({ type: "rollup", rollup: { type: "array", array: [{ type: "number", number: 2 }] } }, "rollup_array"),
  ).toEqual(["2"]);
  expect(propertyText({ type: "unique_id", unique_id: { prefix: "T", number: 7 } })).toBe("T-7");
  expect(propertyText({ type: "multi_select", multi_select: [] })).toBeNull();
});

// ------------------------------------------------------------------------ render

const rt = (text: string, ann: Record<string, boolean> = {}, href: string | null = null) => ({
  type: "text",
  plain_text: text,
  href,
  annotations: ann,
});
const b = (type: string, body: Record<string, unknown>, children: ReturnType<typeof node>[] = []) =>
  node(type, body, children);
function node(type: string, body: Record<string, unknown>, children: { block: unknown; children: unknown[] }[] = []) {
  return { block: { type, [type]: body }, children } as never as { block: Record<string, unknown>; children: [] };
}

test("render: rich text marks, escaping and links", () => {
  expect(richTextMarkdown([rt("a*b"), rt(" bold ", { bold: true }), rt("x", {}, "https://e.com")])).toBe(
    "a\\*b **bold** [x](https://e.com)",
  );
  expect(richTextMarkdown([rt("f()", { code: true, bold: true })])).toBe("`f()`");
});

test("render: lists, numbering, nesting and code fences", () => {
  const nodes = [
    b("bulleted_list_item", { rich_text: [rt("a")] }, [b("numbered_list_item", { rich_text: [rt("x")] })]),
    b("numbered_list_item", { rich_text: [rt("one")] }),
    b("numbered_list_item", { rich_text: [rt("two")] }),
    b("code", { rich_text: [rt("x = 1")], language: "plain text" }),
  ];
  expect(renderBlocks(nodes as never, "markdown")).toBe("- a\n  1. x\n\n1. one\n2. two\n\n```\nx = 1\n```");
  expect(renderPage("T", nodes as never, "text")).toBe("T\n\n- a\n  1. x\n\n1. one\n2. two\n\nx = 1\n");
});

// ----------------------------------------------------------------------- catalog

test("catalog: functions, tables and the notion secret type", () => {
  const schema = CATALOG.schemas[0];
  expect(CATALOG.name).toBe("notion");
  expect(schema?.functions?.map((f) => f.meta.name).sort()).toEqual([
    "blocks",
    "comments",
    "data_source_schema",
    "page",
    "page_markdown",
    "page_properties",
    "page_text",
    "query_data_source",
    "query_database",
    "search",
  ]);
  expect(schema?.tables?.map((t) => t.name).sort()).toEqual(["data_sources", "databases", "users"]);
  const secret = CATALOG.secretTypes?.[0];
  expect(secret?.name).toBe("notion");
  const token = secret?.schema.fields.find((f) => f.name === "token");
  expect(token?.metadata?.get("redact")).toBe("true");
});

describe("render: tables", () => {
  test("pipe table with a header row", () => {
    const table = b("table", { table_width: 2, has_column_header: true }, [
      b("table_row", { cells: [[rt("h1")], [rt("h|2")]] }),
      b("table_row", { cells: [[rt("a")], []] }),
    ]);
    expect(renderBlocks([table] as never, "markdown")).toBe("| h1 | h\\|2 |\n| --- | --- |\n| a |  |");
  });
});

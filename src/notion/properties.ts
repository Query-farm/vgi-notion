/**
 * Notion property types → typed DuckDB columns.
 *
 * A data source's schema (`GET /v1/data_sources/{id}` → `properties`) becomes one column
 * per property, plus a `<name>__json` sibling holding the raw rich text of title and
 * rich_text properties (marks, links, mentions). The mapping:
 *
 * | Notion type | Column |
 * | --- | --- |
 * | title, rich_text | VARCHAR plain text (+ `__json` JSON sibling) |
 * | number | DOUBLE |
 * | checkbox | BOOLEAN |
 * | select, status | VARCHAR option name |
 * | multi_select | VARCHAR[] option names |
 * | people, created_by / last_edited_by (lists) | VARCHAR[] user ids / VARCHAR user id |
 * | relation | VARCHAR[] related page ids |
 * | date | STRUCT(start TIMESTAMPTZ, end TIMESTAMPTZ, time_zone VARCHAR, has_time BOOLEAN) |
 * | created_time, last_edited_time | TIMESTAMPTZ |
 * | url, email, phone_number | VARCHAR |
 * | files | STRUCT(name, type, url, expiry_time)[] |
 * | unique_id | BIGINT (the number; the prefix is in `data_source_schema`) |
 * | formula | by result type (sampled from one row): VARCHAR, DOUBLE, BOOLEAN or the date STRUCT |
 * | rollup | by function: DOUBLE (count/sum/average/…), date STRUCT (earliest/latest/date_range) or VARCHAR[] (show_original/show_unique) |
 * | verification | VARCHAR state (verified / unverified / expired) |
 * | button | not a column (it has no value) |
 * | anything else | JSON |
 *
 * Column metadata carries the Notion property id, type and value kind, so a scan can
 * extract values from the bound schema alone (every batch may run on a different
 * process over HTTP).
 */

import {
  bool,
  field,
  float64,
  int64,
  list,
  struct,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiField,
} from "@query-farm/vgi";
import { plainOrNull, plainText } from "./richtext.ts";
import { asBig, asBool, asJson, asNum, asStr, asTime, fileOf, type Json, userId } from "./values.ts";

/** How a column's value is pulled out of a page property. */
export type ValueKind =
  | "text"
  | "rich_json"
  | "number"
  | "checkbox"
  | "option"
  | "options"
  | "date"
  | "ids"
  | "user"
  | "time"
  | "string"
  | "files"
  | "unique_id"
  | "formula_string"
  | "formula_number"
  | "formula_boolean"
  | "formula_date"
  | "rollup_number"
  | "rollup_date"
  | "rollup_array"
  | "verification"
  | "json";

export const DATE_TYPE = struct([
  field("start", timestampMicros("UTC"), true, new Map([["comment", "Start instant (all-day dates at 00:00 UTC)."]])),
  field("end", timestampMicros("UTC"), true, new Map([["comment", "End instant of a range, NULL for a single date."]])),
  field("time_zone", utf8(), true, new Map([["comment", "IANA time zone the date was entered in, if any."]])),
  field("has_time", bool, true, new Map([["comment", "false for an all-day date (no time component)."]])),
]);
export const DATE_SQL =
  'STRUCT("start" TIMESTAMP WITH TIME ZONE, "end" TIMESTAMP WITH TIME ZONE, time_zone VARCHAR, has_time BOOLEAN)';

export const FILE_TYPE = struct([
  field("name", utf8()),
  field("type", utf8()),
  field("url", utf8()),
  field("expiry_time", timestampMicros("UTC")),
]);
export const FILES_SQL = 'STRUCT("name" VARCHAR, "type" VARCHAR, url VARCHAR, expiry_time TIMESTAMP WITH TIME ZONE)[]';

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

interface KindInfo {
  type: () => VgiDataType;
  sql: string;
  json?: boolean;
}

const KINDS: Record<ValueKind, KindInfo> = {
  text: { type: utf8, sql: "VARCHAR" },
  rich_json: { type: utf8, sql: "JSON", json: true },
  number: { type: float64, sql: "DOUBLE" },
  checkbox: { type: () => bool, sql: "BOOLEAN" },
  option: { type: utf8, sql: "VARCHAR" },
  options: { type: () => list(utf8()), sql: "VARCHAR[]" },
  date: { type: () => DATE_TYPE, sql: DATE_SQL },
  ids: { type: () => list(utf8()), sql: "VARCHAR[]" },
  user: { type: utf8, sql: "VARCHAR" },
  time: { type: () => timestampMicros("UTC"), sql: "TIMESTAMP WITH TIME ZONE" },
  string: { type: utf8, sql: "VARCHAR" },
  files: { type: () => list(FILE_TYPE), sql: FILES_SQL },
  unique_id: { type: int64, sql: "BIGINT" },
  formula_string: { type: utf8, sql: "VARCHAR" },
  formula_number: { type: float64, sql: "DOUBLE" },
  formula_boolean: { type: () => bool, sql: "BOOLEAN" },
  formula_date: { type: () => DATE_TYPE, sql: DATE_SQL },
  rollup_number: { type: float64, sql: "DOUBLE" },
  rollup_date: { type: () => DATE_TYPE, sql: DATE_SQL },
  rollup_array: { type: () => list(utf8()), sql: "VARCHAR[]" },
  verification: { type: utf8, sql: "VARCHAR" },
  json: { type: utf8, sql: "JSON", json: true },
};

export const sqlTypeOf = (k: ValueKind) => KINDS[k].sql;

const ROLLUP_DATE = new Set(["earliest_date", "latest_date", "date_range"]);
const ROLLUP_ARRAY = new Set(["show_original", "show_unique"]);

/** A Notion property definition from a data source schema. */
export interface PropertyDef {
  id: string;
  name: string;
  type: string;
  config: Json;
}

export function propertyDefs(dataSource: Json): PropertyDef[] {
  const props = (dataSource?.properties ?? {}) as Record<string, Json>;
  return Object.entries(props).map(([name, p]) => ({
    id: String(p.id ?? name),
    name: String(p.name ?? name),
    type: String(p.type ?? "unknown"),
    config: (p[String(p.type)] ?? {}) as Json,
  }));
}

/** The value kind of a property (formula results come from a sample row, see `sampleFormulaTypes`). */
export function kindOf(def: PropertyDef, formulaTypes: Record<string, string> = {}): ValueKind | null {
  switch (def.type) {
    case "title":
    case "rich_text":
      return "text";
    case "number":
      return "number";
    case "checkbox":
      return "checkbox";
    case "select":
    case "status":
      return "option";
    case "multi_select":
      return "options";
    case "date":
      return "date";
    case "people":
    case "relation":
      return "ids";
    case "created_by":
    case "last_edited_by":
      return "user";
    case "created_time":
    case "last_edited_time":
      return "time";
    case "url":
    case "email":
    case "phone_number":
      return "string";
    case "files":
      return "files";
    case "unique_id":
      return "unique_id";
    case "formula": {
      const t = formulaTypes[def.id];
      if (t === "number") return "formula_number";
      if (t === "boolean") return "formula_boolean";
      if (t === "date") return "formula_date";
      return "formula_string";
    }
    case "rollup": {
      const fn = String(def.config.function ?? "");
      if (ROLLUP_ARRAY.has(fn)) return "rollup_array";
      if (ROLLUP_DATE.has(fn)) return "rollup_date";
      return fn ? "rollup_number" : "json";
    }
    case "verification":
      return "verification";
    case "button":
      return null;
    default:
      return "json";
  }
}

/** One output column of `query_data_source`. */
export interface PropColumn {
  column: string;
  def: PropertyDef;
  kind: ValueKind;
}

/** Fixed per-page columns of `query_data_source` (properties come between id and url). */
export const PAGE_META = [
  { name: "url", sql: "VARCHAR", doc: "Page URL in the Notion app.", type: utf8 },
  {
    name: "created_time",
    sql: "TIMESTAMP WITH TIME ZONE",
    doc: "When the page (row) was created.",
    type: () => timestampMicros("UTC"),
  },
  {
    name: "last_edited_time",
    sql: "TIMESTAMP WITH TIME ZONE",
    doc: "When the page was last edited (Notion rounds to the minute).",
    type: () => timestampMicros("UTC"),
  },
  { name: "created_by", sql: "VARCHAR", doc: "User id of the page's creator.", type: utf8 },
  { name: "last_edited_by", sql: "VARCHAR", doc: "User id of the last editor.", type: utf8 },
  { name: "in_trash", sql: "BOOLEAN", doc: "true when the page is in the trash.", type: () => bool },
] as const;

const RESERVED = ["id", ...PAGE_META.map((m) => m.name)];

/**
 * Columns for a data source's properties: names kept verbatim; a name that collides
 * (case-insensitively, as DuckDB compares identifiers) with a fixed column or an earlier
 * property gets a `_2`, `_3`, … suffix. Title/rich_text also get a `__json` sibling.
 */
export function propertyColumns(
  defs: PropertyDef[],
  formulaTypes: Record<string, string> = {},
  richJson = true,
): PropColumn[] {
  const taken = new Set(RESERVED.map((n) => n.toLowerCase()));
  const claim = (base: string) => {
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
    taken.add(name.toLowerCase());
    return name;
  };
  // The title property first, as Notion shows it, then the rest in schema order.
  const ordered = [...defs.filter((d) => d.type === "title"), ...defs.filter((d) => d.type !== "title")];
  const out: PropColumn[] = [];
  for (const def of ordered) {
    const kind = kindOf(def, formulaTypes);
    if (!kind) continue;
    out.push({ column: claim(def.name), def, kind });
    if (richJson && (def.type === "title" || def.type === "rich_text")) {
      out.push({ column: claim(`${def.name}__json`), def, kind: "rich_json" });
    }
  }
  return out;
}

export function describeProperty(c: PropColumn): string {
  const d = c.def;
  if (c.kind === "rich_json")
    return `Raw rich text JSON of the '${d.name}' ${d.type} property (marks, links, mentions).`;
  const extra =
    d.type === "formula"
      ? ` Formula: ${asStr(d.config.expression) ?? "?"}.`
      : d.type === "rollup"
        ? ` Rollup ${asStr(d.config.function) ?? "?"} of '${asStr(d.config.rollup_property_name) ?? "?"}'.`
        : "";
  const desc = asStr(d.config.description) ?? "";
  return `Notion ${d.type} property '${d.name}'.${extra}${desc ? ` ${desc}` : ""}`;
}

/** The Arrow field for a property column; metadata tells a scan how to extract it. */
export function propertyField(c: PropColumn): VgiField {
  const meta = new Map<string, string>([
    ["comment", describeProperty(c)],
    ["notion_property_id", c.def.id],
    ["notion_type", c.def.type],
    ["notion_kind", c.kind],
  ]);
  if (KINDS[c.kind].json) meta.set(JSON_META[0], JSON_META[1]);
  return field(c.column, KINDS[c.kind].type(), true, meta);
}

/** Read a property column definition back from a bound field's metadata. */
export function columnFromField(f: VgiField): { propertyId: string; type: string; kind: ValueKind } | null {
  const m = f.metadata;
  const id = m?.get("notion_property_id");
  const kind = m?.get("notion_kind") as ValueKind | undefined;
  if (!id || !kind) return null;
  return { propertyId: id, type: m?.get("notion_type") ?? "", kind };
}

// ------------------------------------------------------------------ value extraction

export function dateValue(d: unknown): Json | null {
  const x = d as Json | null;
  if (!x || typeof x.start !== "string") return null;
  return {
    start: asTime(x.start),
    end: asTime(x.end),
    time_zone: asStr(x.time_zone),
    has_time: x.start.includes("T"),
  };
}

/** A page property value (`{id, type, <type>: …}`) → the column value for `kind`. */
export function extractValue(prop: unknown, kind: ValueKind): unknown {
  const p = prop as Json | null;
  if (!p || typeof p !== "object") return null;
  const v = p[p.type];
  switch (kind) {
    case "text":
      return plainOrNull(v);
    case "rich_json":
      return Array.isArray(v) && v.length > 0 ? JSON.stringify(v) : null;
    case "number":
      return asNum(v);
    case "checkbox":
      return asBool(v);
    case "option":
      return asStr(v?.name);
    case "options":
      return Array.isArray(v) ? v.map((o: Json) => asStr(o?.name)).filter((x): x is string => x !== null) : [];
    case "date":
      return dateValue(v);
    case "ids":
      return Array.isArray(v) ? v.map((o: Json) => asStr(o?.id)).filter((x): x is string => x !== null) : [];
    case "user":
      return userId(v);
    case "time":
      return asTime(v);
    case "string":
      return asStr(v);
    case "files":
      return Array.isArray(v) ? v.map(fileOf) : [];
    case "unique_id":
      return asBig(v?.number);
    case "formula_string":
      return v?.type === "string" ? asStr(v.string) : v?.type ? asStr(v[v.type]) : null;
    case "formula_number":
      return v?.type === "number" ? asNum(v.number) : null;
    case "formula_boolean":
      return v?.type === "boolean" ? asBool(v.boolean) : null;
    case "formula_date":
      return v?.type === "date" ? dateValue(v.date) : null;
    case "rollup_number":
      return v?.type === "number" ? asNum(v.number) : null;
    case "rollup_date":
      return v?.type === "date" ? dateValue(v.date) : null;
    case "rollup_array":
      return v?.type === "array" && Array.isArray(v.array) ? v.array.map((x: unknown) => propertyText(x) ?? "") : null;
    case "verification":
      return asStr(v?.state);
    case "json":
      return asJson(v);
  }
}

function dateText(d: unknown): string | null {
  const x = d as Json | null;
  if (!x || typeof x.start !== "string") return null;
  return x.end ? `${x.start} → ${x.end}` : x.start;
}

/** Any property value as readable text (page_properties, rollup arrays). NULL when empty. */
export function propertyText(prop: unknown): string | null {
  const p = prop as Json | null;
  if (!p || typeof p !== "object") return null;
  const v = p[p.type];
  switch (p.type) {
    case "title":
    case "rich_text":
      return plainOrNull(v);
    case "number":
      return asNum(v) === null ? null : String(v);
    case "checkbox":
      return typeof v === "boolean" ? String(v) : null;
    case "select":
    case "status":
      return asStr(v?.name);
    case "multi_select":
      return Array.isArray(v) && v.length ? v.map((o: Json) => o?.name).join(", ") : null;
    case "date":
      return dateText(v);
    case "people":
      return Array.isArray(v) && v.length ? v.map((u: Json) => u?.name ?? u?.id).join(", ") : null;
    case "relation":
      return Array.isArray(v) && v.length ? v.map((r: Json) => r?.id).join(", ") : null;
    case "created_by":
    case "last_edited_by":
      return asStr(v?.name ?? v?.id);
    case "created_time":
    case "last_edited_time":
    case "url":
    case "email":
    case "phone_number":
      return asStr(v);
    case "files":
      return Array.isArray(v) && v.length ? v.map((f: Json) => f?.name ?? fileOf(f).url).join(", ") : null;
    case "unique_id":
      return v?.number == null ? null : v.prefix ? `${v.prefix}-${v.number}` : String(v.number);
    case "formula":
    case "rollup": {
      if (!v || typeof v !== "object") return null;
      const inner = v[v.type];
      if (v.type === "date") return dateText(inner);
      if (v.type === "array") {
        const parts = Array.isArray(inner) ? inner.map(propertyText).filter((x) => x !== null) : [];
        return parts.length ? parts.join(", ") : null;
      }
      return inner == null ? null : String(inner);
    }
    case "verification":
      return asStr(v?.state);
    case "button":
      return null;
    default:
      return v == null ? null : typeof v === "string" ? v : JSON.stringify(v);
  }
}

/** The title of a page: the plain text of its `title`-typed property. */
export function pageTitle(page: Json): string | null {
  for (const p of Object.values((page?.properties ?? {}) as Record<string, Json>)) {
    if (p?.type === "title") return plainText(p.title);
  }
  return null;
}

/** Options of a select / multi_select / status property (status also names its group). */
export function optionsOf(
  def: PropertyDef,
): { id: string | null; name: string | null; color: string | null; group: string | null }[] | null {
  if (!["select", "multi_select", "status"].includes(def.type)) return null;
  const groups = Array.isArray(def.config.groups) ? (def.config.groups as Json[]) : [];
  const groupOf = (id: unknown) =>
    asStr(groups.find((g) => Array.isArray(g.option_ids) && g.option_ids.includes(id))?.name);
  return (Array.isArray(def.config.options) ? (def.config.options as Json[]) : []).map((o) => ({
    id: asStr(o.id),
    name: asStr(o.name),
    color: asStr(o.color),
    group: def.type === "status" ? groupOf(o.id) : null,
  }));
}

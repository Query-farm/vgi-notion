/**
 * One factory for the worker's table functions and catalog tables.
 *
 * A spec names its columns (each with a JSON extractor), its state and a `next` step
 * that makes one upstream request and returns that page's rows. The factory turns it
 * into a VGI table function that:
 *
 * - streams one upstream page per Arrow batch (empty pages are skipped, not emitted);
 * - keeps its cursor in serializable state, so a scan resumes on any process over
 *   HTTP and survives rate-limit pauses;
 * - reads the `notion` secret on every call and never stores it in state;
 * - pushes filters down where a spec translates them, and lets the SDK re-apply every
 *   pushed predicate exactly (`autoApplyFilters`).
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  int32,
  int64,
  list,
  type PushdownFilters,
  schema,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, type NotionConfig, SECRET_TYPE } from "./client.ts";
import { asBig, asBool, asInt, asJson, asNum, asStr, asTime, type Json } from "./values.ts";

// ------------------------------------------------------------------ column helpers

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Json) => unknown;
}

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Json)[p];
  }
  return cur;
}

type Getter = string | ((r: Json) => unknown);
const pick = (r: Json, g: Getter) => (typeof g === "string" ? at(r, g) : g(r));

function mk(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Json) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, get, nullable };
}

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true) =>
    mk(name, utf8(), "VARCHAR", doc, (r) => asStr(pick(r, g)), nullable),
  time: (name: string, doc: string, g: Getter) =>
    mk(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(pick(r, g))),
  bool: (name: string, doc: string, g: Getter, nullable = true) =>
    mk(name, bool, "BOOLEAN", doc, (r) => asBool(pick(r, g)), nullable),
  big: (name: string, doc: string, g: Getter) => mk(name, int64(), "BIGINT", doc, (r) => asBig(pick(r, g))),
  int: (name: string, doc: string, g: Getter, nullable = true) =>
    mk(name, int32, "INTEGER", doc, (r) => asInt(pick(r, g)), nullable),
  num: (name: string, doc: string, g: Getter) => mk(name, float64(), "DOUBLE", doc, (r) => asNum(pick(r, g))),
  strList: (name: string, doc: string, g: Getter) =>
    mk(name, list(utf8()), "VARCHAR[]", doc, (r) => {
      const v = pick(r, g);
      return Array.isArray(v) ? v.map(asStr).filter((x): x is string => x !== null) : null;
    }),
  json: (name: string, doc: string, g: Getter) => mk(name, utf8(), "JSON", doc, (r) => asJson(pick(r, g))),
  /** A pre-computed value (struct / list of struct); `type`/`sqlType` given explicitly. */
  any: (name: string, type: VgiDataType, sqlType: string, doc: string, g: Getter) =>
    mk(name, type, sqlType, doc, (r) => pick(r, g) ?? null),
};

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

/** The Arrow output schema for columns (comments ride along as field metadata). */
export function schemaOf(columns: Col[]): VgiSchema {
  return schema(
    columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

/** Columns referenced anywhere in the pushed filters (including under OR/NOT). */
export function filterColumns(filters: unknown): string[] {
  const out: string[] = [];
  const walk = (e: unknown) => {
    if (!e || typeof e !== "object") return;
    const n = e as Json;
    if (n.node === "column_ref" && typeof n.columnName === "string") out.push(n.columnName);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(filters);
  return out;
}

/** Columns a scan must fill: the projection plus every column a pushed filter reads. */
export function neededColumns(outputSchema: VgiSchema, filters: PushdownFilters | undefined): Set<string> {
  const s = new Set(outputSchema.fields.map((f) => f.name));
  for (const c of filterColumns(filters?.filters)) s.add(c);
  return s;
}

/**
 * Build one batch over the FULL bound schema (filter columns included, so the SDK's
 * exact re-filter sees them); the SDK projects it down afterwards. Columns that are
 * neither projected nor filtered are left NULL without being computed.
 */
export function rowsBatch(
  fullSchema: VgiSchema,
  getters: Map<string, (r: Json) => unknown>,
  rows: Json[],
  needed: Set<string>,
) {
  const cols: Record<string, unknown[]> = {};
  for (const f of fullSchema.fields) {
    const g = getters.get(f.name);
    cols[f.name] = g && needed.has(f.name) ? rows.map((r) => g(r)) : rows.map(() => null);
  }
  return batchFromColumns(cols, fullSchema);
}

// --------------------------------------------------------------------- the factory

export interface FnExample {
  sql: string;
  description: string;
}

export interface ScanContext<A> {
  args: A;
  cfg: NotionConfig;
  filters: PushdownFilters | undefined;
  needed: Set<string>;
}

/** One step: the rows of one upstream page; set `done` when the scan is complete. */
export interface Step {
  rows: Json[];
  done: boolean;
}

export interface TableSpec<A, S> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  initialState: () => S;
  /** Make one request, advance `state`, return its rows. */
  next: (scan: ScanContext<A>, state: S) => Promise<Step>;
  pushdown?: string;
  examples: FnExample[];
  /** Column attested NOT NULL + PRIMARY KEY when exposed as a catalog table. */
  primaryKey?: string;
}

export function tagsOf(spec: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  pushdown?: string;
  columns?: Col[];
  resultColumns?: { name: string; type: string; description: string }[];
}): Record<string, string> {
  return {
    domain: "knowledge management",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.resultColumns ?? (spec.columns ?? []).map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

export interface ScanStateBase {
  done: boolean;
}

export function defineNotionTable<A extends Record<string, unknown>, S extends ScanStateBase>(
  spec: TableSpec<A, S>,
): VgiFunction {
  const outSchema = schemaOf(spec.columns);
  const getters = new Map(spec.columns.map((c) => [c.name, c.get]));
  return defineTableFunction<A, S>({
    name: spec.name,
    description: spec.description,
    args: spec.args ?? {},
    argDocs: spec.argDocs,
    argDefaults: spec.argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    projectionPushdown: true,
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => spec.initialState(),
    process: async (params, state, out) => {
      if (state.done) {
        out.finish();
        return;
      }
      const cfg = configFromSecrets(params.secrets);
      const needed = neededColumns(params.outputSchema, params.pushdownFilters);
      const scan: ScanContext<A> = { args: params.args, cfg, filters: params.pushdownFilters, needed };
      const full = params.initCall.output_schema;
      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        const step = await spec.next(scan, state);
        if (step.done) state.done = true;
        if (step.rows.length > 0) {
          out.emit(rowsBatch(full, getters, step.rows, needed) as never);
          return;
        }
        if (state.done) {
          out.finish();
          return;
        }
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}

/** A spec with no arguments exposed as a catalog table (`SELECT … FROM notion.main.users`). */
export function defineCatalogTable<S extends ScanStateBase>(
  spec: TableSpec<Record<string, never>, S>,
  schemaName: string,
): TableDescriptor {
  const fn = defineNotionTable({ ...spec, name: `${spec.name}_scan` });
  const pk = spec.primaryKey;
  const record = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY") =>
    constraintRecord({
      schemaPath: [schemaName],
      table: spec.name,
      id,
      kind,
      columns: [[pk as string]],
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  return {
    name: spec.name,
    comment: spec.description,
    columns: schemaOf(spec.columns),
    function: fn,
    constraints: pk ? [record(`${pk}_not_null`, "NOT_NULL"), record("pk", "PRIMARY_KEY")] : [],
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

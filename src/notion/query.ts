/**
 * `query_data_source(id)` / `query_database(id)`: the rows (pages) of a Notion data
 * source as a typed table whose columns are the data source's properties.
 *
 * - **Schema at bind.** The second bind pass (the one that receives the `notion`
 *   secret) fetches the data source schema and, when it has formulas, one sample row to
 *   learn each formula's result type. Each property column carries its Notion property
 *   id, type and value kind as field metadata, so `process` needs nothing else.
 * - **Pushdown.** WHERE predicates become a Notion filter object (see `filter.ts`), ANDed
 *   with an explicit `notion_filter`. Projection becomes `filter_properties`, so Notion
 *   returns only the properties the query reads. `notion_sorts` passes Notion sorts.
 * - **Paging.** The Notion `next_cursor` is the scan state; the request body is rebuilt
 *   from the arguments and pushed filters on every call, so a scan resumes anywhere.
 * - **Truncated properties.** A page object lists at most 25 relation / people
 *   references; when a needed value says `has_more`, the full list is read from the
 *   page property item endpoint.
 */

import { bool, defineTableFunction, field, schema, utf8, type VgiFunction, type VgiSchema } from "@query-farm/vgi";
import { column } from "../meta.ts";
import {
  asList,
  configFromSecrets,
  getAll,
  type NotionConfig,
  NotionError,
  notionRequest,
  SECRET_TYPE,
} from "./client.ts";
import { resolveDataSource, sampleFormulaTypes } from "./datasource.ts";
import { combineFilters, type FilterColumn, FilterTranslator, type NotionFilter } from "./filter.ts";
import { normalizeId } from "./ids.ts";
import {
  columnFromField,
  extractValue,
  PAGE_META,
  propertyColumns,
  propertyDefs,
  propertyField,
  type ValueKind,
} from "./properties.ts";
import { type FnExample, neededColumns, rowsBatch, tagsOf } from "./table.ts";
import { asBool, asStr, asTime, type Json, userId } from "./values.ts";

export const PAGE_SIZE = 100;

interface QueryArgs {
  data_source_id?: string;
  database_id?: string;
  notion_filter: string | null;
  notion_sorts: string | null;
  rich_text_json: boolean;
}

interface QueryState {
  cursor: string;
  done: boolean;
}

const ID_META = "notion_data_source_id";

function idField(dataSourceId: string) {
  return field(
    "id",
    utf8(),
    false,
    new Map([
      ["comment", "Page id of the row (dashed UUID)."],
      [ID_META, dataSourceId],
    ]),
  );
}

function metaFields() {
  return PAGE_META.map((m) => column(m.name, m.type(), m.doc));
}

/** The schema before the secret is known (first bind pass). */
const PLACEHOLDER: VgiSchema = schema([idField(""), ...metaFields()]);

/** Bound schema for a data source: id, its properties, then the page metadata columns. */
export async function boundSchema(
  cfg: NotionConfig,
  rawId: string,
  richJson: boolean,
  what: string,
): Promise<VgiSchema> {
  const ds = await resolveDataSource(cfg, rawId, what);
  const formulaTypes = await sampleFormulaTypes(cfg, ds);
  const cols = propertyColumns(propertyDefs(ds), formulaTypes, richJson);
  return schema([idField(String(ds.id)), ...cols.map(propertyField), ...metaFields()]);
}

function parseJsonArg(raw: string | null, name: string, kind: "object" | "array"): Json | Json[] | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    throw new NotionError(`${name} is not valid JSON: ${(err as Error).message}`);
  }
  const ok = kind === "array" ? Array.isArray(v) : v !== null && typeof v === "object" && !Array.isArray(v);
  if (!ok) throw new NotionError(`${name} must be a JSON ${kind}`);
  return v as Json;
}

/** Re-encode a property id for a query string (Notion ids may already be percent-encoded). */
function encodePropertyId(id: string): string {
  let decoded = id;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    // not percent-encoded
  }
  return encodeURIComponent(decoded);
}

interface BoundColumn {
  name: string;
  propertyId: string;
  type: string;
  kind: ValueKind;
}

function boundColumns(full: VgiSchema): { dataSourceId: string; props: BoundColumn[] } {
  const idf = full.fields.find((f) => f.name === "id");
  const dataSourceId = idf?.metadata?.get(ID_META) ?? "";
  const props: BoundColumn[] = [];
  for (const f of full.fields) {
    const c = columnFromField(f);
    if (c) props.push({ name: f.name, ...c });
  }
  return { dataSourceId, props };
}

/** Columns the filter translator knows about. */
export function filterColumnMap(props: BoundColumn[]): Map<string, FilterColumn> {
  const m = new Map<string, FilterColumn>();
  for (const p of props) {
    if (p.kind === "rich_json") continue;
    m.set(p.name, { kind: "property", propertyId: p.propertyId, type: p.type, valueKind: p.kind });
  }
  m.set("created_time", { kind: "timestamp", timestamp: "created_time" });
  m.set("last_edited_time", { kind: "timestamp", timestamp: "last_edited_time" });
  return m;
}

/** Read a truncated relation / people property in full from the property item endpoint. */
async function fullListProperty(cfg: NotionConfig, pageId: string, prop: Json): Promise<Json> {
  const items = await getAll<Json>(cfg, `/v1/pages/${pageId}/properties/${encodePropertyId(String(prop.id))}`);
  const t = String(prop.type);
  return { ...prop, has_more: false, [t]: items.map((i) => i[t]).filter((x) => x != null) };
}

/** Request body + path for one page of a scan. */
export function buildQuery(
  dataSourceId: string,
  props: BoundColumn[],
  needed: Set<string>,
  filter: NotionFilter | undefined,
  sorts: Json[] | undefined,
  cursor: string,
): { path: string; body: Json } {
  const ids = [...new Set(props.filter((p) => needed.has(p.name)).map((p) => p.propertyId))];
  // Ask for at least one property (the title) so a count(*) does not download them all.
  const title = props.find((p) => p.type === "title");
  if (ids.length === 0 && title) ids.push(title.propertyId);
  const qs = ids.map((id) => `filter_properties=${encodePropertyId(id)}`).join("&");
  const body: Json = { page_size: PAGE_SIZE };
  if (cursor) body.start_cursor = cursor;
  if (filter) body.filter = filter;
  if (sorts && sorts.length > 0) body.sorts = sorts;
  return { path: `/v1/data_sources/${dataSourceId}/query${qs ? `?${qs}` : ""}`, body };
}

function makeQueryFunction(opts: {
  name: string;
  idArg: "data_source_id" | "database_id";
  description: string;
  title: string;
  keywords: string;
  docLlm: string;
  docMd: string;
  examples: FnExample[];
}): VgiFunction {
  return defineTableFunction<QueryArgs, QueryState>({
    name: opts.name,
    description: opts.description,
    args: { [opts.idArg]: utf8(), notion_filter: utf8(), notion_sorts: utf8(), rich_text_json: bool },
    argDefaults: { notion_filter: null, notion_sorts: null, rich_text_json: true },
    argDocs: {
      [opts.idArg]:
        opts.idArg === "data_source_id"
          ? "Data source id or URL (a database id also works when the database has one data source)."
          : "Database id or notion.so URL; the database must hold exactly one data source.",
      notion_filter:
        "Optional Notion filter object as JSON (ANDed with the WHERE clause), e.g. " +
        '\'{"property":"Status","status":{"equals":"Done"}}\'.',
      notion_sorts:
        'Optional Notion sorts array as JSON, e.g. \'[{"property":"Due","direction":"descending"}]\' ' +
        "(Notion orders the rows; add ORDER BY in SQL to guarantee an order).",
      rich_text_json: "Add a `<property>__json` JSON column with the raw rich text of each title / rich_text property.",
    },
    filterPushdown: true,
    projectionPushdown: true,
    autoApplyFilters: true,
    onBind: async (params) => {
      if (!params.resolvedSecretsProvided) return { outputSchema: PLACEHOLDER, lookupSecretTypes: [SECRET_TYPE] };
      const cfg = configFromSecrets(params.secrets);
      const raw = String(params.args[opts.idArg] ?? "");
      if (opts.idArg === "database_id") normalizeId(raw, "database_id");
      return { outputSchema: await boundSchema(cfg, raw, params.args.rich_text_json !== false, opts.idArg) };
    },
    initialState: () => ({ cursor: "", done: false }),
    process: async (params, state, out) => {
      if (state.done) {
        out.finish();
        return;
      }
      const cfg = configFromSecrets(params.secrets);
      const full = params.initCall.output_schema;
      const { dataSourceId, props } = boundColumns(full);
      if (!dataSourceId) throw new NotionError(`${opts.name}: the bound schema has no data source id`);
      const needed = neededColumns(params.outputSchema, params.pushdownFilters);
      const pushed = new FilterTranslator(filterColumnMap(props)).fromPushdown(params.pushdownFilters);
      const user = parseJsonArg(params.args.notion_filter, "notion_filter", "object") as Json | undefined;
      const sorts = parseJsonArg(params.args.notion_sorts, "notion_sorts", "array") as Json[] | undefined;
      const filter = combineFilters(user, pushed);

      const byName = new Map(props.map((p) => [p.name, p]));
      const getters = new Map<string, (r: Json) => unknown>([
        ["id", (r) => asStr(r.id)],
        ["url", (r) => asStr(r.url)],
        ["created_time", (r) => asTime(r.created_time)],
        ["last_edited_time", (r) => asTime(r.last_edited_time)],
        ["created_by", (r) => userId(r.created_by)],
        ["last_edited_by", (r) => userId(r.last_edited_by)],
        ["in_trash", (r) => asBool(r.in_trash ?? r.archived)],
      ]);
      for (const [name, p] of byName) getters.set(name, (r) => extractValue(r.__props?.[p.propertyId], p.kind));

      for (;;) {
        const { path, body } = buildQuery(dataSourceId, props, needed, filter, sorts, state.cursor);
        const page = asList<Json>(await notionRequest(cfg, path, { body }));
        if (page.request_status?.type === "incomplete") {
          throw new NotionError(
            `Notion stopped this query at its result limit (${page.request_status.incomplete_reason ?? "incomplete"}); ` +
              "narrow it with a WHERE clause (e.g. on created_time) or notion_filter",
          );
        }
        state.cursor = page.has_more && page.next_cursor ? page.next_cursor : "";
        if (!state.cursor) state.done = true;
        const rows: Json[] = [];
        for (const pg of page.results) {
          const pmap: Record<string, Json> = {};
          for (const prop of Object.values((pg.properties ?? {}) as Record<string, Json>)) {
            if (prop && typeof prop.id === "string") pmap[prop.id] = prop;
          }
          for (const p of props) {
            const prop = pmap[p.propertyId];
            if (prop?.has_more === true && p.kind === "ids" && needed.has(p.name)) {
              pmap[p.propertyId] = await fullListProperty(cfg, String(pg.id), prop);
            }
          }
          rows.push({ ...pg, __props: pmap });
        }
        if (rows.length > 0) {
          out.emit(rowsBatch(full, getters, rows, needed) as never);
          return;
        }
        if (state.done) {
          out.finish();
          return;
        }
      }
    },
    tags: tagsOf({
      title: opts.title,
      category: "databases",
      keywords: opts.keywords,
      docLlm: opts.docLlm,
      docMd: opts.docMd,
      resultColumns: [
        { name: "id", type: "VARCHAR", description: "Page id of the row." },
        {
          name: "<property>",
          type: "per property type",
          description:
            "One column per data source property, named verbatim (see data_source_schema for each column's name and type).",
        },
        ...PAGE_META.map((m) => ({ name: m.name, type: m.sql, description: m.doc })),
      ],
    }),
    examples: opts.examples,
  });
}

const QUERY_DOC_LLM =
  "Rows (pages) of a Notion data source as a typed table: one column per property, named exactly as in " +
  'Notion (quote names with spaces or capitals: "Status", "Due date"), plus id, url, created_time, ' +
  "last_edited_time, created_by, last_edited_by and in_trash. Types: title/rich_text VARCHAR plain text " +
  '(+ "<name>__json" raw rich text JSON), number DOUBLE, checkbox BOOLEAN, select/status VARCHAR, ' +
  "multi_select VARCHAR[], people/relation VARCHAR[] of ids (join users / other queries), date " +
  'STRUCT(start, end TIMESTAMPTZ, time_zone, has_time) — filter with "Due".start, created/last_edited ' +
  "time TIMESTAMPTZ, files LIST(STRUCT(name,type,url,expiry_time)), unique_id BIGINT, formula/rollup by " +
  "result type. Call data_source_schema(id) first to see the exact column names and types. WHERE on " +
  "properties pushes down into Notion's filter (equality, ranges, IN, LIKE prefix/contains, list_contains, " +
  "IS NULL, AND/OR); only the columns you select are downloaded. Ids may be given as notion.so URLs.";

const QUERY_DOC_MD =
  "Each row is a page of the data source; each property becomes a typed column. " +
  "`data_source_schema(id)` lists the columns. Pushdown: WHERE → Notion filter object (`and`/`or`, " +
  "property conditions by type, `created_time`/`last_edited_time` timestamp filters), projection → " +
  "`filter_properties`, `notion_sorts` → Notion sorts. Rows stream one 100-row page per batch with the " +
  "Notion cursor kept as scan state.";

export const queryDataSource = makeQueryFunction({
  name: "query_data_source",
  idArg: "data_source_id",
  description: "Rows of a Notion data source as a typed table, one column per property",
  title: "Query a Notion Data Source",
  keywords: "notion, database, data source, query, rows, pages, properties, filter, typed columns",
  docLlm: QUERY_DOC_LLM,
  docMd:
    "## query_data_source(data_source_id, notion_filter := NULL, notion_sorts := NULL, rich_text_json := true)\n\n" +
    QUERY_DOC_MD,
  examples: [
    {
      sql:
        'SELECT "Name", "Status", "Due".start AS due FROM notion.main.query_data_source(\'1a2b3c4d-0000-4000-8000-00000000d501\') ' +
        "WHERE \"Status\" <> 'Done' AND \"Due\".start >= TIMESTAMPTZ '2026-11-01 00:00:00+00' ORDER BY due",
      description: "Open tasks due from November on, with the status and date filters pushed into Notion",
    },
    {
      sql:
        'SELECT "Status", count(*) AS tasks, sum("Estimate") AS points FROM notion.main.query_data_source(\'1a2b3c4d-0000-4000-8000-00000000d501\') ' +
        'GROUP BY "Status" ORDER BY tasks DESC',
      description: "Task count and estimate total per status",
    },
  ],
});

export const queryDatabase = makeQueryFunction({
  name: "query_database",
  idArg: "database_id",
  description: "Rows of a single-source Notion database (the database id from its URL) as a typed table",
  title: "Query a Notion Database",
  keywords: "notion, database, query, rows, pages, properties, filter, typed columns, url",
  docLlm:
    "Same as query_data_source, but takes a database id or the database's notion.so URL (what users copy " +
    "from the browser) and queries its only data source. A database with several data sources is an error " +
    "that lists them: use query_data_source with one of their ids. " +
    QUERY_DOC_LLM,
  docMd:
    "## query_database(database_id, notion_filter := NULL, notion_sorts := NULL, rich_text_json := true)\n\n" +
    "The rows of a database that has one data source (most do). " +
    QUERY_DOC_MD,
  examples: [
    {
      sql:
        'SELECT "Name", "Tags" FROM notion.main.query_database(\'https://www.notion.so/acme/Tasks-1a2b3c4d00004000800000000000d001\') ' +
        'WHERE list_contains("Tags", \'search\') ORDER BY "Name"',
      description: "Tasks tagged 'search', addressing the database by its URL",
    },
  ],
});

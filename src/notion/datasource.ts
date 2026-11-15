/**
 * Data source lookup: resolve an id (a data source, or a database holding exactly one
 * data source) to its schema, with a short per-process cache so the two bind passes and
 * the first scan of one query do not refetch it.
 */

import type { PushdownFilters } from "@query-farm/vgi";
import { asList, type NotionConfig, NotionError, notionRequest } from "./client.ts";
import { normalizeId } from "./ids.ts";
import { propertyDefs } from "./properties.ts";
import { plainText } from "./richtext.ts";
import type { Json } from "./values.ts";

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Json }>();

export function clearDataSourceCache(): void {
  cache.clear();
}

/** GET a data source; a database id resolves to its only data source. */
export async function resolveDataSource(cfg: NotionConfig, rawId: string, what = "data_source_id"): Promise<Json> {
  const id = normalizeId(rawId, what);
  const key = `${cfg.bucketKey} ${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let ds: Json;
  try {
    ds = (await notionRequest(cfg, `/v1/data_sources/${id}`)) as Json;
  } catch (err) {
    if (!(err instanceof NotionError) || (err.status !== 404 && err.status !== 400)) throw err;
    // Not a data source: maybe a database (the container) id.
    let db: Json;
    try {
      db = (await notionRequest(cfg, `/v1/databases/${id}`)) as Json;
    } catch (dbErr) {
      if (dbErr instanceof NotionError && (dbErr.status === 404 || dbErr.status === 400)) throw err;
      throw dbErr;
    }
    const sources = (Array.isArray(db.data_sources) ? db.data_sources : []) as Json[];
    if (sources.length !== 1) {
      const names = sources.map((s) => `${s.name ?? "?"} (${s.id})`).join(", ");
      throw new NotionError(
        `database ${id} has ${sources.length} data sources${names ? `: ${names}` : ""}; ` +
          "pass one data source id to query_data_source()",
      );
    }
    ds = (await notionRequest(cfg, `/v1/data_sources/${(sources[0] as Json).id}`)) as Json;
  }
  cache.set(key, { at: Date.now(), value: ds });
  return ds;
}

/**
 * The result type of each formula property, read from one sample row (the schema does
 * not say; Notion formulas have one result type). Formulas with no sample are VARCHAR.
 */
export async function sampleFormulaTypes(cfg: NotionConfig, ds: Json): Promise<Record<string, string>> {
  const formulas = propertyDefs(ds).filter((d) => d.type === "formula");
  if (formulas.length === 0) return {};
  const key = `${cfg.bucketKey} formulas ${ds.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Record<string, string>;
  const page = asList(
    await notionRequest(cfg, `/v1/data_sources/${ds.id}/query`, {
      query: { filter_properties: formulas.map((f) => f.id) },
      body: { page_size: 1 },
    }),
  );
  const out: Record<string, string> = {};
  const sample = page.results[0] as Json | undefined;
  for (const p of Object.values((sample?.properties ?? {}) as Record<string, Json>)) {
    if (p?.type === "formula" && typeof p.formula?.type === "string") out[String(p.id)] = p.formula.type;
  }
  cache.set(key, { at: Date.now(), value: out });
  return out;
}

export const dataSourceTitle = (ds: Json) => plainText(ds?.title);

/** Equality / IN string values pushed for a column at the top level, or undefined. */
export function eqValues(filters: PushdownFilters | undefined, column: string): string[] | undefined {
  let set: string[] | undefined;
  const narrow = (vs: string[]) => {
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  };
  for (const raw of filters?.filters ?? []) {
    const e = raw.node === "cast" ? raw.expression : raw;
    if (e.node === "comparison" && e.op === "eq") {
      const [l, r] = [e.left.node === "cast" ? e.left.expression : e.left, e.right];
      if (l.node === "column_ref" && l.columnName === column && r.node === "literal" && typeof r.value === "string") {
        narrow([r.value]);
      }
    } else if (e.node === "in" && !e.negated && e.set.kind === "literal") {
      const c = e.expression.node === "cast" ? e.expression.expression : e.expression;
      if (c.node === "column_ref" && c.columnName === column && e.set.values.every((v) => typeof v === "string")) {
        narrow(e.set.values as string[]);
      }
    }
  }
  return set;
}

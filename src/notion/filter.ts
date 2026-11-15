/**
 * SQL WHERE → a Notion data source filter object.
 *
 * Every scan sets `autoApplyFilters: true`, so the SDK re-applies the exact SQL
 * predicate to each batch. A translation therefore only has to NARROW what Notion
 * returns without ever dropping a row the SQL keeps:
 *
 * - AND: the translatable children are sent, the rest are left to the SDK.
 * - OR: sent only when every branch translates (otherwise dropping a branch would drop rows).
 * - Notion nests compound filters at most two levels deep; deeper ANDs are narrowed to
 *   one translatable child, deeper ORs are not sent.
 * - Comparisons Notion evaluates more loosely (case-insensitive text, date-granular
 *   timestamps in the workspace time zone) are widened or left loose: the SDK tightens
 *   them again. Upper bounds on a date range's start are never sent, because Notion's
 *   handling of a range's end is not documented.
 */

import type { PushdownFilters } from "@query-farm/vgi";
import type { ValueKind } from "./properties.ts";
import type { Json } from "./values.ts";

type Expr = PushdownFilters["filters"][number];

/** What a scan column is, as far as filtering goes. */
export type FilterColumn =
  | { kind: "property"; propertyId: string; type: string; valueKind: ValueKind }
  | { kind: "timestamp"; timestamp: "created_time" | "last_edited_time" };

export type NotionFilter = Json;

/** Max nesting of compound filters Notion accepts. */
export const MAX_DEPTH = 2;
/** Widening for date-granular comparisons: the largest UTC offset plus margin. */
export const DATE_SLACK_MS = 26 * 3600 * 1000;
const MAX_IN = 100;

type Op = "eq" | "ne" | "gt" | "ge" | "lt" | "le";
const FLIP: Record<Op, Op> = { eq: "eq", ne: "ne", gt: "lt", ge: "le", lt: "gt", le: "ge" };
const NUM_OPS: Record<Op, string> = {
  eq: "equals",
  ne: "does_not_equal",
  gt: "greater_than",
  ge: "greater_than_or_equal_to",
  lt: "less_than",
  le: "less_than_or_equal_to",
};

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

/** A pushed instant (TIMESTAMPTZ µs bigint, Date, ISO string) as epoch ms. */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v / 1000n);
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint" && v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER))
    return Number(v);
  return undefined;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A reference to a column, optionally through a struct field (`"Due".start`). */
interface Ref {
  name: string;
  field?: string;
}

function refOf(e: Expr): Ref | null {
  const x = unwrap(e);
  if (x.node === "column_ref") return { name: x.columnName };
  if (x.node === "field_ref") {
    const inner = unwrap(x.expression);
    if (inner.node === "column_ref") return { name: inner.columnName, field: x.fieldName };
  }
  return null;
}

function literal(e: Expr): { value: unknown } | null {
  const x = unwrap(e);
  return x.node === "literal" && x.value != null ? { value: x.value } : null;
}

const DATE_KINDS = new Set<ValueKind>(["date"]);
const TEXT_TYPES = new Set(["title", "rich_text", "url", "email", "phone_number"]);

export class FilterTranslator {
  constructor(private readonly columns: Map<string, FilterColumn>) {}

  private col(ref: Ref | null): FilterColumn | undefined {
    return ref ? this.columns.get(ref.name) : undefined;
  }

  /** Wrap a condition for a column: property filters name the property by id. */
  private cond(c: FilterColumn, key: string, condition: Json): NotionFilter {
    if (c.kind === "timestamp") return { timestamp: c.timestamp, [c.timestamp]: condition };
    return { property: c.propertyId, [key]: condition };
  }

  /** A date-granular range condition (widened), or null. */
  private timeRange(c: FilterColumn, key: string, op: Op, v: unknown, levels: number): NotionFilter | null {
    const ms = toEpochMs(v);
    if (ms === undefined) return null;
    const lower = this.cond(c, key, { on_or_after: iso(ms - DATE_SLACK_MS) });
    const upper = this.cond(c, key, { on_or_before: iso(ms + DATE_SLACK_MS) });
    if (op === "gt" || op === "ge") return lower;
    if (op === "lt" || op === "le") return upper;
    if (op === "eq") return levels > 0 ? { and: [lower, upper] } : lower;
    return null;
  }

  /** `column op literal` for one column. */
  private compare(ref: Ref, op: Op, v: unknown, levels: number): NotionFilter | null {
    const c = this.col(ref);
    if (!c) return null;
    if (c.kind === "timestamp") return ref.field ? null : this.timeRange(c, c.timestamp, op, v, levels);
    const t = c.type;
    switch (c.valueKind) {
      case "text":
      case "string":
        if (ref.field || op !== "eq" || typeof v !== "string" || v === "" || !TEXT_TYPES.has(t)) return null;
        return this.cond(c, t, { equals: v });
      case "number":
      case "unique_id": {
        const n = toNumber(v);
        return ref.field || n === undefined ? null : this.cond(c, t, { [NUM_OPS[op]]: n });
      }
      case "checkbox":
        if (ref.field || typeof v !== "boolean" || (op !== "eq" && op !== "ne")) return null;
        return this.cond(c, "checkbox", { equals: op === "eq" ? v : !v });
      case "option":
        if (ref.field || op !== "eq" || typeof v !== "string") return null;
        return this.cond(c, t, { equals: v });
      case "user":
        if (ref.field || op !== "eq" || typeof v !== "string") return null;
        return this.cond(c, t, { contains: v });
      case "time":
        return ref.field ? null : this.timeRange(c, t, op, v, levels);
      case "date":
        // Only a lower bound on the start of the date: see the module comment.
        if (ref.field !== "start" || (op !== "gt" && op !== "ge" && op !== "eq")) return null;
        return this.timeRange(c, "date", "ge", v, levels);
      case "formula_number": {
        const n = toNumber(v);
        return ref.field || n === undefined ? null : this.cond(c, "formula", { number: { [NUM_OPS[op]]: n } });
      }
      case "formula_boolean":
        if (ref.field || typeof v !== "boolean" || (op !== "eq" && op !== "ne")) return null;
        return this.cond(c, "formula", { checkbox: { equals: op === "eq" ? v : !v } });
      case "formula_string":
        if (ref.field || op !== "eq" || typeof v !== "string" || v === "") return null;
        return this.cond(c, "formula", { string: { equals: v } });
      default:
        return null;
    }
  }

  private isNull(ref: Ref | null, negated: boolean): NotionFilter | null {
    const c = this.col(ref);
    if (c?.kind !== "property" || !ref || ref.field) return null;
    const cond = negated ? { is_not_empty: true } : { is_empty: true };
    const t = c.type;
    switch (c.valueKind) {
      case "text":
      case "string":
      case "number":
      case "option":
      case "unique_id":
        return this.cond(c, t, cond);
      case "date":
        return DATE_KINDS.has(c.valueKind) ? this.cond(c, "date", cond) : null;
      default:
        return null;
    }
  }

  private call(fn: string, args: Expr[]): NotionFilter | null {
    if (args.length !== 2) return null;
    const ref = refOf(args[0] as Expr);
    const lit = literal(args[1] as Expr);
    const c = this.col(ref);
    if (!ref || ref.field || !lit || !c || c.kind !== "property" || typeof lit.value !== "string") return null;
    const v = lit.value;
    if (fn === "list_contains" || fn === "list_has" || fn === "array_contains" || fn === "array_has") {
      if (c.valueKind === "options" || c.valueKind === "ids") return this.cond(c, c.type, { contains: v });
      return null;
    }
    if (c.valueKind === "text" || c.valueKind === "string") {
      if (v === "" || !TEXT_TYPES.has(c.type)) return null;
      if (fn === "starts_with" || fn === "prefix") return this.cond(c, c.type, { starts_with: v });
      if (fn === "ends_with" || fn === "suffix") return this.cond(c, c.type, { ends_with: v });
      if (fn === "contains") return this.cond(c, c.type, { contains: v });
    }
    if (c.valueKind === "formula_string" && fn === "contains" && v !== "") {
      return this.cond(c, "formula", { string: { contains: v } });
    }
    return null;
  }

  /** Translate one expression with `levels` compound levels still available. */
  translate(e: Expr, levels: number): NotionFilter | null {
    const x = unwrap(e);
    switch (x.node) {
      case "and": {
        const kids = x.children
          .map((c) => this.translate(c, Math.max(0, levels - 1)))
          .filter(Boolean) as NotionFilter[];
        if (kids.length === 0) return null;
        if (kids.length === 1 || levels === 0) {
          // Without a compound level left, any one conjunct still narrows correctly.
          const simple = kids.find((k) => !("and" in k) && !("or" in k));
          return kids.length === 1 ? (kids[0] as NotionFilter) : (simple ?? null);
        }
        return { and: kids.flatMap((k) => ("and" in k ? (k.and as NotionFilter[]) : [k])) };
      }
      case "or": {
        if (levels === 0) return null;
        const kids = x.children.map((c) => this.translate(c, levels - 1));
        if (kids.some((k) => k === null)) return null;
        return {
          or: kids.flatMap((k) => ("or" in (k as NotionFilter) ? ((k as NotionFilter).or as NotionFilter[]) : [k])),
        };
      }
      case "column_ref":
        return this.compare({ name: x.columnName }, "eq", true, levels);
      case "not": {
        const inner = unwrap(x.expression);
        if (inner.node === "column_ref") return this.compare({ name: inner.columnName }, "eq", false, levels);
        if (inner.node === "is_null") return this.isNull(refOf(inner.expression), !inner.negated);
        return null;
      }
      case "is_null":
        return this.isNull(refOf(x.expression), x.negated);
      case "comparison": {
        if (!(x.op in FLIP)) return null;
        const op = x.op as Op;
        const [lr, rl] = [refOf(x.left), literal(x.right)];
        if (lr && rl) return this.compare(lr, op, rl.value, levels);
        const [rr, ll] = [refOf(x.right), literal(x.left)];
        if (rr && ll) return this.compare(rr, FLIP[op], ll.value, levels);
        return null;
      }
      case "in": {
        if (x.negated || x.set.kind !== "literal") return null;
        const ref = refOf(x.expression);
        const values = x.set.values;
        if (!ref || values.length === 0 || values.length > MAX_IN || values.some((v) => v == null)) return null;
        const kids = values.map((v) => this.compare(ref, "eq", v, 0));
        if (kids.some((k) => k === null)) return null;
        if (kids.length === 1) return kids[0] as NotionFilter;
        return levels === 0 ? null : { or: kids };
      }
      case "call": {
        const fn = typeof x.function === "string" ? x.function : x.function.name;
        return this.call(fn, x.arguments);
      }
      default:
        return null;
    }
  }

  /** The pushed filters (an implicit AND) as one Notion filter, or undefined. */
  fromPushdown(filters: PushdownFilters | undefined): NotionFilter | undefined {
    const list = filters?.filters ?? [];
    if (list.length === 0) return undefined;
    const top = list.length === 1 ? (list[0] as Expr) : ({ node: "and", children: list } as Expr);
    return this.translate(top, MAX_DEPTH) ?? undefined;
  }
}

/** Compound nesting depth of a Notion filter (a property condition is 0). */
export function depth(f: unknown): number {
  if (!f || typeof f !== "object") return 0;
  const x = f as Json;
  const kids = (Array.isArray(x.and) ? x.and : Array.isArray(x.or) ? x.or : null) as unknown[] | null;
  return kids ? 1 + Math.max(0, ...kids.map(depth)) : 0;
}

/**
 * AND a user-supplied Notion filter with the pushed one. When the combination would
 * nest deeper than Notion allows, the user's filter wins and the SDK applies the SQL
 * predicate on its own.
 */
export function combineFilters(
  user: NotionFilter | undefined,
  pushed: NotionFilter | undefined,
): NotionFilter | undefined {
  if (!user) return pushed;
  if (!pushed) return user;
  const parts = (f: NotionFilter) => (Array.isArray(f.and) ? (f.and as NotionFilter[]) : [f]);
  const combined = { and: [...parts(user), ...parts(pushed)] };
  return depth(combined) <= MAX_DEPTH ? combined : user;
}

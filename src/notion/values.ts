/** Conversions from untyped Notion JSON to the values Arrow columns expect. */

// biome-ignore lint/suspicious/noExplicitAny: Notion JSON is untyped.
export type Json = Record<string, any>;

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function asBig(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return null;
}

export function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/**
 * ISO 8601 → TIMESTAMPTZ microseconds. A date without a time (`2026-11-03`, an all-day
 * Notion date) is midnight UTC.
 */
export function asTime(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}

export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** A user reference (`{object: "user", id}`) → its id. */
export const userId = (v: unknown): string | null => asStr((v as Json | null)?.id);

/** Emoji, external URL or uploaded file icon → one display string. */
export function iconOf(icon: unknown): string | null {
  const i = icon as Json | null;
  if (!i || typeof i !== "object") return null;
  switch (i.type) {
    case "emoji":
      return asStr(i.emoji);
    case "external":
      return asStr(i.external?.url);
    case "file":
      return asStr(i.file?.url);
    case "custom_emoji":
      return asStr(i.custom_emoji?.url ?? i.custom_emoji?.name);
    case "icon":
      return asStr(i.icon?.name);
    default:
      return null;
  }
}

/** A file object (`{type: "file"|"external"|"file_upload", name?, file: {url, expiry_time}}`). */
export function fileOf(f: unknown): {
  name: string | null;
  type: string | null;
  url: string | null;
  expiry_time: bigint | null;
} {
  const x = (f ?? {}) as Json;
  const inner = (x[x.type] ?? {}) as Json;
  return {
    name: asStr(x.name),
    type: asStr(x.type),
    url: asStr(inner.url),
    expiry_time: asTime(inner.expiry_time),
  };
}

/** A parent object → `[type, id]` (workspace parents have no id). */
export function parentOf(p: unknown): [string | null, string | null] {
  const x = p as Json | null;
  if (!x || typeof x.type !== "string") return [null, null];
  const id = x[x.type];
  return [x.type, typeof id === "string" ? id : null];
}

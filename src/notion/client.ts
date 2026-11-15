/**
 * Notion REST client shared by every function.
 *
 * - **Auth.** One `notion` DuckDB secret carries a bearer token: an internal
 *   integration secret (`ntn_…` / `secret_…`) or a public integration's OAuth access
 *   token. Both are sent as `Authorization: Bearer`. The token is read from the secret
 *   on every call and never stored in table-function state.
 * - **Version.** Every request pins `Notion-Version` (default {@link NOTION_VERSION}),
 *   the data-source era API where a database is a container of data sources and rows
 *   are queried through `/v1/data_sources/{id}/query`.
 * - **Rate limits.** Notion allows an average of ~3 requests per second per
 *   integration. A client-side token bucket (per token + base URL, per process) keeps
 *   calls under that rate, and a 429 `rate_limited` answer is honoured with its
 *   `Retry-After` (seconds); 5xx and network errors back off exponentially.
 * - **Safety.** Requests only go to the configured base URL's origin; `http://` is
 *   accepted only for a loopback fixture server.
 */

import { createHash } from "node:crypto";
import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "notion";
export const NOTION_VERSION = "2026-03-11";
export const DEFAULT_BASE_URL = "https://api.notion.com";
export const DEFAULT_RPS = 3;
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 6;
/** Longest single wait for a 429's Retry-After. */
export const MAX_RATE_WAIT_MS = 60_000;
const USER_AGENT = `vgi-notion-worker/${VERSION}`;

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface NotionConfig {
  /** Base URL that `/v1/...` paths are appended to (no trailing slash). */
  baseUrl: string;
  token: string;
  notionVersion: string;
  /** Average requests per second the token bucket allows. */
  rps: number;
  /** Stable, non-secret key for per-token rate limiting. */
  bucketKey: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new NotionError(`notion secret: base_url '${raw}' is not a URL (expected e.g. https://api.notion.com)`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new NotionError(
      "notion secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `notion` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): NotionConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new NotionError(
      "no notion secret: run CREATE SECRET (TYPE notion, TOKEN 'ntn_…') with an internal integration secret " +
        "or OAUTH_ACCESS_TOKEN '…' for a public integration, and share the pages/databases with the integration",
    );
  }
  const token = str(s.token) ?? str(s.oauth_access_token);
  if (!token) throw new NotionError("notion secret: set TOKEN (integration secret) or OAUTH_ACCESS_TOKEN");
  const baseUrl = normalizeBaseUrl(str(s.base_url) ?? DEFAULT_BASE_URL);
  const notionVersion = str(s.notion_version) ?? NOTION_VERSION;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(notionVersion)) {
    throw new NotionError(`notion secret: notion_version must look like ${NOTION_VERSION}`);
  }
  let rps = DEFAULT_RPS;
  const rawRps = str(s.requests_per_second);
  if (rawRps !== undefined) {
    rps = Number(rawRps);
    if (!Number.isFinite(rps) || rps <= 0 || rps > 100) {
      throw new NotionError("notion secret: requests_per_second must be a number in (0, 100]");
    }
  }
  const bucketKey = `${baseUrl} ${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  return { baseUrl, token, notionVersion, rps, bucketKey };
}

// ------------------------------------------------------------------ rate limiting

interface Bucket {
  tokens: number;
  updated: number;
  /** Do not call before this instant (set by a 429). */
  pauseUntil: number;
}

const buckets = new Map<string, Bucket>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the token bucket for this integration allows one more request. */
export async function acquire(cfg: NotionConfig, now: () => number = Date.now): Promise<void> {
  const burst = Math.max(1, Math.ceil(cfg.rps));
  let b = buckets.get(cfg.bucketKey);
  if (!b) {
    b = { tokens: burst, updated: now(), pauseUntil: 0 };
    buckets.set(cfg.bucketKey, b);
  }
  for (;;) {
    const t = now();
    if (b.pauseUntil > t) {
      await sleep(b.pauseUntil - t);
      continue;
    }
    b.tokens = Math.min(burst, b.tokens + ((t - b.updated) / 1000) * cfg.rps);
    b.updated = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - b.tokens) / cfg.rps) * 1000));
  }
}

/** Forget rate-limit state (tests). */
export function resetBuckets(): void {
  buckets.clear();
}

/** How long a 429/503 asks us to wait: Retry-After in seconds or as an HTTP date. */
export function retryDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retry = headers.get("Retry-After");
  if (!retry) return undefined;
  if (/^\d+(\.\d+)?$/.test(retry.trim())) return Math.ceil(Number(retry) * 1000);
  const t = Date.parse(retry);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

// ------------------------------------------------------------------------ requests

export type Query = Record<string, string | string[] | undefined>;

/** Append query parameters (arrays repeat the key; undefined / "" are dropped). */
export function buildUrl(cfg: NotionConfig, path: string, query?: Query): URL {
  const u = new URL(`${cfg.baseUrl}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
    else if (v !== undefined && v !== "") u.searchParams.set(k, v);
  }
  return u;
}

/**
 * Call the Notion API and decode its JSON. `path` starts with `/v1/`. `body` makes it a
 * POST (search, data source queries), otherwise a GET.
 */
export async function notionRequest(
  cfg: NotionConfig,
  path: string,
  opts: { query?: Query; body?: unknown } = {},
): Promise<unknown> {
  const u = buildUrl(cfg, path, opts.query);
  if (u.origin !== new URL(cfg.baseUrl).origin) {
    throw new NotionError(`refusing to send credentials to ${u.origin}: it is not the configured Notion API`);
  }
  const method = opts.body === undefined ? "GET" : "POST";
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${cfg.token}`,
    "Notion-Version": cfg.notionVersion,
    "User-Agent": USER_AGENT,
  };
  if (method === "POST") headers["Content-Type"] = "application/json";
  const payload = method === "POST" ? JSON.stringify(opts.body) : undefined;
  for (let attempt = 1; ; attempt++) {
    await acquire(cfg);
    let res: Response;
    try {
      res = await fetch(u, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        throw new NotionError(`${method} ${shown(u)} failed: ${(err as Error).message}`);
      }
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    // 409 conflict_error is documented as transient ("try again").
    const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      const { code, message } = await errorSummary(res);
      throw new NotionError(
        `${method} ${shown(u)} failed with HTTP ${res.status}${code ? ` ${code}` : ""}: ${message}`,
        res.status,
        code,
      );
    }
    await res.body?.cancel();
    const hinted = res.status === 429 || res.status === 503 ? retryDelayMs(res.headers) : undefined;
    const backoff = 500 * 2 ** (attempt - 1) * (0.75 + Math.random() / 2);
    const delay = Math.min(hinted ?? backoff, MAX_RATE_WAIT_MS);
    if (res.status === 429) {
      // Everyone sharing this token should hold off, not just this request.
      const b = buckets.get(cfg.bucketKey);
      if (b) {
        b.pauseUntil = Date.now() + delay;
        b.tokens = 0;
      }
    }
    log.info(`notion: HTTP ${res.status} for ${shown(u)}; retry ${attempt} in ${Math.round(delay)} ms`);
    await sleep(delay);
  }
}

/** Notion errors are `{object: "error", status, code, message}`. */
async function errorSummary(res: Response): Promise<{ code?: string; message: string }> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { code?: string; message?: string };
    return { code: j.code, message: j.message ?? text.slice(0, 300) };
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/** Path + query of a URL for error messages (the token is never in a URL). */
function shown(u: URL): string {
  const s = `${u.pathname}${u.search}`;
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

// ------------------------------------------------------------------------ paging

/** A Notion list response. */
export interface ListPage<T = Record<string, unknown>> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  request_status?: { type?: string; incomplete_reason?: string };
}

export function asList<T = Record<string, unknown>>(body: unknown): ListPage<T> {
  const b = (body ?? {}) as Partial<ListPage<T>>;
  return {
    results: Array.isArray(b.results) ? b.results : [],
    next_cursor: typeof b.next_cursor === "string" && b.next_cursor !== "" ? b.next_cursor : null,
    has_more: b.has_more === true,
    request_status: b.request_status,
  };
}

/** Read every page of a GET list endpoint (small collections: property items, schema lookups). */
export async function getAll<T = Record<string, unknown>>(
  cfg: NotionConfig,
  path: string,
  query: Query = {},
  maxPages = 1000,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = asList<T>(
      await notionRequest(cfg, path, { query: { ...query, page_size: "100", start_cursor: cursor } }),
    );
    out.push(...page.results);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

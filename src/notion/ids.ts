/**
 * Notion object ids: accept a dashed UUID, 32 bare hex digits, or a Notion URL
 * (`https://www.notion.so/acme/Roadmap-1a2b…?v=…`) and return the dashed form the API
 * echoes back in responses.
 */

import { NotionError } from "./client.ts";

const HEX32 = /[0-9a-f]{32}/gi;

/** Dash 32 hex digits as 8-4-4-4-12. */
function dash(h: string): string {
  const x = h.toLowerCase();
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** Normalize an id argument; `what` names it in the error message. */
export function normalizeId(raw: string | null | undefined, what = "id"): string {
  const s = (raw ?? "").trim();
  if (s === "") throw new NotionError(`${what} is required (a Notion id or a notion.so URL)`);
  let body = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      // The object id is in the path; ?v= is a view id and ?p= a peeked page.
      const u = new URL(s);
      const peek = u.searchParams.get("p");
      body = peek && /^[0-9a-f]{32}$/i.test(peek) ? peek : u.pathname;
    } catch {
      throw new NotionError(`${what} '${s}' is not a valid URL`);
    }
  }
  const compact = body.replace(/-/g, "");
  const matches = compact.match(HEX32);
  const last = matches?.[matches.length - 1];
  if (!last) throw new NotionError(`${what} '${s}' does not contain a Notion id (32 hex digits)`);
  return dash(last);
}

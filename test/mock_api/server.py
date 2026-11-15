#!/usr/bin/env python3
"""An offline, strict Notion API replay server (stdlib only).

It serves the hand-built workspace in ``fixtures.py`` (documented response shapes for
Notion-Version 2026-03-11) and behaves like Notion where the worker depends on it:

* **Auth + version.** Every ``/v1`` request needs ``Authorization: Bearer ntn_test_token``
  (401 ``unauthorized`` otherwise) and ``Notion-Version: 2026-03-11`` (400
  ``missing_version`` when absent, ``validation_error`` for any other version).
* **Strict requests.** Each route accepts only its documented query parameters and body
  keys (400 ``validation_error`` otherwise). Search rejects the pre-2025 ``database``
  object filter.
* **Filters are evaluated.** Data source queries parse the Notion filter object and
  EVALUATE it against the fixture rows: property conditions by type (text, number,
  checkbox, select/status, multi_select/people/relation, date, files, unique_id,
  formula, created/last edited time/by), timestamp filters, and ``and``/``or`` nesting
  (more than two levels is a 400, like Notion). A condition that does not fit the
  property's type, or an unknown property, is a 400. So a wrong pushdown returns wrong
  rows or fails, never silently passes. Sorts are applied; ``filter_properties`` limits
  the returned properties.
* **Paging.** Small page caps (queries 2, search 3, block children 3, users 2, property
  items 1) with opaque cursors bound to the request: a cursor replayed with a different
  filter / sort is a 400.
* **Rate limits.** The first ``/v1/users`` and the first ``/v1/search`` request answer 429
  ``rate_limited`` with ``Retry-After: 1``; the first ``/v1/comments`` answers 503.
* **Introspection.** ``GET /__requests?path=<path>`` returns every recorded request to that
  path (``seq``, ``method``, ``path``, ``query`` and ``body`` as JSON strings, ``auth``,
  ``version``) so SQL tests can assert exactly what was pushed down; ``/__reset`` clears it.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import base64
import copy
import datetime as dt
import hashlib
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fixtures as F  # noqa: E402

TOKEN = "Bearer ntn_test_token"
VERSION = "2026-03-11"

LOCK = threading.Lock()
REQUESTS: list[dict] = []
FAILED_ONCE: set[str] = set()


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}

    def body(self) -> dict:
        return {"object": "error", "status": self.status, "code": self.code, "message": self.message}


def bad(msg: str) -> HttpError:
    return HttpError(400, "validation_error", msg)


def not_found(kind: str, oid: str) -> HttpError:
    return HttpError(404, "object_not_found",
                     f"Could not find {kind} with ID: {oid}. Make sure the relevant pages and databases are shared with your integration.")


def only(d: dict, allowed: set[str], what: str) -> None:
    for k in d:
        if k not in allowed:
            raise bad(f"{what} has an unrecognized key '{k}'")


ID_RE = re.compile(r"^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$")


def norm_id(raw: str) -> str:
    if not ID_RE.match(raw):
        raise bad(f"path failed validation: {raw} should be a valid uuid")
    h = raw.replace("-", "")
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def page_size(v, cap: int) -> int:
    if v is None:
        return cap
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise bad("page_size should be a number")
    if n < 1 or n > 100:
        raise bad("page_size should be between 1 and 100")
    return min(n, cap)


def fingerprint(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()[:12]


def paginate(items: list, size: int, cursor: str | None, bound) -> dict:
    """Slice items; cursors encode an offset plus a fingerprint of the request they belong to."""
    fp = fingerprint(bound)
    start = 0
    if cursor:
        try:
            off, cfp = base64.urlsafe_b64decode(cursor.encode()).decode().split(":")
            start = int(off)
        except Exception:
            raise bad("start_cursor is not a valid cursor")
        if cfp != fp:
            raise bad("start_cursor does not belong to this request (filter/sorts/parameters changed)")
    chunk = items[start : start + size]
    more = start + size < len(items)
    nxt = base64.urlsafe_b64encode(f"{start + size}:{fp}".encode()).decode() if more else None
    return {"object": "list", "results": chunk, "next_cursor": nxt, "has_more": more}


def strip(obj):
    """Drop fixture-internal keys (leading underscore)."""
    if isinstance(obj, dict):
        return {k: strip(v) for k, v in obj.items() if not k.startswith("_")}
    if isinstance(obj, list):
        return [strip(x) for x in obj]
    return obj


# ------------------------------------------------------------------ filter evaluation


def parse_time(s: str) -> dt.datetime:
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc)
    t = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def date_cond(value: str | None, cond: dict, what: str) -> bool:
    """Notion date conditions against an ISO date / datetime (the start of a date range)."""
    if len(cond) != 1:
        raise bad(f"{what} filter must have exactly one condition")
    (op, arg), = cond.items()
    if op == "is_empty":
        return value is None
    if op == "is_not_empty":
        return value is not None
    if op in ("past_week", "past_month", "past_year", "next_week", "next_month", "next_year", "this_week"):
        raise bad(f"{what}.{op} is not supported by this replay server")
    if op not in ("equals", "before", "after", "on_or_before", "on_or_after"):
        raise bad(f"{what} filter has an unknown condition '{op}'")
    if not isinstance(arg, str):
        raise bad(f"{what}.{op} should be an ISO 8601 date string")
    if value is None:
        return False
    v, a = parse_time(value), parse_time(arg)
    if op == "equals":
        return v.date() == a.date()
    return {"before": v < a, "after": v > a, "on_or_before": v <= a, "on_or_after": v >= a}[op]


def text_cond(value: str, cond: dict, what: str) -> bool:
    if len(cond) != 1:
        raise bad(f"{what} filter must have exactly one condition")
    (op, arg), = cond.items()
    if op == "is_empty":
        return value == ""
    if op == "is_not_empty":
        return value != ""
    if not isinstance(arg, str):
        raise bad(f"{what}.{op} should be a string")
    lv, la = value.lower(), arg.lower()
    ops = {
        "equals": value == arg,
        "does_not_equal": value != arg,
        "contains": la in lv,
        "does_not_contain": la not in lv,
        "starts_with": lv.startswith(la),
        "ends_with": lv.endswith(la),
    }
    if op not in ops:
        raise bad(f"{what} filter has an unknown condition '{op}'")
    return ops[op]


def number_cond(value, cond: dict, what: str) -> bool:
    if len(cond) != 1:
        raise bad(f"{what} filter must have exactly one condition")
    (op, arg), = cond.items()
    if op == "is_empty":
        return value is None
    if op == "is_not_empty":
        return value is not None
    if isinstance(arg, bool) or not isinstance(arg, (int, float)):
        raise bad(f"{what}.{op} should be a number")
    if value is None:
        return False
    ops = {
        "equals": value == arg, "does_not_equal": value != arg,
        "greater_than": value > arg, "less_than": value < arg,
        "greater_than_or_equal_to": value >= arg, "less_than_or_equal_to": value <= arg,
    }
    if op not in ops:
        raise bad(f"{what} filter has an unknown condition '{op}'")
    return ops[op]


def bool_cond(value, cond: dict, what: str) -> bool:
    only(cond, {"equals", "does_not_equal"}, f"{what} filter")
    if len(cond) != 1:
        raise bad(f"{what} filter must have exactly one condition")
    (op, arg), = cond.items()
    if not isinstance(arg, bool):
        raise bad(f"{what}.{op} should be a boolean")
    return (value == arg) if op == "equals" else (value != arg)


def option_cond(name: str | None, cond: dict, what: str) -> bool:
    only(cond, {"equals", "does_not_equal", "is_empty", "is_not_empty"}, f"{what} filter")
    if len(cond) != 1:
        raise bad(f"{what} filter must have exactly one condition")
    (op, arg), = cond.items()
    if op == "is_empty":
        return name is None
    if op == "is_not_empty":
        return name is not None
    if not isinstance(arg, str):
        raise bad(f"{what}.{op} should be a string")
    return (name == arg) if op == "equals" else (name != arg)


def list_cond(values: list[str], cond: dict, what: str) -> bool:
    only(cond, {"contains", "does_not_contain", "is_empty", "is_not_empty"}, f"{what} filter")
    if len(cond) != 1:
        raise bad(f"{what} filter must have exactly one condition")
    (op, arg), = cond.items()
    if op == "is_empty":
        return not values
    if op == "is_not_empty":
        return bool(values)
    if not isinstance(arg, str):
        raise bad(f"{what}.{op} should be a string")
    return (arg in values) if op == "contains" else (arg not in values)


def plain(rt) -> str:
    return "".join(r.get("plain_text", "") for r in rt or [])


def prop_by_ref(schema: dict, ref: str) -> dict:
    for name, p in schema.items():
        if ref in (name, p["id"], unquote(p["id"])):
            return p
    raise bad(f"Could not find property with name or id: {ref}")


def eval_property(page: dict, schema_prop: dict, f: dict) -> bool:
    ptype = schema_prop["type"]
    keys = [k for k in f if k != "property"]
    if len(keys) != 1:
        raise bad("a property filter needs exactly one type key")
    key = keys[0]
    cond = f[key]
    if not isinstance(cond, dict):
        raise bad(f"{key} should be an object")
    value = next(v for v in page["properties"].values() if v["id"] == schema_prop["id"])
    v = value.get(value["type"])
    # The condition key must match the property type (people conditions also fit created_by / last_edited_by).
    compatible = {ptype}
    if ptype in ("created_by", "last_edited_by"):
        compatible |= {"people"}
    if ptype in ("created_time", "last_edited_time"):
        compatible |= {"date"}
    if key not in compatible:
        raise bad(f"filter type '{key}' does not match property '{schema_prop['name']}' of type '{ptype}'")
    if ptype in ("title", "rich_text"):
        return text_cond(plain(v), cond, key)
    if ptype in ("url", "email", "phone_number"):
        return text_cond(v or "", cond, key)
    if ptype == "number":
        return number_cond(v, cond, key)
    if ptype == "checkbox":
        return bool_cond(v, cond, key)
    if ptype in ("select", "status"):
        return option_cond(v["name"] if v else None, cond, key)
    if ptype == "multi_select":
        return list_cond([o["name"] for o in v], cond, key)
    if ptype == "people":
        return list_cond([u["id"] for u in v], cond, key)
    if ptype == "relation":
        full = F.PROPERTY_ITEMS.get((page["id"], schema_prop["id"]))
        ids = [i["relation"]["id"] for i in full] if full is not None else [r["id"] for r in v]
        return list_cond(ids, cond, key)
    if ptype in ("created_by", "last_edited_by"):
        return list_cond([v["id"]] if v else [], cond, key)
    if ptype == "date":
        return date_cond(v["start"] if v else None, cond, key)
    if ptype in ("created_time", "last_edited_time"):
        return date_cond(v, cond, key)
    if ptype == "files":
        only(cond, {"is_empty", "is_not_empty"}, "files filter")
        return (not v) if "is_empty" in cond else bool(v)
    if ptype == "unique_id":
        return number_cond(v["number"] if v else None, cond, key)
    if ptype == "formula":
        if len(cond) != 1:
            raise bad("formula filter needs exactly one of string, checkbox, number, date")
        (sub, c), = cond.items()
        if sub == "string":
            return v["type"] == "string" and text_cond(v.get("string") or "", c, "formula.string")
        if sub == "number":
            return v["type"] == "number" and number_cond(v.get("number"), c, "formula.number")
        if sub == "checkbox":
            return v["type"] == "boolean" and bool_cond(v.get("boolean"), c, "formula.checkbox")
        if sub == "date":
            return v["type"] == "date" and date_cond((v.get("date") or {}).get("start"), c, "formula.date")
        raise bad(f"formula filter has an unknown key '{sub}'")
    raise bad(f"filtering on '{ptype}' properties is not supported by this replay server")


def filter_depth(f) -> int:
    if isinstance(f, dict) and ("and" in f or "or" in f):
        kids = f.get("and", f.get("or"))
        return 1 + max([filter_depth(k) for k in kids] or [0])
    return 0


def eval_filter(page: dict, schema: dict, f) -> bool:
    if not isinstance(f, dict):
        raise bad("filter should be an object")
    if "and" in f or "or" in f:
        only(f, {"and", "or"}, "compound filter")
        if len(f) != 1 or not isinstance(next(iter(f.values())), list):
            raise bad("a compound filter has exactly one of 'and' / 'or' with a list")
        kids = f.get("and", f.get("or"))
        res = [eval_filter(page, schema, k) for k in kids]
        return all(res) if "and" in f else any(res)
    if "timestamp" in f:
        ts = f["timestamp"]
        if ts not in ("created_time", "last_edited_time"):
            raise bad("timestamp should be created_time or last_edited_time")
        only(f, {"timestamp", ts}, "timestamp filter")
        return date_cond(page[ts], f[ts], ts)
    if "property" not in f:
        raise bad("filter needs 'property', 'timestamp', 'and' or 'or'")
    return eval_property(page, prop_by_ref(schema, f["property"]), f)


def sort_rows(rows: list, schema: dict, sorts) -> list:
    if not isinstance(sorts, list):
        raise bad("sorts should be an array")
    for s in reversed(sorts):
        only(s, {"property", "timestamp", "direction"}, "sort")
        rev = s.get("direction", "ascending") == "descending"
        if "timestamp" in s:
            key = lambda r, ts=s["timestamp"]: r[ts]  # noqa: E731
        else:
            p = prop_by_ref(schema, s["property"])

            def key(r, p=p):
                v = next(x for x in r["properties"].values() if x["id"] == p["id"])
                x = v.get(v["type"])
                if p["type"] in ("title", "rich_text"):
                    return (0, plain(x))
                if isinstance(x, dict):
                    x = x.get("name") or x.get("start") or x.get("number")
                return (1, "") if x is None else (0, x)
        rows = sorted(rows, key=key, reverse=rev)
    return rows


def project_properties(page: dict, ids: list[str] | None) -> dict:
    if not ids:
        return page
    wanted = {unquote(i) for i in ids}
    known = {unquote(v["id"]) for v in page["properties"].values()}
    for w in wanted:
        if w not in known:
            raise bad(f"filter_properties: unknown property id {w}")
    out = dict(page)
    out["properties"] = {k: v for k, v in page["properties"].items() if unquote(v["id"]) in wanted}
    return out


# -------------------------------------------------------------------------- routes


def title_of(obj: dict) -> str:
    if obj["object"] == "data_source":
        return plain(obj["title"])
    for v in obj["properties"].values():
        if v["type"] == "title":
            return plain(v["title"])
    return ""


def route(method: str, path: str, query: dict, body) -> dict:
    q1 = {k: v[-1] for k, v in query.items()}
    m = re.fullmatch(r"/v1/search", path)
    if m:
        if method != "POST":
            raise HttpError(405, "invalid_request_url", "search is POST")
        only(body, {"query", "filter", "sort", "start_cursor", "page_size", "filter_properties"}, "body")
        only(query, set(), "query string")
        items = [p for p in F.PAGES] + list(F.DATA_SOURCES)
        if "filter" in body:
            flt = body["filter"]
            only(flt, {"property", "value"}, "filter")
            if flt.get("property") != "object" or flt.get("value") not in ("page", "data_source"):
                raise bad("body.filter.value should be \"page\" or \"data_source\"")
            items = [i for i in items if i["object"] == flt["value"]]
        qtext = (body.get("query") or "").lower()
        if qtext:
            items = [i for i in items if qtext in title_of(i).lower()]
        srt = body.get("sort")
        if srt is not None:
            only(srt, {"direction", "timestamp"}, "sort")
            if srt.get("timestamp") != "last_edited_time":
                raise bad("sort.timestamp should be last_edited_time")
            items = sorted(items, key=lambda i: (i["last_edited_time"], i["id"]), reverse=srt.get("direction") == "descending")
        bound = {k: v for k, v in body.items() if k != "start_cursor"}
        res = paginate([strip(i) for i in items], page_size(body.get("page_size"), 3), body.get("start_cursor"), bound)
        res["type"] = "page_or_data_source"
        return res

    m = re.fullmatch(r"/v1/data_sources/([^/]+)/query", path)
    if m:
        if method != "POST":
            raise HttpError(405, "invalid_request_url", "query is POST")
        only(query, {"filter_properties"}, "query string")
        only(body, {"filter", "sorts", "start_cursor", "page_size", "in_trash", "result_type"}, "body")
        ds_id = norm_id(m.group(1))
        ds = F.DS_BY_ID.get(ds_id)
        if not ds:
            raise not_found("data_source", ds_id)
        schema = ds["properties"]
        rows = list(F.ROWS[ds_id])
        if "filter" in body:
            if filter_depth(body["filter"]) > 2:
                raise bad("filter: compound filters can be nested at most 2 levels deep")
            rows = [r for r in rows if eval_filter(r, schema, body["filter"])]
        # Default order: newest first (created_time descending).
        rows = sorted(rows, key=lambda r: r["created_time"], reverse=True)
        if "sorts" in body:
            rows = sort_rows(rows, schema, body["sorts"])
        fp = query.get("filter_properties")
        rows = [strip(project_properties(r, fp)) for r in rows]
        bound = {"q": query, "b": {k: v for k, v in body.items() if k != "start_cursor"}}
        res = paginate(rows, page_size(body.get("page_size"), 2), body.get("start_cursor"), bound)
        res["type"] = "page_or_data_source"
        return res

    if method != "GET":
        raise HttpError(405, "invalid_request_url", f"{method} {path} is not supported (read-only replay server)")

    m = re.fullmatch(r"/v1/data_sources/([^/]+)", path)
    if m:
        only(query, set(), "query string")
        ds_id = norm_id(m.group(1))
        if ds_id not in F.DS_BY_ID:
            raise not_found("data_source", ds_id)
        return strip(F.DS_BY_ID[ds_id])

    m = re.fullmatch(r"/v1/databases/([^/]+)", path)
    if m:
        only(query, set(), "query string")
        db_id = norm_id(m.group(1))
        if db_id not in F.DB_BY_ID:
            raise not_found("database", db_id)
        return strip(F.DB_BY_ID[db_id])

    m = re.fullmatch(r"/v1/pages/([^/]+)/properties/([^/]+)", path)
    if m:
        only(query, {"page_size", "start_cursor"}, "query string")
        pid = norm_id(m.group(1))
        prop_id = unquote(m.group(2))
        page = F.PAGE_BY_ID.get(pid)
        if not page:
            raise not_found("page", pid)
        items = F.PROPERTY_ITEMS.get((pid, prop_id))
        if items is None:
            raise bad(f"property {prop_id} is not a paginated property of page {pid} in this replay server")
        res = paginate(items, page_size(q1.get("page_size"), 1), q1.get("start_cursor"), {"p": pid, "i": prop_id})
        res["type"] = "property_item"
        res["property_item"] = {"id": prop_id, "type": "relation", "next_url": None, "relation": {}}
        return res

    m = re.fullmatch(r"/v1/pages/([^/]+)", path)
    if m:
        only(query, {"filter_properties"}, "query string")
        pid = norm_id(m.group(1))
        page = F.PAGE_BY_ID.get(pid)
        if not page:
            raise not_found("page", pid)
        return strip(project_properties(page, query.get("filter_properties")))

    m = re.fullmatch(r"/v1/blocks/([^/]+)/children", path)
    if m:
        only(query, {"page_size", "start_cursor"}, "query string")
        bid = norm_id(m.group(1))
        if bid in F.DB_BY_ID:
            raise bad(f"Block {bid} is a child_database; query its data sources instead")
        kids = F.BLOCK_CHILDREN.get(bid)
        if kids is None:
            if bid in F.BLOCK_BY_ID:
                kids = []
            else:
                raise not_found("block", bid)
        res = paginate([strip(b) for b in kids], page_size(q1.get("page_size"), 3), q1.get("start_cursor"), {"b": bid})
        res["type"] = "block"
        res["block"] = {}
        return res

    if path == "/v1/comments":
        only(query, {"block_id", "page_size", "start_cursor"}, "query string")
        if "block_id" not in q1:
            raise bad("block_id should be defined")
        bid = norm_id(q1["block_id"])
        items = [c for c in F.COMMENTS if bid in (c["parent"].get("page_id"), c["parent"].get("block_id"))]
        res = paginate(items, page_size(q1.get("page_size"), 2), q1.get("start_cursor"), {"b": bid})
        res["type"] = "comment"
        res["comment"] = {}
        return res

    if path == "/v1/users":
        only(query, {"page_size", "start_cursor"}, "query string")
        res = paginate(F.USERS, page_size(q1.get("page_size"), 2), q1.get("start_cursor"), {})
        res["type"] = "user"
        res["user"] = {}
        return res

    m = re.fullmatch(r"/v1/users/([^/]+)", path)
    if m:
        only(query, set(), "query string")
        uid = norm_id(m.group(1))
        if uid not in F.USER_BY_ID:
            raise not_found("user", uid)
        return F.USER_BY_ID[uid]

    raise HttpError(400, "invalid_request_url", f"Invalid request URL: {method} {path}")


ONCE = {"/v1/users": (429, "rate_limited"), "/v1/search": (429, "rate_limited"), "/v1/comments": (503, "service_unavailable")}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, status: int, payload, headers: dict | None = None) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method: str) -> None:
        u = urlparse(self.path)
        query = parse_qs(u.query, keep_blank_values=True)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if u.path == "/__requests":
            want = (query.get("path") or [None])[-1]
            with LOCK:
                rows = [r for r in REQUESTS if want is None or r["path"] == want]
            return self._send(200, rows)
        if u.path == "/__reset":
            with LOCK:
                REQUESTS.clear()
                FAILED_ONCE.clear()
            return self._send(200, {"ok": True})
        auth = self.headers.get("Authorization")
        version = self.headers.get("Notion-Version")
        with LOCK:
            REQUESTS.append({
                "seq": len(REQUESTS) + 1, "method": method, "path": u.path,
                "query": json.dumps(query, sort_keys=True), "body": raw.decode() or "null",
                "auth": "ok" if auth == TOKEN else ("missing" if auth is None else "bad"),
                "version": version,
            })
        try:
            if not u.path.startswith("/v1/"):
                raise HttpError(400, "invalid_request_url", f"Invalid request URL: {u.path}")
            if auth != TOKEN:
                raise HttpError(401, "unauthorized", "API token is invalid.")
            if version is None:
                raise HttpError(400, "missing_version", "Notion-Version header failed validation: Notion-Version header should be defined")
            if version != VERSION:
                raise bad(f"Notion-Version {version} is not served by this replay server (expected {VERSION})")
            body = None
            if method == "POST":
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise bad("Content-Type should be application/json")
                try:
                    body = json.loads(raw or b"{}")
                except json.JSONDecodeError:
                    raise HttpError(400, "invalid_json", "Error parsing JSON body.")
                if not isinstance(body, dict):
                    raise bad("body should be an object")
            key = u.path
            if key in ONCE:
                with LOCK:
                    first = key not in FAILED_ONCE
                    FAILED_ONCE.add(key)
                if first:
                    st, code = ONCE[key]
                    raise HttpError(st, code, "You have been rate limited. Please try again in a few minutes."
                                    if st == 429 else "Notion is unavailable, please try again later.",
                                    {"Retry-After": "1"})
            self._send(200, route(method, u.path, query, copy.deepcopy(body)))
        except HttpError as e:
            self._send(e.status, e.body(), e.headers)

    def do_GET(self):  # noqa: N802
        self._handle("GET")

    def do_POST(self):  # noqa: N802
        self._handle("POST")

    def do_PATCH(self):  # noqa: N802
        self._handle("PATCH")

    def do_DELETE(self):  # noqa: N802
        self._handle("DELETE")


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

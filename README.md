<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Notion Databases, Pages and Blocks in DuckDB

> **vgi-notion** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-notion/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-notion/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

A Notion workspace as SQL, read-only. Any Notion database becomes a typed table with
one column per property (title, status, select, people, relation, date, formula,
rollup, …), your `WHERE` clause becomes a Notion filter object, and only the
properties you select are downloaded. Page bodies come back as block rows or as one
Markdown / plain-text document, ready for export, search and RAG.

```sql
CREATE SECRET notion (TYPE notion, TOKEN 'ntn_…');   -- an internal integration secret

-- Open tasks due from November on. One request:
--   {"and":[{"property":"Status","status":{"equals":"In progress"}},
--           {"property":"Due","date":{"on_or_after":"…"}}]}
SELECT "Name", "Assignee", "Due".start AS due
FROM notion.main.query_database('https://www.notion.so/acme/Tasks-1a2b3c4d00004000800000000000d001')
WHERE "Status" = 'In progress' AND "Due".start >= TIMESTAMPTZ '2026-11-01 00:00:00+00'
ORDER BY due;

-- Story points per assignee, joining the people column to the workspace users.
SELECT u.name, sum(t."Estimate") AS points
FROM notion.main.query_data_source('1a2b3c4d-0000-4000-8000-00000000d501') t, notion.main.users u
WHERE list_contains(t."Assignee", u.id)
GROUP BY u.name ORDER BY points DESC;

-- A page as Markdown, and its outline.
SELECT markdown FROM notion.main.page_markdown('1a2b3c4d-0000-4000-8000-00000000a001');
SELECT depth, text FROM notion.main.blocks('1a2b3c4d-0000-4000-8000-00000000a001')
WHERE type LIKE 'heading_%' ORDER BY path;
```

Ids can be dashed UUIDs, 32 hex digits, or a `notion.so` URL pasted from the browser.

## Functions and tables

All in schema `notion.main`.

| Object | What it returns |
| --- | --- |
| `search(query := '')` | Pages and data sources shared with the integration, by title |
| `data_sources` (table) | Every data source: id, title, database, property names |
| `databases` (table) | Databases (containers) with their data sources |
| `users` (table) | People and bots; email only when Notion returns it |
| `data_source_schema(id)` | Each property, its Notion type and the SQL column it becomes; select / status options |
| `query_data_source(id, notion_filter := NULL, notion_sorts := NULL, rich_text_json := true)` | The rows (pages) of a data source, one typed column per property |
| `query_database(database_id, …)` | Same, for a database with one data source (the id in its URL) |
| `page(page_id)` | One page's metadata and raw property JSON |
| `page_properties(page_id)` | One page's properties as name / text / JSON rows |
| `blocks(block_id, max_depth := 10, include_child_pages := false)` | The block tree: type, plain text, rich text JSON, depth, `path` for document order |
| `page_markdown(page_id, …)` / `page_text(page_id, …)` | The page rendered to one GFM Markdown / plain-text document |
| `comments(block_id)` | Open comments on a page or block, by discussion |

### The data-source model

This worker speaks **Notion-Version 2026-03-11**. Since 2025 a Notion *database* is a
container of one or more *data sources*, and rows are queried per data source. Most
databases hold exactly one: `query_database(url)` resolves it for you (and
`query_data_source` accepts a database id in that case too). A database with several
data sources is an error that names them.

### Property types → columns

| Notion property | Column type |
| --- | --- |
| title, rich_text | `VARCHAR` plain text, plus a `"<name>__json"` `JSON` sibling with marks, links and mentions |
| number | `DOUBLE` |
| checkbox | `BOOLEAN` |
| select, status | `VARCHAR` option name |
| multi_select | `VARCHAR[]` option names |
| people, relation | `VARCHAR[]` user ids / related page ids (relations over 25 entries are completed) |
| date | `STRUCT("start" TIMESTAMPTZ, "end" TIMESTAMPTZ, time_zone VARCHAR, has_time BOOLEAN)`; all-day dates are 00:00 UTC with `has_time = false` |
| created_time, last_edited_time | `TIMESTAMPTZ` |
| created_by, last_edited_by | `VARCHAR` user id |
| url, email, phone_number | `VARCHAR` |
| files | `STRUCT(name, type, url, expiry_time)[]` (Notion-hosted URLs expire) |
| unique_id | `BIGINT` (the prefix is in `data_source_schema`) |
| formula | by result type, read from one sample row: `VARCHAR`, `DOUBLE`, `BOOLEAN` or the date struct |
| rollup | by function: `DOUBLE` (count, sum, average, …), the date struct (earliest / latest / range) or `VARCHAR[]` (show original / unique) |
| verification | `VARCHAR` state |
| button | no column |
| anything else | `JSON` |

Every row also has `id`, `url`, `created_time`, `last_edited_time`, `created_by`,
`last_edited_by` and `in_trash`. Property names are kept verbatim (quote them); one
that collides case-insensitively with another column gets a `_2` suffix.
`data_source_schema(id)` shows the exact column name and type of every property.

### Pushdown

- **WHERE → Notion filter object** for `query_data_source` / `query_database`:
  `=`, `<>`, ranges and `IN` on numbers, unique ids and number formulas; `=` / `IN` on
  select, status, title, rich text, url, email, phone and string formulas;
  `LIKE '%x%'`, `contains()` and `suffix()` on text; `list_contains()` on multi_select,
  people and relation; `IS [NOT] NULL` on text, number, select, status and dates;
  checkboxes; `created_time` / `last_edited_time` (as timestamp filters) and a date's
  `.start` lower bound. `AND` sends what translates; `OR` is sent only when every branch
  translates; nesting is capped at Notion's two levels.
- **Narrowing only.** The SDK re-applies every pushed SQL predicate exactly, so Notion's
  looser matching (case-insensitive text, date-granular comparisons, widened by a day) can
  never change a result. Anything not translated is filtered in DuckDB.
- **Projection → `filter_properties`**: only the selected properties are downloaded
  (`count(*)` asks for the title only).
- `notion_filter := '<filter JSON>'` is ANDed with the pushed filter; `notion_sorts`
  passes Notion sorts through.
- `search`: `WHERE object = 'page' | 'data_source'`. `data_sources`, `databases`, `users`:
  `WHERE id = … / IN (…)` reads those objects directly; `data_sources WHERE database_id = …`
  lists one database's sources.

Prefix `LIKE 'x%'` reaches the worker as a string range, which has no Notion
equivalent, so it is applied in DuckDB.

## Authentication

```sql
-- Internal integration (notion.so/profile/integrations): share pages / databases with it.
CREATE SECRET notion (TYPE notion, TOKEN 'ntn_…');
-- Public integration: an OAuth 2.0 access token.
CREATE SECRET notion (TYPE notion, OAUTH_ACCESS_TOKEN '…');
```

| Field | Meaning |
| --- | --- |
| `token` | Internal integration secret, sent as `Authorization: Bearer` (redacted) |
| `oauth_access_token` | Public integration access token (redacted) |
| `base_url` | API base (default `https://api.notion.com`); `http://` only for 127.0.0.1 / localhost |
| `notion_version` | `Notion-Version` header (default `2026-03-11`) |
| `requests_per_second` | Client-side average rate (default 3, Notion's documented limit) |

The integration sees only what is shared with it. Emails appear in `users` only with
the "read user information including email addresses" capability; comments need
"read comments". The token is read from the secret on each call and never stored in
scan state or logs. Use of the Notion API is subject to Notion's terms; the token and
the workspace data it can reach are your responsibility.

## Paging and rate limits

Notion's `next_cursor` lives in each scan's serializable state (the `blocks` walk keeps
its stack of pending parents there too), so a long scan streams one page per Arrow
batch and resumes on any worker process over HTTP. The request body is rebuilt from the
arguments and pushed filters on every call. A per-token token bucket keeps calls at the
configured average rate; `429 rate_limited` honours `Retry-After` and pauses everyone
sharing the token; 409 / 5xx and network errors back off exponentially (6 attempts, 30 s
timeout per request). A data source query that hits Notion's 10,000-row cap
(`request_status: incomplete`) is an error asking you to narrow it, never a silently
truncated result.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-notion.git && cd vgi-notion
git checkout v0.1.0            # a release tag
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'notion' (TYPE vgi, LOCATION '/abs/path/to/vgi-notion/bin/vgi-notion-worker');
CREATE SECRET notion (TYPE notion, TOKEN 'ntn_…');   -- after ATTACH: the worker registers the type
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'notion' (TYPE vgi, LOCATION '/abs/path/to/vgi-notion/bin/vgi-notion-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed); point `LOCATION` at the downloaded binary.
The same binary serves HTTP with `--http --port 8000` (see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (filter translation, property mapping, rendering, rate limiter)
make test-sql                  # test/sql/notion.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make lint-explain              # vgi-lint, executing examples against the replay server
make check                     # everything CI runs
```

No test touches the network or a real workspace. `test/mock_api/server.py` is a
stdlib-only replay server over a hand-built workspace in Notion's documented response
shapes. It enforces the bearer token and the `Notion-Version` header, rejects unknown
query parameters and body keys, **evaluates the filter objects it receives** against its
rows (so a wrong pushdown returns wrong rows or a 400), applies sorts and
`filter_properties`, pages with small caps and request-bound cursors, completes a
truncated relation through the property item endpoint, and answers a 429 and a 503 once
each so the retry paths always run. The SQL tests read its `/__requests` log to check
exactly what was pushed down and that the token bucket spaced the requests.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm

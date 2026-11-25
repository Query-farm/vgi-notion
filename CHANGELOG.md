# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52.3 and @query-farm/vgi-rpc to 0.30.3. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.1 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.
- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.0 (unreleased)

First release: Notion (API version 2026-03-11, data sources) as SQL, read-only.

- `search`, and the `data_sources`, `databases` and `users` tables.
- `data_source_schema` and `query_data_source` / `query_database`: one typed column per
  property, WHERE → Notion filter object pushdown, projection → `filter_properties`,
  `notion_filter` / `notion_sorts` pass-through, cursor in scan state.
- `page`, `page_properties`, `blocks` (recursive, externalized walk), `page_markdown`,
  `page_text` and `comments`.
- `notion` secret (integration token or OAuth access token, `base_url`), client-side token
  bucket (~3 req/s) and 429 `Retry-After` handling.

Built in TypeScript from vgi-starter-typescript v1.3.0 (the design spec said Go; the
language plan matched each ecosystem, putting Notion under TypeScript).

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)

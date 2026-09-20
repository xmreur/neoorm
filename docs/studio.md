# Studio

`neoorm studio` opens a local web UI for browsing and editing your data — a spreadsheet grid, a SQL console, a query playground, a schema explorer, an ER graph, and migrate status.

```bash
bunx neoorm studio --open
```

Studio reads `neoorm.config.ts` (after `.env`, like the other commands) and compiles `schema.ts` live, so the tables you see always match the schema file you just saved. If `schema.ts` does not compile, Studio falls back to `snapshot.json` and shows a banner. It connects with the datasource URL from your config — the connection string is never sent to the browser.

## Data grid

- Spreadsheet-like browsing with pagination, multi-column sort (Shift+click), column reorder (drag headers), column show/hide, and wrap/truncate.
- Filters map to real NeoOrm `where` operators: strings (`contains`, `startsWith`, `endsWith`, `search`, insensitive via advanced JSON), numbers/dates (`gt`, `gte`, `lt`, `lte`, `in`), nulls, enums, JSON (`jsonContains`, `hasKey`, `path`), plus an advanced JSON box for relation filters (`some`/`every`/`none`), `AND`/`OR`/`NOT`.
- Table-wide search runs `contains` across text-like columns.
- Double-click a cell to edit. Edits are staged — press `Save` (or `⌘/Ctrl+S`) to write them, `Esc`-via-banner to discard. Cell editors are type-aware: booleans, enum selects, timestamps, JSON, arrays, UUID generation, `bytea` upload, decimals as strings.
- Hidden columns (`.hidden()`) are visible in Studio but masked until you reveal them — useful for passwords and secrets, which are fetched with `includeHidden`.
- `serial`/identity columns are omitted on create; `updatedAt` is read-only.
- Foreign-key cells link to the referenced row. Trailing `View →` columns navigate has-many and many-to-many relations. Clicking a row opens a detail sheet with a Relations tab for nested writes (`connect`, `connectOrCreate`, `create`, `disconnect`, `set`, `delete`).
- Select rows to copy as CSV, Markdown, JSON, or SQL `INSERT`s. Import CSV or JSON arrays (up to 5000 rows) with optional `skipDuplicates`. Export the current view in JSON, CSV, Markdown, or SQL.
- Tables without a usable unique key are browse/create-only, and Studio tells you why.

## SQL console

Run parameterized SQL with dialect-aware highlighting and schema autocomplete (`⌘/Ctrl+Enter` to run). Params are a JSON array (`$1`/`$2` on Postgres/SQLite, `?` on MySQL). Optional `EXPLAIN` / `EXPLAIN ANALYZE`. Query history is kept locally.

## Query playground

Build `findMany`, `findFirst`, `findUnique`, `findById`, `count`, `exists`, `aggregate`, `groupBy`, and `paginate` calls visually — `where`, `with`, `orderBy`, `select`, cursors — run them through the same client your app uses, and copy any working query as TypeScript (`db.users.findMany({ … })`).

## Schema, ER, migrate

- Schema explorer: columns, kinds, constraints, indexes (including partial `WHERE`), foreign keys, and relations per table. Read-only — schema changes belong in `schema.ts` plus `migrate dev`.
- ER graph: tables as nodes, `1:1` / `1:n` / `n:n` edges, junction tables hidden by default. Click a node to open its data.
- Migrate status: applied, pending, and orphan migrations. Studio never applies, resets, or rolls back migrations — use the CLI.

## Keyboard

- `⌘/Ctrl+K` — command palette (jump to tables, views, actions)
- `⌘/Ctrl+S` in the grid — save staged edits
- `Esc` in the grid — discard staged edits
- `⌘/Ctrl+R` in the grid — refresh rows
- `Alt+N` in the grid — new row
- `⌘/Ctrl+Enter` in SQL — run query

Views are deep-linkable: `#/tables/users?where=…&orderBy=…&q=…`, `#/sql`, `#/query`, `#/schema[/table]`, `#/er`, `#/migrate`.

## Security

- Studio binds `127.0.0.1` by default with no auth, like `neoorm docs`. Binding a non-loopback host generates a token (printed in the terminal) that every API call must send.
- `--read-only` blocks row mutations, imports, nested writes, and non-read SQL (`SELECT`, `EXPLAIN`, `PRAGMA`, and friends still work).
- The browser never receives your datasource URL, and hidden columns stay masked until revealed.

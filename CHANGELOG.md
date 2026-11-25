# Changelog

## 0.10.1

### Added

- Filter parent rows by how many related rows match: `posts: { _count: { gte: 5, where: { published: true } } }` on `findMany`, `updateMany`, and `deleteMany`.
- Stored generated columns: `.generated("expr")` emits `GENERATED ALWAYS AS (expr) STORED` on Postgres, SQLite, MySQL, and MariaDB. Migrations own the expression, and `db pull` round-trips it.

### Fixed

- Inverse one-to-one filters join the child's foreign key.
- MySQL and MariaDB `groupBy` quotes select columns as identifiers, and `OFFSET` without `LIMIT` is preceded by a max `LIMIT`.
- A primary-key change stays manual until real DDL exists, so the snapshot does not move ahead of the database.
- A down migration that would drop a manual change is refused, and `snapshot.json` is not restored.
- MySQL `createManyAndReturn({ skipDuplicates: true })` returns only rows that insert wrote.
- Composite foreign keys use every column for loads, counts, disconnect, and delete.
- A table rename emits an index rename when the SQL index name changes.
- Non-public schemas qualify index and enum DDL and move tables with `SET SCHEMA`.
- MySQL and MariaDB migrations record progress per statement and skip a `DROP DEFAULT` that `MODIFY` already applied.
- `findMany` and `findFirst` place nulls the same way as `paginate`.
- Nested writes continue after `set`, so a later `connect` or `create` still runs.
- The generated client imports column plugins before creating the client.
- Table renames pair by accessor instead of dropping and recreating the table.
- Array columns accept `has`, `hasEvery`, and `hasSome`. Appended enum values emit DDL.
- `searchTs` is limited to searchable text, and MySQL and MariaDB can declare a `FULLTEXT` index.

## 0.10.0

### Security

- `snapshot.json`, migration `snapshot.before.json`, and generated `manifest.ts` no longer include the datasource connection URL. Reading an older snapshot drops `url`. If that URL contains a password, NeoORM prints a one-time warning telling you to re-run generate and rotate the password. The warning does not include the URL.

### Breaking

- Postgres, MySQL, and MariaDB no longer connect with a URL stored on the manifest. Set `DATABASE_URL` (or `MYSQL_URL` / `MARIADB_URL`) or pass `connectionString`.
- SQLite persists a non-secret file path or `:memory:` as `sqlitePath`. Connection URLs are not copied into generated files.

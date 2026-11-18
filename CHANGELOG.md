# Changelog

## 0.10.0

### Security

- `snapshot.json`, migration `snapshot.before.json`, and generated `manifest.ts` no longer include the datasource connection URL. Reading an older snapshot drops `url`. If that URL contains a password, NeoORM prints a one-time warning telling you to re-run generate and rotate the password. The warning does not include the URL.

### Breaking

- Postgres, MySQL, and MariaDB no longer connect with a URL stored on the manifest. Set `DATABASE_URL` (or `MYSQL_URL` / `MARIADB_URL`) or pass `connectionString`.
- SQLite persists a non-secret file path or `:memory:` as `sqlitePath`. Connection URLs are not copied into generated files.

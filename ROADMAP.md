# Roadmap

**Current version:** v0.2.3
**Status:** 223 tests, typecheck clean, PostgreSQL dialect shipping.

---

## v0.3.x — Solidify the core

Polish what exists. No new features — fix sharp edges, close test gaps, harden validation.

- [X] **Config validation** — validate `datasource.provider` is `"postgresql"`, `enum` mode is one of `check`/`union`/`native`
- [X] **`loadConfig` dedup guard** — prevent double `tsx register()` call
- [X] **Composite PK guard** — `findById`/`updateById`/`deleteById` should give a clear error pointing to `findFirst`/`update`/`delete` as alternatives (currently they just throw)
- [X] **Test gaps** — `introspectToManifest` (0 tests), `formatQueryError` edge cases, `loadConfig` validation failures, `sqlBuilder`
- [X] **One-to-one type test** — add `@ts-expect-error` asserting that one-to-one inverse rejects `create: [{ ... }]` (array)
- [ ] **ID entropy** — `generateTextId` uses 32-bit prefix; document the limitation or bump to full UUID
- [ ] **Internal cleanup** — replace remaining `!` assertions in `diff-manifest.ts` and `cursor.ts` with proper guards

---

## v0.4.x — Middleware, soft delete, eager loading

Features that unlock the most real-world use cases.

- [ ] **Middleware / hooks** — `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. Plugin-based, async, chainable.
- [ ] **Soft delete** — `deletedAt` column convention. Auto-filter on reads. `findMany({ where: { deleted: false } })` shorthand. Opt-in via schema column modifier.
- [ ] **Eager loading batching** — coalesce relation `WHERE IN` queries into a single round-trip per relation. Currently N+1 per relation type.

---

## v0.5.x — Observability, query power

- [ ] **Query logging** — `db.$on("query", handler)` with SQL, params, duration
- [ ] **OpenTelemetry tracing** — spans per query with table and operation attributes
- [ ] **Window functions** — `ROW_NUMBER`, `RANK`, `DENSE_RANK` via query builder
- [ ] **CTEs** — `WITH` and `WITH RECURSIVE` via tagged templates or builder
- [ ] **Full-text search** — `tsvector`/`tsquery` operators in the Postgres dialect
- [ ] **`SELECT FOR UPDATE`** — row-level locking option on `findById`/`findFirst`

---

## v0.6.x — Schema & migrations

- [ ] **Database views** — define, generate, query (read-only)
- [ ] **Data migrations** — run custom SQL between schema changes
- [ ] **Migration dry-run** — preview SQL without applying
- [ ] **Generated / computed columns**
- [ ] **Column comments** — `COMMENT ON` from schema DSL

---

## v0.7.x — More databases

- [ ] **Dialect refactor** — extract `RETURNING`, row-value constructors, `ILIKE` from query layer into dialect methods
- [ ] **SQLite dialect** — local dev / testing, no external DB required
- [ ] **MySQL / MariaDB dialect**

---

## v0.8.x — Advanced deployment

- [ ] **Connection pool config** — expose min/max/idle timeout in client options
- [ ] **Read replica routing** — write to primary, read from replica
- [ ] **Multi-tenant schema isolation** — first-class tenant schema support in migrations and client

---

## v1.0.0 — Production ready

- [ ] **Seeding system** — `neoorm seed` with typed seed files
- [ ] **Plugin lifecycle hooks** — `beforeMigration`, `afterIntrospect`, `validateSchema`
- [ ] **Composite PK in paginate** — cursor pagination works with composite primary keys
- [ ] **Studio / admin UI** — `neoorm studio` for visual data browsing
- [ ] **Audit / changelog** — milestone checklist, migration guide from 0.x

---

## Themes

| Theme | Versions |
|-------|----------|
| **Harden** | 0.3.x |
| **Everyday features** | 0.4.x |
| **See what happens** | 0.5.x |
| **Schema evolution** | 0.6.x |
| **Beyond Postgres** | 0.7.x |
| **Production ops** | 0.8.x |
| **Ship** | 1.0.0 |

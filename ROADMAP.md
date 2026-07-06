# Roadmap

## v0.3.x — Middleware, soft delete, observability

Everyday features that unlock real-world patterns.

### Middleware & lifecycle
- [ ] **Middleware / hooks** — `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`. Plugin-based, async, chainable.
- [ ] **Query logging** — `db.$on("query", handler)` with SQL, params, duration
- [ ] **OpenTelemetry tracing** — spans per query with table and operation attributes

### Data lifecycle
- [ ] **Soft delete** — `deletedAt` column convention. Auto-filter on reads. `findMany({ where: { deleted: false } })` shorthand. Opt-in via schema column modifier.
- [ ] **Optimistic locking** — version column with CAS on write
- [x] **`findOrCreate` helper** — atomic find-or-create pattern

---

## v0.4.x — Query power, schema evolution

### Query capabilities
- [ ] **Window functions** — `ROW_NUMBER`, `RANK`, `DENSE_RANK` via query builder
- [ ] **CTEs** — `WITH` and `WITH RECURSIVE` via tagged templates or builder
- [ ] **Full-text search** — `tsvector`/`tsquery` operators in the Postgres dialect
- [ ] **`SELECT FOR UPDATE`** — row-level locking option on `findById`/`findFirst`

### Schema & migrations
- [ ] **Database views** — define, generate, query (read-only)
- [ ] **Data migrations** — run custom SQL between schema changes
- [ ] **Migration dry-run** — preview SQL without applying
- [ ] **Generated / computed columns**
- [ ] **Column comments** — `COMMENT ON` from schema DSL
- [ ] **Multi-schema migrations** — migrate across multiple PG schemas in one project

---

## v0.5.x — More databases

- [ ] **Dialect refactor** — extract `RETURNING`, row-value constructors, `ILIKE` from query layer into dialect methods
- [ ] **SQLite dialect** — local dev / testing, no external DB required
- [ ] **MySQL / MariaDB dialect**
- [ ] **Connection pool config** — expose min/max/idle timeout in client options
- [ ] **Batch insert auto-chunking** — split large `createMany` arrays into optimal batches
- [ ] **Prepared statement caching**

---

## v0.6.x — Production deployment

- [ ] **Seeding system** — `neoorm seed` with typed seed files
- [ ] **Read replica routing** — write to primary, read from replica
- [X] **Multi-tenant schema isolation** — `schema` option in `createNeoOrmClient` for runtime. Remaining: first-class support in migrations CLI.
- [ ] **Plugin lifecycle hooks** — `beforeMigration`, `afterIntrospect`, `validateSchema`
- [ ] **Composite PK in paginate** — cursor pagination works with composite primary keys
- [ ] **Studio / admin UI** — `neoorm studio` for visual data browsing
- [ ] **Audit / changelog** — milestone checklist, migration guide from 0.x

---

## v1.0.0

- [ ] All items from v0.3.x through v0.6.x are shipped
- [ ] Public API is stable — no breaking changes without a major bump
- [ ] Migration guide from v0.x to v1.0.0
- [ ] Changelog + release notes

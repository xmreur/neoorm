# NeoORM cross-ORM benchmarks

Performance comparisons against Drizzle, TypeORM, and Prisma live in the sibling
[`neoorm-benchmark`](../../neoorm-benchmark) repository.

## Setup

```bash
cd ../neoorm-benchmark
npm install
npm install ../neoorm   # link local neoorm checkout
```

## Run

```bash
npx tsx src/benchmark.ts --weight 30 --runs 10
```

- `--weight` — row multiplier for scaled operations (default: 1)
- `--runs` — batch runs averaged at the end (default: 1)

Results are written to `benchmark-results.md` in that repo.

## Pool sizing for concurrent benchmarks

Concurrent read/write operations issue `weight × 5` parallel queries. Configure
the client pool accordingly when benchmarking:

```typescript
createNeoOrmClient(manifest, {
  pool: { max: weight * 5 },
});
```

Default pool `max` is 20 when not specified.

## Operations (15)

insert, bulkInsert, findById, findAll, findWithFilter, findWithRelations,
update, updateMany, delete, deleteMany, complexQuery, transaction,
concurrentReads, concurrentWrites, paginate

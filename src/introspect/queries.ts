import type { Pool } from "pg";

export type TableRow = {
  table_name: string;
};

export type ColumnRow = {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  column_default: string | null;
};

export type FkRow = {
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
  constraint_name: string;
  delete_rule: string;
};

export type IndexRow = {
  index_name: string;
  column_name: string;
  is_unique: boolean;
  is_primary: boolean;
};

export type UniqueConstraintRow = {
  column_name: string;
  constraint_name: string;
};

export async function queryTables(pool: Pool): Promise<TableRow[]> {
  const result = await pool.query<TableRow>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '_neoorm_%'
    ORDER BY table_name
  `);
  return result.rows;
}

export async function queryColumns(
  pool: Pool,
  tableName: string,
): Promise<ColumnRow[]> {
  const result = await pool.query<ColumnRow>(
    `
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `,
    [tableName],
  );
  return result.rows;
}

export async function queryForeignKeys(
  pool: Pool,
  tableName: string,
): Promise<FkRow[]> {
  const result = await pool.query<FkRow>(
    `
    SELECT
      kcu.column_name,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name,
      tc.constraint_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
      AND rc.constraint_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = $1
  `,
    [tableName],
  );
  return result.rows;
}

export async function queryIndexes(
  pool: Pool,
  tableName: string,
): Promise<IndexRow[]> {
  const result = await pool.query<IndexRow>(
    `
    SELECT
      i.relname AS index_name,
      a.attname AS column_name,
      ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary
    FROM pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = $1
      AND NOT ix.indisprimary
    ORDER BY i.relname, array_position(ix.indkey, a.attnum)
  `,
    [tableName],
  );
  return result.rows;
}

export async function queryUniqueConstraints(
  pool: Pool,
  tableName: string,
): Promise<UniqueConstraintRow[]> {
  const result = await pool.query<UniqueConstraintRow>(
    `
    SELECT
      kcu.column_name,
      tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE'
      AND tc.table_schema = 'public'
      AND tc.table_name = $1
  `,
    [tableName],
  );
  return result.rows;
}

export async function queryPrimaryKeyColumns(
  pool: Pool,
  tableName: string,
): Promise<string[]> {
  const result = await pool.query<{ column_name: string }>(
    `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = $1
    ORDER BY kcu.ordinal_position
  `,
    [tableName],
  );
  return result.rows.map((row) => row.column_name);
}

export async function queryInstalledExtensions(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ extname: string }>(`
    SELECT extname
    FROM pg_extension
    WHERE extname NOT IN ('plpgsql')
    ORDER BY extname
  `);
  return result.rows.map((row) => row.extname);
}

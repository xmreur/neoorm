import type { Pool } from "pg";
import type { ManifestColumn, ManifestTable } from "../dialect/types.js";
import { toCamelCase } from "../utils/case.js";

type ColumnInfo = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

type FkInfo = {
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
};

export async function introspectPostgres(pool: Pool): Promise<string> {
  const tablesResult = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '_neoorm_%'
    ORDER BY table_name
  `);

  const lines: string[] = [
    `import {`,
    `  defineSchema,`,
    `  table,`,
    `  id,`,
    `  text,`,
    `  bool,`,
    `  int,`,
    `  timestamp,`,
    `  fk,`,
    `  index,`,
    `  primaryKey,`,
    `} from "neoorm/schema";`,
    ``,
    `export const schema = defineSchema({`,
  ];

  for (const { table_name } of tablesResult.rows) {
    const colsResult = await pool.query<ColumnInfo>(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table_name]);

    const fkResult = await pool.query<FkInfo>(`
      SELECT
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1
    `, [table_name]);

    const fkMap = new Map(
      fkResult.rows.map((r) => [r.column_name, r]),
    );

    const accessor = toCamelCase(table_name.endsWith("s") ? table_name : `${table_name}s`);
    lines.push(`  ${accessor}: table("${table_name}", {`);

    for (const col of colsResult.rows) {
      const tsName = toCamelCase(col.column_name);
      const fk = fkMap.get(col.column_name);

      if (fk) {
        const relName = tsName.replace(/Id$/, "");
        lines.push(
          `    ${tsName}: fk("${fk.foreign_table_name}.${fk.foreign_column_name}", {`,
          `      as: "${relName}",`,
          `      inverse: "${accessor}",`,
          `      nullable: ${col.is_nullable === "YES"},`,
          `    }),`,
        );
      } else if (col.column_name === "id") {
        lines.push(`    id: id.primary(),`);
      } else {
        const kind = pgTypeToKind(col.data_type);
        let def = `    ${tsName}: ${kind}()`;
        if (col.is_nullable === "NO") def += `.notNull()`;
        if (col.column_default?.includes("now()")) def += `.defaultNow()`;
        lines.push(`${def},`);
      }
    }

    lines.push(`  }),`);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join("\n");
}

function pgTypeToKind(dataType: string): string {
  switch (dataType) {
    case "boolean":
      return "bool";
    case "integer":
    case "bigint":
    case "smallint":
      return "int";
    case "timestamp with time zone":
    case "timestamp without time zone":
      return "timestamp";
    default:
      return "text";
  }
}

import type { Pool } from "pg";
import { toCamelCase, toSnakeCase } from "../utils/case.js";
import { findIntrospectColumnType } from "../plugins/registry.js";

type ColumnInfo = {
  column_name: string;
  data_type: string;
  udt_name: string;
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

  const pluginImports = new Set<string>();
  const pluginColumnImports = new Set<string>();
  let needsPostgisSideEffect = false;

  const tableBlocks: string[] = [];

  for (const { table_name } of tablesResult.rows) {
    const colsResult = await pool.query<ColumnInfo>(`
      SELECT column_name, data_type, udt_name, is_nullable, column_default
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
    const blockLines: string[] = [`  ${accessor}: table("${table_name}", {`];

    for (const col of colsResult.rows) {
      const tsName = toCamelCase(col.column_name);
      const fk = fkMap.get(col.column_name);

      if (fk) {
        const relName = tsName.replace(/Id$/, "");
        let def = [
          `    ${tsName}: fk("${fk.foreign_table_name}.${fk.foreign_column_name}", {`,
          `      as: "${relName}",`,
          `      inverse: "${accessor}",`,
          `      nullable: ${col.is_nullable === "YES"},`,
          `    })`,
        ].join("\n");
        def = appendMapModifier(def, tsName, col.column_name);
        blockLines.push(`${def},`);
      } else if (col.column_name === "id" && col.udt_name === "uuid") {
        const version = col.column_default?.includes("gen_random_uuid") ? 4 : 7;
        const def =
          version === 4
            ? `    id: uuid({ version: 4 }).primary(),`
            : `    id: uuid().primary(),`;
        blockLines.push(def);
      } else if (col.column_name === "id") {
        blockLines.push(`    id: id.primary(),`);
      } else {
        const pluginType = findIntrospectColumnType(col.data_type, col.udt_name);
        if (pluginType) {
          if (pluginType.kind === "geometry" || pluginType.kind === "geography" || pluginType.kind === "point") {
            needsPostgisSideEffect = true;
            pluginColumnImports.add(pluginType.kind === "geography" ? "geography" : pluginType.kind === "point" ? "point" : "geometry");
          }
          let def = `    ${tsName}: ${pluginType.kind}()`;
          if (pluginType.kind === "uuid") {
            const version = col.column_default?.includes("gen_random_uuid") ? 4 : 7;
            def =
              version === 4
                ? `    ${tsName}: uuid({ version: 4 })`
                : `    ${tsName}: uuid()`;
          }
          if (col.is_nullable === "NO") def += `.notNull()`;
          if (col.column_default?.includes("now()")) def += `.defaultNow()`;
          def = appendMapModifier(def, tsName, col.column_name);
          blockLines.push(`${def},`);
        } else {
          const kind = pgTypeToKind(col.data_type);
          let def = `    ${tsName}: ${kind}()`;
          if (col.is_nullable === "NO") def += `.notNull()`;
          if (col.column_default?.includes("now()")) def += `.defaultNow()`;
          def = appendMapModifier(def, tsName, col.column_name);
          blockLines.push(`${def},`);
        }
      }
    }

    blockLines.push(`  }),`);
    tableBlocks.push(blockLines.join("\n"));
  }

  const lines: string[] = [
    `import {`,
    `  defineSchema,`,
    `  table,`,
    `  id,`,
    `  text,`,
    `  bool,`,
    `  int,`,
    `  timestamp,`,
    `  uuid,`,
    `  fk,`,
    `  index,`,
    `  primaryKey,`,
    `} from "neoorm/schema";`,
  ];

  if (needsPostgisSideEffect) {
    lines.push(`import "neoorm/plugins/postgis";`);
  }

  if (pluginColumnImports.size > 0) {
    lines.push(`import { ${[...pluginColumnImports].sort().join(", ")} } from "neoorm/plugins/postgis";`);
  }

  for (const pluginImport of pluginImports) {
    lines.push(pluginImport);
  }

  lines.push(``, `export const schema = defineSchema({`);
  lines.push(...tableBlocks);
  lines.push(`});`, ``);

  return lines.join("\n");
}

function appendMapModifier(def: string, tsName: string, sqlName: string): string {
  if (sqlName === toSnakeCase(tsName)) {
    return def;
  }
  return `${def}.map("${sqlName}")`;
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

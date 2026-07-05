import type { Pool } from "pg";
import type { ColumnNaming } from "../schema/table.js";
import { resolveSqlColumnName, toCamelCase } from "../utils/case.js";
import { findIntrospectColumnType } from "../plugins/registry.js";
import {
  queryColumns,
  queryForeignKeys,
  queryTables,
} from "./queries.js";

export async function introspectPostgres(pool: Pool): Promise<string> {
  const tables = await queryTables(pool);

  const pluginImports = new Set<string>();
  const pluginColumnImports = new Set<string>();
  let needsPostgisSideEffect = false;

  const tableBlocks: string[] = [];

  for (const { table_name } of tables) {
    const cols = await queryColumns(pool, table_name);
    const fks = await queryForeignKeys(pool, table_name);

    const fkMap = new Map(fks.map((r) => [r.column_name, r]));
    const columnNaming = inferColumnNaming(cols.map((col) => col.column_name));

    const accessor = toCamelCase(
      table_name.endsWith("s") ? table_name : `${table_name}s`,
    );
    const blockLines: string[] = [`  ${accessor}: table("${table_name}", {`];

    for (const col of cols) {
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
        def = appendMapModifier(def, tsName, col.column_name, columnNaming);
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
          if (
            pluginType.kind === "geometry" ||
            pluginType.kind === "geography" ||
            pluginType.kind === "point"
          ) {
            needsPostgisSideEffect = true;
            pluginColumnImports.add(
              pluginType.kind === "geography"
                ? "geography"
                : pluginType.kind === "point"
                  ? "point"
                  : "geometry",
            );
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
          def = appendMapModifier(def, tsName, col.column_name, columnNaming);
          blockLines.push(`${def},`);
        } else {
          const kind = pgTypeToKind(col.data_type);
          let def = `    ${tsName}: ${kind}()`;
          if (col.is_nullable === "NO") def += `.notNull()`;
          if (col.column_default?.includes("now()")) def += `.defaultNow()`;
          def = appendMapModifier(def, tsName, col.column_name, columnNaming);
          blockLines.push(`${def},`);
        }
      }
    }

    if (columnNaming === "camelCase") {
      blockLines.push(`  }, { columnNaming: "camelCase" }),`);
    } else {
      blockLines.push(`  }),`);
    }
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
    lines.push(
      `import { ${[...pluginColumnImports].sort().join(", ")} } from "neoorm/plugins/postgis";`,
    );
  }

  for (const pluginImport of pluginImports) {
    lines.push(pluginImport);
  }

  lines.push(``, `export const schema = defineSchema({`);
  lines.push(...tableBlocks);
  lines.push(`});`, ``);

  return lines.join("\n");
}

function inferColumnNaming(columnNames: string[]): ColumnNaming {
  const allCamelCase = columnNames.every((sqlName) => toCamelCase(sqlName) === sqlName);
  const needsSnakeCaseMap = columnNames.some(
    (sqlName) => sqlName !== resolveSqlColumnName(toCamelCase(sqlName), "snakeCase"),
  );

  return allCamelCase && needsSnakeCaseMap ? "camelCase" : "snakeCase";
}

function appendMapModifier(
  def: string,
  tsName: string,
  sqlName: string,
  columnNaming: ColumnNaming,
): string {
  if (sqlName === resolveSqlColumnName(tsName, columnNaming)) {
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

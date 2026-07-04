export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, "_$1")
    .replace(/^_/, "")
    .toLowerCase();
}

export function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function mapRowKeys<T extends Record<string, unknown>>(
  row: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[toCamelCase(key)] = value;
  }
  return result as T;
}

export function mapRowsKeys<T extends Record<string, unknown>>(
  rows: Record<string, unknown>[],
): T[] {
  return rows.map((row) => mapRowKeys<T>(row));
}

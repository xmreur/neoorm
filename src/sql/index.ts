export {
  sqlTag,
  sqlId,
  compile,
  isSqlFragment,
  sqlFragment,
} from "./template.js";
export type { SqlFragment, CompiledSql, SqlValue } from "./template.js";

export { sqlBuilder } from "./builder.js";

import { sqlTag } from "./template.js";

/** Tagged template for parameterized SQL */
export const sql = sqlTag;

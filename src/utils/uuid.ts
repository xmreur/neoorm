import { randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import type { ManifestColumn } from "../dialect/types.js";

export type UuidVersion = 4 | 7;

const randomUUIDv7 = (crypto as typeof crypto & {
  randomUUIDv7?: () => string;
}).randomUUIDv7;

export function resolveUuidVersion(col: ManifestColumn): UuidVersion {
  return col.typeOptions?.version === 4 ? 4 : 7;
}

export function generateUuid(version: UuidVersion = 7): string {
  if (version === 4) {
    return randomUUID();
  }
  if (randomUUIDv7) {
    return randomUUIDv7();
  }
  return (randomUUID as (options: { version: 7 }) => string)({ version: 7 });
}

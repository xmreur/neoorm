import { randomBytes, randomUUID } from "node:crypto";
import * as crypto from "node:crypto";
import type { ManifestColumn } from "../dialect/types.js";

export type UuidVersion = 4 | 7;

const randomUUIDv7 = (crypto as typeof crypto & {
  randomUUIDv7?: () => string;
}).randomUUIDv7;

export function parseUuidVersion(value: string): UuidVersion {
  const versionNibble = Number.parseInt(value[14] ?? "0", 16);
  return versionNibble === 4 ? 4 : 7;
}

function generateUuidV7Fallback(): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
  return generateUuidV7Fallback();
}

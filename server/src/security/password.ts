import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const COST = 32768;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

async function derive(password: string, salt: Buffer, cost: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, { N: cost, r: 8, p: 1, maxmem: MAX_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, COST);
  return ["scrypt", String(COST), salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parts = stored?.split("$");
  const valid =
    parts?.length === 4 &&
    parts[0] === "scrypt" &&
    parts[1] === String(COST) &&
    /^[A-Za-z0-9_-]{22}$/.test(parts[2] ?? "") &&
    /^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? "");
  // Run an equivalent KDF even for an unknown username; do not reveal account existence by timing.
  const salt = valid ? Buffer.from(parts![2]!, "base64url") : Buffer.alloc(16, 0);
  const expected = valid ? Buffer.from(parts![3]!, "base64url") : Buffer.alloc(KEY_LENGTH, 0);
  const actual = await derive(password, salt, COST);
  return Boolean(valid && timingSafeEqual(actual, expected));
}

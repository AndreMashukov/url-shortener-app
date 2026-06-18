import { ulid } from "ulid";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const decodeUlid = (id: string): bigint => {
  let value = 0n;
  for (const ch of id.toUpperCase()) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx === -1) throw new Error("invalid ulid");
    value = value * 32n + BigInt(idx);
  }
  return value;
};

const bigintToBase62 = (n: bigint): string => {
  if (n === 0n) return BASE62[0];
  let chars = "";
  let value = n;
  while (value > 0n) {
    chars = BASE62[Number(value % 62n)] + chars;
    value /= 62n;
  }
  return chars;
};

const checksum2 = (payload: string): string => {
  let n = 0;
  for (const c of payload) {
    n = (n * 131 + BASE62.indexOf(c)) % (62 * 62);
  }
  return BASE62[Math.floor(n / 62)] + BASE62[n % 62];
};

/** ULID → Base62 (6 chars) + 2-char checksum. Total 8 chars. */
export const generateCode = (): string => {
  const payload = bigintToBase62(decodeUlid(ulid())).slice(0, 6).padEnd(6, BASE62[0]);
  return payload + checksum2(payload);
};

/** Validates checksum on 8-char generated codes; skips custom alias lengths. */
export const isValidChecksum = (code: string): boolean => {
  if (code.length !== 8) return true;
  const payload = code.slice(0, 6);
  const check = code.slice(6, 8);
  if (!/^[0-9A-Za-z]{6}[0-9A-Za-z]{2}$/.test(code)) return true;
  return checksum2(payload) === check;
};

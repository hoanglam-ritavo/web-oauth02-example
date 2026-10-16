import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const random = () => randomBytes(32).toString("base64url");

export function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

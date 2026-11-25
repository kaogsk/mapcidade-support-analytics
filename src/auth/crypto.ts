// Password hashing (scrypt) and HS256 JWTs with node:crypto only.
//
// Zero dependencies on purpose: the session token minted here is also verified by the
// OTHER support panels (this service is their identity provider), and one of them is a
// bare Node script without a package.json. The verifier has to be copy-pasteable.
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEYLEN = 32;

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const hash = scryptSync(String(password), salt, KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(String(password), salt, KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Hash checked when the user does NOT exist, so a login for an unknown username costs
 * the same time as a wrong password (no user enumeration by timing).
 */
export const DUMMY_HASH = hashPassword("not-a-real-password", "00000000000000000000000000000000");

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export interface JwtPayload {
  sub: string;
  name: string;
  /** Must change password (first access with a temporary password). */
  mc?: boolean;
  iat?: number;
  exp?: number;
}

export function signJwt(payload: JwtPayload, secret: string, opts: { expiresInSec?: number; now?: Date } = {}): string {
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const body: JwtPayload = { ...payload, iat, ...(opts.expiresInSec ? { exp: iat + opts.expiresInSec } : {}) };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

/** Payload if the signature (HS256 only) and expiry check out, else null. */
export function verifyJwt(token: string | null | undefined, secret: string, now = new Date()): JwtPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header?.alg !== "HS256") return null; // refuses alg=none and friends
    const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as JwtPayload;
    if (typeof payload?.sub !== "string") return null;
    if (payload.exp != null && Math.floor(now.getTime() / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Read one cookie from a raw Cookie header (values may contain '='). */
export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || null;
  }
  return null;
}

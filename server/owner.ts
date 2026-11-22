import { createHash, randomBytes } from "node:crypto";

/**
 * Per-browser owner cookie so each visitor's saved shows and uploaded tracks
 * stay private to their own browser, while built-in shows remain open to
 * everyone. No sign-in required.
 */
export const OWNER_COOKIE = "lightshow_owner";

/** Accepted cookie values: URL-safe base64 tokens minted by `mintOwnerToken`. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** One year in seconds. */
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

export function mintOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Hash the cookie token before storing in SQLite so raw cookies stay off disk. */
export function ownerIdFromToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Extract and hash the owner cookie from a `Cookie` header, or null if absent/invalid. */
export function readOwnerIdFromCookieHeader(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== OWNER_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (TOKEN_RE.test(value)) return ownerIdFromToken(value);
  }
  return null;
}

export function readOwnerId(request: Request): string | null {
  return readOwnerIdFromCookieHeader(request.headers.get("cookie"));
}

function isHttpsRequest(request: Request): boolean {
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded === "https") return true;
  if (forwarded === "http") return false;
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function formatOwnerCookie(token: string, secure: boolean): string {
  return `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`;
}

/**
 * Return the caller's `ownerId`, minting a new cookie when none is present.
 * Pass `setCookie` to `withOwnerCookie` on the response.
 */
export function ensureOwner(request: Request): {
  ownerId: string;
  setCookie?: string;
} {
  const existing = readOwnerId(request);
  if (existing) return { ownerId: existing };
  const token = mintOwnerToken();
  return {
    ownerId: ownerIdFromToken(token),
    setCookie: formatOwnerCookie(token, isHttpsRequest(request)),
  };
}

/** Attach `Set-Cookie` to a response when a new owner cookie was minted. */
export function withOwnerCookie(
  response: Response,
  setCookie?: string,
): Response {
  if (setCookie) response.headers.append("Set-Cookie", setCookie);
  return response;
}

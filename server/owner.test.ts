import { describe, expect, it } from "vitest";
import {
  ensureOwner,
  OWNER_COOKIE,
  ownerIdFromToken,
  readOwnerId,
  readOwnerIdFromCookieHeader,
  withOwnerCookie,
} from "./owner";

describe("owner cookie", () => {
  it("mints a fresh HttpOnly cookie when absent and hashes it for storage", () => {
    const req = new Request("http://localhost/api/shows");
    expect(readOwnerId(req)).toBeNull();

    const first = ensureOwner(req);
    expect(first.ownerId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.setCookie).toContain(`${OWNER_COOKIE}=`);
    expect(first.setCookie).toContain("HttpOnly");
    expect(first.setCookie).toContain("SameSite=Lax");
    expect(first.setCookie).not.toContain("Secure");

    const cookiePair = first.setCookie!.split(";")[0]!;
    const token = cookiePair.slice(`${OWNER_COOKIE}=`.length);
    expect(first.ownerId).toBe(ownerIdFromToken(token));

    const secondReq = new Request("http://localhost/api/shows", {
      headers: { cookie: `other=1; ${cookiePair}` },
    });
    const second = ensureOwner(secondReq);
    expect(second.ownerId).toBe(first.ownerId);
    expect(second.setCookie).toBeUndefined();
  });

  it("marks the cookie Secure over HTTPS or x-forwarded-proto: https", () => {
    const direct = ensureOwner(
      new Request("https://lightshow.party/api/shows"),
    );
    expect(direct.setCookie).toContain("Secure");

    const proxied = ensureOwner(
      new Request("http://localhost:8080/api/shows", {
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(proxied.setCookie).toContain("Secure");
  });

  it("ignores malformed or short cookie values", () => {
    expect(readOwnerIdFromCookieHeader(`${OWNER_COOKIE}=short`)).toBeNull();
    expect(
      readOwnerIdFromCookieHeader(`${OWNER_COOKIE}=${"!".repeat(40)}`),
    ).toBeNull();
    expect(readOwnerIdFromCookieHeader("")).toBeNull();
  });

  it("attaches Set-Cookie only when minted", () => {
    const res = withOwnerCookie(Response.json({ ok: true }), "a=b; HttpOnly");
    expect(res.headers.get("set-cookie")).toBe("a=b; HttpOnly");

    const untouched = withOwnerCookie(Response.json({ ok: true }), undefined);
    expect(untouched.headers.get("set-cookie")).toBeNull();
  });
});

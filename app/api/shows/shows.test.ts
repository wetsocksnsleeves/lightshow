import { describe, expect, it } from "vitest";
import type { Show } from "@/lib/types";
import { createShow as createDbShow, type ShowSummary } from "@/server/db";
import { MAX_JSON_BYTES } from "@/server/http";
import { mintOwnerToken, OWNER_COOKIE } from "@/server/owner";
import {
  MAX_CLIPS,
  MAX_POLYGON_POINTS,
  MAX_VENUE_SHAPES,
} from "@/server/show-validation";
import { withTempDataDir } from "@/server/testing/temp-data-dir";
import * as item from "./[id]/route";
import * as collection from "./route";

withTempDataDir();

const ALICE_COOKIE = `${OWNER_COOKIE}=${mintOwnerToken()}`;

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(
  method: string,
  body?: unknown,
  raw?: string,
  cookie: string | null = ALICE_COOKIE,
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/shows", {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

const venue: Show["venue"] = {
  shapes: [
    {
      id: "stalls",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.6 },
        { x: 0.1, y: 0.6 },
      ],
    },
  ],
};

async function create(body?: unknown): Promise<Show> {
  const res = await collection.POST(jsonRequest("POST", body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { show: Show }).show;
}

describe("/api/shows", () => {
  it("creates an empty show from an empty body", async () => {
    const show = await create();
    expect(show.name).toBe("Untitled show");
    expect(show.venue).toEqual({ shapes: [] });
    // No music yet, but a 30 s length to put clips in.
    expect(show.audio).toEqual({ fileId: "", durationMs: 30_000 });
    expect(show.clips).toEqual([]);
    expect(show.createdAt).toBe(show.updatedAt);
  });

  it("keeps the track title and artist, trimmed", async () => {
    const audio = {
      fileId: "6d0f6c5e-3b1a-4c8e-9a52-7f4e1b2d9c30.mp3",
      durationMs: 1_000,
      title: "  Song  ",
      artist: "",
    };
    const show = await create({ audio });
    expect(show.audio).toEqual({
      fileId: audio.fileId,
      durationMs: 1_000,
      title: "Song",
    });
    const res = await collection.POST(
      jsonRequest("POST", { audio: { ...audio, title: "x".repeat(201) } }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a show with a name and venue, and reads it back", async () => {
    const created = await create({ name: "  Finale  ", venue });
    expect(created.name).toBe("Finale");

    const res = await item.GET(jsonRequest("GET"), ctx(created.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { show: Show }).show).toEqual(created);
  });

  it("lists shows, most recently updated first", async () => {
    const a = await create({ name: "A" });
    const b = await create({ name: "B" });
    // Timestamps have millisecond resolution; make the update strictly later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await item.PUT(jsonRequest("PUT", { name: "A2" }), ctx(a.id));

    const res = collection.GET(jsonRequest("GET"));
    const { shows } = (await res.json()) as { shows: ShowSummary[] };
    const ids = shows.map((s) => s.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(shows.find((s) => s.id === a.id)).toMatchObject({ name: "A2" });
    expect(shows[0]).not.toHaveProperty("venue");
  });

  it("lists each show's duration and whether it has audio", async () => {
    const clip = (endMs: number) => ({
      id: `c${endMs}`,
      layer: 0,
      startMs: 0,
      endMs,
      color: "#ffffff",
      fadeInMs: 0,
      fadeOutMs: 0,
      shape: { kind: "fill" },
    });
    const empty = await create({ name: "Empty" });
    const withAudio = await create({
      audio: {
        fileId: "01234567-89ab-cdef-0123-456789abcdef.mp3",
        durationMs: 90_000,
      },
      clips: [clip(1_000)],
    });
    const clipsPastAudio = await create({
      audio: { fileId: "", durationMs: 1_000 },
      clips: [clip(5_000), clip(12_000)],
    });

    const res = collection.GET(jsonRequest("GET"));
    const { shows } = (await res.json()) as { shows: ShowSummary[] };
    const byId = new Map(shows.map((s) => [s.id, s]));
    expect(byId.get(empty.id)).toMatchObject({
      durationMs: 30_000,
      hasAudio: false,
    });
    expect(byId.get(withAudio.id)).toMatchObject({
      durationMs: 90_000,
      hasAudio: true,
    });
    expect(byId.get(clipsPastAudio.id)).toMatchObject({
      durationMs: 12_000,
      hasAudio: false,
    });
  });

  it("updates only the fields sent", async () => {
    const created = await create({ name: "Keep me" });
    const clip = {
      id: "c1",
      layer: 0,
      startMs: 0,
      endMs: 1000,
      color: "#ffffff",
      fadeInMs: 0,
      fadeOutMs: 100,
      shape: { kind: "fill" },
    };
    const res = await item.PUT(
      jsonRequest("PUT", { venue, clips: [clip] }),
      ctx(created.id),
    );
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { show: Show }).show;
    expect(updated.name).toBe("Keep me");
    expect(updated.venue).toEqual(venue);
    expect(updated.clips).toEqual([clip]);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const reread = await item.GET(jsonRequest("GET"), ctx(created.id));
    expect(((await reread.json()) as { show: Show }).show).toEqual(updated);
  });

  it("ignores attempts to change id and timestamps", async () => {
    const created = await create();
    const res = await item.PUT(
      jsonRequest("PUT", {
        id: "other",
        createdAt: "1970-01-01T00:00:00.000Z",
      }),
      ctx(created.id),
    );
    const updated = ((await res.json()) as { show: Show }).show;
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("rejects invalid shows with 400", async () => {
    const created = await create();
    const outside = {
      venue: {
        shapes: [
          {
            id: "s",
            points: [
              { x: 0, y: 0 },
              { x: 2, y: 0 },
              { x: 0, y: 1 },
            ],
          },
        ],
      },
    };
    const cases: unknown[] = [
      outside,
      { name: "" },
      { venue: { shapes: [{ id: "s", points: [{ x: 0, y: 0 }] }] } },
      { audio: { fileId: "../../etc/passwd", durationMs: 0 } },
      {
        clips: [
          {
            id: "c",
            layer: 0,
            startMs: 10,
            endMs: 5,
            color: "#fff",
            fadeInMs: 0,
            fadeOutMs: 0,
            shape: { kind: "fill" },
          },
        ],
      },
      [],
    ];
    for (const body of cases) {
      const res = await item.PUT(jsonRequest("PUT", body), ctx(created.id));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
    const bad = await item.PUT(
      new Request("http://localhost", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: ALICE_COOKIE },
        body: "{not json",
      }),
      ctx(created.id),
    );
    expect(bad.status).toBe(400);
  });

  it("deletes a show", async () => {
    const created = await create();
    const res = await item.DELETE(jsonRequest("DELETE"), ctx(created.id));
    expect(res.status).toBe(204);
    expect((await item.GET(jsonRequest("GET"), ctx(created.id))).status).toBe(
      404,
    );
    expect(
      (await item.DELETE(jsonRequest("DELETE"), ctx(created.id))).status,
    ).toBe(404);
  });

  it("returns 404 for unknown shows", async () => {
    expect((await item.GET(jsonRequest("GET"), ctx("nope"))).status).toBe(404);
    expect(
      (await item.PUT(jsonRequest("PUT", { name: "x" }), ctx("nope"))).status,
    ).toBe(404);
  });

  it("replies 415 unless the body is declared as JSON", async () => {
    const created = await create();
    for (const headers of [{}, { "content-type": "text/plain" }] as Record<
      string,
      string
    >[]) {
      const body = JSON.stringify({ name: "x" });
      const post = await collection.POST(
        new Request("http://localhost/api/shows", {
          method: "POST",
          headers,
          body,
        }),
      );
      expect(post.status).toBe(415);
      const put = await item.PUT(
        new Request("http://localhost/api/shows/x", {
          method: "PUT",
          headers,
          body,
        }),
        ctx(created.id),
      );
      expect(put.status).toBe(415);
    }
    const withCharset = await collection.POST(
      new Request("http://localhost/api/shows", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: "{}",
      }),
    );
    expect(withCharset.status).toBe(201);
  });

  it("refuses cross-site writes with 403", async () => {
    const created = await create({ name: "Target" });
    const crossSite: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example", host: "localhost:3000" },
      { origin: "null", host: "localhost:3000" },
      { origin: "http://localhost:3001", host: "localhost:3000" },
      { origin: "https://localhost:3000", host: "localhost:3000" },
    ];
    for (const extra of crossSite) {
      const headers = { "content-type": "application/json", ...extra };
      const body = JSON.stringify({ name: "pwned" });
      const label = JSON.stringify(extra);
      const post = await collection.POST(
        new Request("http://localhost/api/shows", {
          method: "POST",
          headers,
          body,
        }),
      );
      expect(post.status, label).toBe(403);
      const put = await item.PUT(
        new Request("http://localhost/api/shows/x", {
          method: "PUT",
          headers,
          body,
        }),
        ctx(created.id),
      );
      expect(put.status, label).toBe(403);
      const patch = await item.PATCH(
        new Request("http://localhost/api/shows/x", {
          method: "PATCH",
          headers,
          body,
        }),
        ctx(created.id),
      );
      expect(patch.status, label).toBe(403);
      const del = await item.DELETE(
        new Request("http://localhost/api/shows/x", {
          method: "DELETE",
          headers,
        }),
        ctx(created.id),
      );
      expect(del.status, label).toBe(403);
    }
    const still = await item.GET(jsonRequest("GET"), ctx(created.id));
    expect(((await still.json()) as { show: Show }).show.name).toBe("Target");
  });

  it("allows same-origin writes", async () => {
    const created = await create();
    const sameOrigin: Record<string, string>[] = [
      { "sec-fetch-site": "same-origin" },
      { origin: "http://localhost:3000", host: "localhost:3000" },
    ];
    for (const extra of sameOrigin) {
      const res = await item.PUT(
        new Request("http://localhost/api/shows/x", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: ALICE_COOKIE,
            ...extra,
          },
          body: JSON.stringify({ name: "ok" }),
        }),
        ctx(created.id),
      );
      expect(res.status, JSON.stringify(extra)).toBe(200);
    }
  });

  it("replies 413 to a JSON body over the limit", async () => {
    const big = JSON.stringify({ name: "x".repeat(MAX_JSON_BYTES) });
    const res = await collection.POST(jsonRequest("POST", undefined, big));
    expect(res.status).toBe(413);

    // Chunked, with no Content-Length to check up front.
    let sent = 0;
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_JSON_BYTES * 4) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const streamed = await collection.POST(
      new Request("http://localhost/api/shows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(sent).toBeLessThan(MAX_JSON_BYTES + 4 * chunk.byteLength);
  });

  it("rejects shows over the size caps with 400", async () => {
    const created = await create();
    const tri = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    const clip = {
      id: "c",
      layer: 0,
      startMs: 0,
      endMs: 10,
      color: "#ffffff",
      fadeInMs: 0,
      fadeOutMs: 0,
      shape: { kind: "fill" },
    };
    const manyPoints = Array.from(
      { length: MAX_POLYGON_POINTS + 1 },
      (_, i) => ({
        x: (i % 10) / 10,
        y: Math.floor(i / 10) / 100,
      }),
    );
    const cases = [
      {
        venue: {
          shapes: Array.from({ length: MAX_VENUE_SHAPES + 1 }, (_, i) => ({
            id: `s${i}`,
            points: tri,
          })),
        },
      },
      { venue: { shapes: [{ id: "s", points: manyPoints }] } },
      {
        clips: Array.from({ length: MAX_CLIPS + 1 }, (_, i) => ({
          ...clip,
          id: `c${i}`,
        })),
      },
      { clips: [{ ...clip, shape: { kind: "polygon", points: manyPoints } }] },
    ];
    for (const body of cases) {
      const res = await item.PUT(jsonRequest("PUT", body), ctx(created.id));
      expect(res.status).toBe(400);
    }
    // At the caps is fine.
    const atCap = await item.PUT(
      jsonRequest("PUT", {
        clips: Array.from({ length: MAX_CLIPS }, (_, i) => ({
          ...clip,
          id: `c${i}`,
        })),
      }),
      ctx(created.id),
    );
    expect(atCap.status).toBe(200);
  });

  it("refuses unknown Host headers with 403, reads included", async () => {
    const created = await create();
    const evil = { host: "rebind.evil.example" };
    const get = (headers: Record<string, string>) =>
      new Request("http://localhost/api/shows", { headers });
    expect(collection.GET(get(evil)).status).toBe(403);
    expect((await item.GET(get(evil), ctx(created.id))).status).toBe(403);
    const post = await collection.POST(
      new Request("http://localhost/api/shows", {
        method: "POST",
        headers: { ...evil, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(post.status).toBe(403);
    expect((await item.DELETE(get(evil), ctx(created.id))).status).toBe(403);
  });

  it("allows loopback hosts, the PUBLIC_URL host and ALLOWED_HOSTS", async () => {
    const saved = {
      PUBLIC_URL: process.env.PUBLIC_URL,
      ALLOWED_HOSTS: process.env.ALLOWED_HOSTS,
    };
    process.env.PUBLIC_URL = "https://show.trycloudflare.com";
    process.env.ALLOWED_HOSTS = "192.168.1.20, lightshow.local";
    try {
      for (const host of [
        "localhost:3000",
        "127.0.0.1:41234",
        "[::1]:3000",
        "show.trycloudflare.com",
        "192.168.1.20:3000",
        "LIGHTSHOW.local",
      ]) {
        const res = collection.GET(
          new Request("http://localhost/api/shows", { headers: { host } }),
        );
        expect(res.status, host).toBe(200);
      }
      // A write from the tunnel origin passes the same-origin check.
      const res = await collection.POST(
        new Request("http://localhost/api/shows", {
          method: "POST",
          headers: {
            host: "show.trycloudflare.com",
            origin: "https://show.trycloudflare.com",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(res.status).toBe(201);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("isolates saved shows per browser and hides legacy unowned shows", async () => {
    const carolCookie = `${OWNER_COOKIE}=${mintOwnerToken()}`;
    const bobCookie = `${OWNER_COOKIE}=${mintOwnerToken()}`;

    // Legacy show with no owner (e.g. created before owner cookies existed).
    const legacy = createDbShow({ name: "Legacy show" }, null);

    const carolRes = await collection.POST(
      jsonRequest(
        "POST",
        { name: "Carol private show" },
        undefined,
        carolCookie,
      ),
    );
    expect(carolRes.status).toBe(201);
    const carolShow = ((await carolRes.json()) as { show: Show }).show;

    const bobRes = await collection.POST(
      jsonRequest("POST", { name: "Bob private show" }, undefined, bobCookie),
    );
    expect(bobRes.status).toBe(201);
    const bobShow = ((await bobRes.json()) as { show: Show }).show;

    // Each browser sees only its own shows.
    const carolList = (await collection
      .GET(jsonRequest("GET", undefined, undefined, carolCookie))
      .json()) as { shows: ShowSummary[] };
    expect(carolList.shows.map((s) => s.id)).toEqual([carolShow.id]);

    const bobList = (await collection
      .GET(jsonRequest("GET", undefined, undefined, bobCookie))
      .json()) as { shows: ShowSummary[] };
    expect(bobList.shows.map((s) => s.id)).toEqual([bobShow.id]);

    // A fresh browser sees no saved shows and gets a fresh HttpOnly cookie.
    const freshRes = collection.GET(new Request("http://localhost/api/shows"));
    expect(freshRes.headers.get("set-cookie")).toContain(`${OWNER_COOKIE}=`);
    const freshList = (await freshRes.json()) as { shows: ShowSummary[] };
    expect(freshList.shows).toEqual([]);

    // Bob cannot read, update or delete Carol's show (or legacy shows).
    expect(
      (
        await item.GET(
          jsonRequest("GET", undefined, undefined, bobCookie),
          ctx(carolShow.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await item.PUT(
          jsonRequest("PUT", { name: "Stolen" }, undefined, bobCookie),
          ctx(carolShow.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await item.DELETE(
          jsonRequest("DELETE", undefined, undefined, bobCookie),
          ctx(carolShow.id),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await item.GET(
          jsonRequest("GET", undefined, undefined, carolCookie),
          ctx(legacy.id),
        )
      ).status,
    ).toBe(404);
  });
});

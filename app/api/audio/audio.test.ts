import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIXTAPE_AUDIO_FILE_ID } from "@/lib/mixtape-show";
import type { Show } from "@/lib/types";
import { MAX_AUDIO_BYTES } from "@/server/audio-store";
import { createShow } from "@/server/db";
import { mintOwnerToken, OWNER_COOKIE, ownerIdFromToken } from "@/server/owner";
import { withTempDataDir } from "@/server/testing/temp-data-dir";
import * as cover from "./[fileId]/cover/route";
import * as item from "./[fileId]/route";
import * as upload from "./route";

const dataDir = withTempDataDir();

const ALICE_TOKEN = mintOwnerToken();
const ALICE_OWNER = ownerIdFromToken(ALICE_TOKEN);
const ALICE_COOKIE = `${OWNER_COOKIE}=${ALICE_TOKEN}`;
const BOB_TOKEN = mintOwnerToken();
const BOB_OWNER = ownerIdFromToken(BOB_TOKEN);
const BOB_COOKIE = `${OWNER_COOKIE}=${BOB_TOKEN}`;

function uploadRequest(
  file: File | string | null,
  cookie: string | null = ALICE_COOKIE,
): Request {
  const form = new FormData();
  if (file !== null) form.set("file", file);
  return new Request("http://localhost/api/audio", {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
  });
}

function getRequest(
  range?: string,
  cookie: string | null = ALICE_COOKIE,
): Request {
  const headers: Record<string, string> = {};
  if (range) headers.range = range;
  if (cookie) headers.cookie = cookie;
  return new Request("http://localhost/api/audio/x", { headers });
}

function ctx(fileId: string) {
  return { params: Promise.resolve({ fileId }) };
}

// 256 distinct bytes, so any slice is easy to check.
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

async function uploadMp3(): Promise<string> {
  const res = await upload.POST(
    uploadRequest(new File([bytes], "track.mp3", { type: "audio/mpeg" })),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { fileId: string; url: string };
  expect(body.url).toBe(`/api/audio/${body.fileId}`);
  return body.fileId;
}

describe("GET /api/audio", () => {
  const pause = () => new Promise((r) => setTimeout(r, 5));

  it("lists the music used by shows, newest first, once per file", async () => {
    // An mp3 whose only tag is a title, saved by a show without one.
    const text = [0, ...Array.from("From Tags", (c) => c.charCodeAt(0))];
    const tagged = Uint8Array.from([
      ...Array.from("ID3", (c) => c.charCodeAt(0)),
      ...[3, 0, 0, 0, 0, 0, 10 + text.length],
      ...Array.from("TIT2", (c) => c.charCodeAt(0)),
      ...[0, 0, 0, text.length, 0, 0],
      ...text,
    ]);
    const up = await upload.POST(
      uploadRequest(new File([tagged], "t.mp3", { type: "audio/mpeg" })),
    );
    const taggedId = ((await up.json()) as { fileId: string }).fileId;
    const a = await uploadMp3();
    const b = await uploadMp3();

    createShow(
      { audio: { fileId: a, durationMs: 1000, title: "Song A" } },
      ALICE_OWNER,
    );
    await pause();
    createShow({ audio: { fileId: taggedId, durationMs: 3000 } }, ALICE_OWNER);
    await pause();
    createShow(
      { audio: { fileId: b, durationMs: 2000, artist: "B" } },
      ALICE_OWNER,
    );
    await pause();
    createShow({ audio: { fileId: "", durationMs: 5000 } }, ALICE_OWNER);
    await pause();
    // Another user's show must not appear in Alice's recent tracks.
    const bobFile = await (
      await upload.POST(
        uploadRequest(
          new File([bytes], "bob.mp3", { type: "audio/mpeg" }),
          BOB_COOKIE,
        ),
      )
    ).json();
    createShow(
      {
        audio: {
          fileId: (bobFile as { fileId: string }).fileId,
          durationMs: 4000,
          title: "Bob Secret",
        },
      },
      BOB_OWNER,
    );
    await pause();
    // A newer show reuses A without a title: the older title still shows.
    createShow({ audio: { fileId: a, durationMs: 1000 } }, ALICE_OWNER);

    const res = await upload.GET(
      new Request("http://localhost/api/audio", {
        headers: { cookie: ALICE_COOKIE },
      }),
    );
    expect(res.status).toBe(200);
    const { tracks } = (await res.json()) as { tracks: Show["audio"][] };
    expect(tracks).toEqual([
      { fileId: a, durationMs: 1000, title: "Song A" },
      { fileId: b, durationMs: 2000, artist: "B" },
      { fileId: taggedId, durationMs: 3000, title: "From Tags" },
    ]);

    // Bob sees only his own track, not Alice's.
    const bobRes = await upload.GET(
      new Request("http://localhost/api/audio", {
        headers: { cookie: BOB_COOKIE },
      }),
    );
    expect(bobRes.status).toBe(200);
    expect(
      ((await bobRes.json()) as { tracks: Show["audio"][] }).tracks,
    ).toEqual([
      {
        fileId: (bobFile as { fileId: string }).fileId,
        durationMs: 4000,
        title: "Bob Secret",
      },
    ]);
  });
});

describe("/api/audio/<fileId>/cover", () => {
  it("serves the cover embedded in the audio file", async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7];
    const apic = [
      0,
      ...Array.from("image/png", (c) => c.charCodeAt(0)),
      0,
      3,
      0,
      ...png,
    ];
    const tag = Uint8Array.from([
      ...Array.from("ID3", (c) => c.charCodeAt(0)),
      3,
      0,
      0,
      0,
      0,
      0,
      10 + apic.length,
      ...Array.from("APIC", (c) => c.charCodeAt(0)),
      0,
      0,
      0,
      apic.length,
      0,
      0,
      ...apic,
    ]);
    const up = await upload.POST(
      uploadRequest(new File([tag, bytes], "t.mp3", { type: "audio/mpeg" })),
    );
    const { fileId } = (await up.json()) as { fileId: string };
    const res = await cover.GET(getRequest(), ctx(fileId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      Uint8Array.from(png),
    );
  });

  it("replies 404 when the file has no cover or doesn't exist", async () => {
    const fileId = await uploadMp3();
    expect((await cover.GET(getRequest(), ctx(fileId))).status).toBe(404);
    const missing = "00000000-0000-0000-0000-000000000000.mp3";
    expect((await cover.GET(getRequest(), ctx(missing))).status).toBe(404);
    expect((await cover.GET(getRequest(), ctx("../x"))).status).toBe(404);
  });
});

describe("/api/audio", () => {
  it("stores the upload under data/audio/<id>.<ext>", async () => {
    const fileId = await uploadMp3();
    expect(fileId).toMatch(/\.mp3$/);
    const stored = fs.readFileSync(path.join(dataDir(), "audio", fileId));
    expect(new Uint8Array(stored)).toEqual(bytes);
  });

  it("serves the whole file with the right content type", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(getRequest(), ctx(fileId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("256");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("serves byte ranges with 206", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(getRequest("bytes=10-19"), ctx(fileId));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(res.headers.get("content-length")).toBe("10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      bytes.slice(10, 20),
    );

    const tail = await item.GET(getRequest("bytes=-6"), ctx(fileId));
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(250));
  });

  it("replies 416 to a range past the end", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(getRequest("bytes=300-"), ctx(fileId));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */256");
  });

  it("serves wav and m4a with their content types", async () => {
    for (const [name, type] of [
      ["a.wav", "audio/wav"],
      ["a.m4a", "audio/mp4"],
    ] as const) {
      const res = await upload.POST(uploadRequest(new File([bytes], name)));
      const { fileId } = (await res.json()) as { fileId: string };
      const got = await item.GET(getRequest(), ctx(fileId));
      expect(got.headers.get("content-type")).toBe(type);
      await got.arrayBuffer();
    }
  });

  it("rejects missing, empty and unsupported uploads", async () => {
    expect((await upload.POST(uploadRequest(null))).status).toBe(400);
    expect((await upload.POST(uploadRequest("not a file"))).status).toBe(400);
    expect(
      (await upload.POST(uploadRequest(new File([], "a.mp3")))).status,
    ).toBe(400);
    expect(
      (
        await upload.POST(
          uploadRequest(new File([bytes], "a.ogg", { type: "audio/ogg" })),
        )
      ).status,
    ).toBe(415);
    const notForm = new Request("http://localhost/api/audio", {
      method: "POST",
      body: "x",
    });
    expect((await upload.POST(notForm)).status).toBe(400);
  });

  it("returns 404 for unknown or invalid ids", async () => {
    const missing = "0b6f4c1e-2a7d-4b8e-9f00-123456789abc.mp3";
    expect((await item.GET(getRequest(), ctx(missing))).status).toBe(404);
    expect(
      (await item.GET(getRequest(), ctx("..%2Flightshow.db"))).status,
    ).toBe(404);
  });

  it("replies 413 to an oversized chunked upload without reading all of it", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const sendLimit = MAX_AUDIO_BYTES * 4;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= sendLimit) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    // No Content-Length: the body streams in chunks of unknown total size.
    const request = new Request("http://localhost/api/audio", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const res = await upload.POST(request);
    expect(res.status).toBe(413);
    // Stopped within a few chunks of the cap, not at the end of the stream.
    expect(sent).toBeLessThan(MAX_AUDIO_BYTES + 4 * chunk.byteLength);
  });

  it("replies 413 when Content-Length is over the cap", async () => {
    const request = new Request("http://localhost/api/audio", {
      method: "POST",
      headers: { "content-length": String(MAX_AUDIO_BYTES + 1) },
    });
    expect((await upload.POST(request)).status).toBe(413);
  });

  it("refuses cross-site uploads with 403", async () => {
    const crossSite: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example", host: "localhost:3000" },
    ];
    for (const headers of crossSite) {
      const form = new FormData();
      form.set("file", new File([bytes], "a.mp3"));
      const res = await upload.POST(
        new Request("http://localhost/api/audio", {
          method: "POST",
          headers,
          body: form,
        }),
      );
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("blocks other browsers from reading uploaded audio or cover art, while built-in tracks stay public", async () => {
    const fileId = await uploadMp3();
    // Bob and anonymous visitors get 404 for Alice's uploaded file.
    expect(
      (await item.GET(getRequest(undefined, BOB_COOKIE), ctx(fileId))).status,
    ).toBe(404);
    expect(
      (await item.GET(getRequest(undefined, null), ctx(fileId))).status,
    ).toBe(404);
    expect(
      (await cover.GET(getRequest(undefined, BOB_COOKIE), ctx(fileId))).status,
    ).toBe(404);

    // Alice's uploaded audio is cached privately, not publicly.
    const aliceRes = await item.GET(
      getRequest(undefined, ALICE_COOKIE),
      ctx(fileId),
    );
    expect(aliceRes.status).toBe(200);
    expect(aliceRes.headers.get("cache-control")).toContain("private");
    await aliceRes.arrayBuffer();

    // Built-in audio remains publicly accessible with no cookie.
    const builtinRes = await item.GET(
      getRequest("bytes=0-15", null),
      ctx(MIXTAPE_AUDIO_FILE_ID),
    );
    expect(builtinRes.status).toBe(206);
    expect(builtinRes.headers.get("cache-control")).toContain("public");
    await builtinRes.arrayBuffer();
  });

  it("refuses unknown Host headers with 403", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(
      new Request("http://localhost/api/audio/x", {
        headers: { host: "rebind.evil.example" },
      }),
      ctx(fileId),
    );
    expect(res.status).toBe(403);
    const form = new FormData();
    form.set("file", new File([bytes], "a.mp3"));
    const up = await upload.POST(
      new Request("http://localhost/api/audio", {
        method: "POST",
        headers: { host: "rebind.evil.example" },
        body: form,
      }),
    );
    expect(up.status).toBe(403);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  ParticipantClient,
  participantScreen,
  type KeyValueStorage,
  type ParticipantClientDeps,
  type SocketLike,
} from "@/app/j/[code]/participant-client";
import {
  HostClient,
  createHostedSession,
  hostStorageKey,
  type HostClientDeps,
} from "@/app/sessions/host-client";
import type { ClockSyncEnv } from "@/lib/clock-sync";
import { rawUpgrade } from "./testing/raw-upgrade";
import { withTempDataDir } from "./testing/temp-data-dir";
import { TestClient } from "./testing/ws-client";
import { spawnServer, type SpawnedServer } from "./testing/spawn-server";

let server: SpawnedServer;

// Registered before spawnServer, so the child inherits LIGHTSHOW_DATA_DIR.
withTempDataDir();

beforeAll(async () => {
  server = await spawnServer();
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(String(data)));
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("socket closed")));
  });
}

async function expectHmrSocketWorks(): Promise<void> {
  const url = server.httpUrl.replace("http", "ws") + "/_next/hmr";
  const ws = await openSocket(url);
  const first = JSON.parse(await nextMessage(ws)) as { type: string };
  expect(typeof first.type).toBe("string");
  ws.close();
}

describe("custom server", () => {
  it("serves the home page over HTTP", async () => {
    const res = await fetch(`${server.httpUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("lightshow");
  }, 60_000);

  it("leaves the Next HMR socket working after a page load", async () => {
    await expectHmrSocketWorks();
    expect(server.output()).not.toContain("Error handling upgrade request");
  }, 30_000);

  it("runs the join flow over /ws", async () => {
    const host = await TestClient.connect(server.wsUrl);
    host.send({ type: "host", showId: "test" });
    const { code } = await host.next("session");

    const phone = await TestClient.connect(server.wsUrl);
    phone.send({ type: "join", code });
    await phone.next("welcome");
    phone.send({ type: "seat", x: 0.5, y: 0.5 });
    phone.send({ type: "ready" });
    expect((await phone.next("schedule")).events.length).toBeGreaterThan(0);

    await Promise.all([host.close(), phone.close()]);
  });

  it("accepts audio uploads over proxy.ts's 10 MB body buffer", async () => {
    // A file proxy.ts matches has its body cut at 10 MB without an error,
    // so the upload route must not be matched by it.
    const size = 12 * 1024 * 1024;
    const form = new FormData();
    form.set("file", new File([new Uint8Array(size)], "big.wav"));
    const res = await fetch(`${server.httpUrl}/api/audio`, {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).toContain("lightshow_owner=");
    const { url } = (await res.json()) as { url: string };
    const stored = await fetch(`${server.httpUrl}${url}`, {
      headers: { range: "bytes=0-0", cookie },
    });
    expect(stored.headers.get("content-range")).toBe(`bytes 0-0/${size}`);
    // Without the uploader's cookie, another visitor cannot fetch the upload.
    const other = await fetch(`${server.httpUrl}${url}`, {
      headers: { range: "bytes=0-0" },
    });
    expect(other.status).toBe(404);
  }, 60_000);

  it("rejects upgrades on unknown paths and closes the socket", async () => {
    const result = await rawUpgrade(server.port, "/nope");
    expect(result.response).toBe("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(result.closed).toBe(true);
    expect(server.output()).not.toContain("Error handling upgrade request");
  });
});

/** Real clock and timers in Node, for `ClockSync`. */
function nodeClockEnv(): ClockSyncEnv {
  type Handle = ReturnType<typeof setTimeout>;
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as Handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as Handle),
  };
}

/** Deps that drive `ParticipantClient` with Node's built-in WebSocket. */
function nodeParticipantDeps(url: string): {
  deps: ParticipantClientDeps;
  sockets: SocketLike[];
} {
  const sockets: SocketLike[] = [];
  const map = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return {
    sockets,
    deps: {
      wsUrl: url,
      createSocket: (u) => {
        const socket = new globalThis.WebSocket(u);
        sockets.push(socket);
        return socket;
      },
      storage,
      random: () => 0,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      connectDelayMaxMs: 800,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      clock: nodeClockEnv(),
    },
  };
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("participant page", () => {
  it("serves /j/<code> with 200", async () => {
    const host = await TestClient.connect(server.wsUrl);
    host.send({ type: "host", showId: "test" });
    const { code } = await host.next("session");
    const res = await fetch(`${server.httpUrl}/j/${code}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connecting");
    await host.close();
  }, 60_000);

  it("ParticipantClient joins, seats, readies, and resumes after a drop", async () => {
    const host = await TestClient.connect(server.wsUrl);
    host.send({ type: "host", showId: "test" });
    const { code } = await host.next("session");

    const { deps, sockets } = nodeParticipantDeps(server.wsUrl);
    const client = new ParticipantClient(code.toLowerCase(), deps);
    client.start();
    try {
      await until(() => participantScreen(client.getSnapshot()) === "seat");
      const id = client.getSnapshot().participantId;
      expect(client.getSnapshot().venue?.shapes).toHaveLength(1);

      client.setSeat({ x: 0.3, y: 0.6 });
      client.ready();
      await until(() => participantScreen(client.getSnapshot()) === "standby");

      // The host's throttled summary reaches standby with the seat.
      let latest = await host.next("participants");
      while (latest.list.find((p) => p.id === id)?.state !== "standby") {
        latest = await host.next("participants");
      }
      // Positions reach the host fitted to the crowd (SPEC 2.5), so not as sent.
      expect(latest.list).toContainEqual(
        expect.objectContaining({
          id,
          x: expect.any(Number),
          y: expect.any(Number),
          state: "standby",
        }),
      );
      // Standby came from a real handshake: the clock is ready and reported.
      expect(client.clock.ready).toBe(true);
      const summary = latest.list.find((p) => p.id === id)!;
      expect(summary.rttMs).toEqual(expect.any(Number));
      expect(summary.degraded).toBe(false);

      // Drop the socket: the client reconnects and resumes the same id.
      sockets[0]!.close();
      await until(() => sockets.length === 2);
      await until(
        () =>
          client.getSnapshot().connection === "open" &&
          client.getSnapshot().schedule !== null,
      );
      expect(client.getSnapshot().participantId).toBe(id);
      expect(participantScreen(client.getSnapshot())).toBe("standby");
      latest = await host.next("participants");
      while (latest.list.find((p) => p.id === id)?.state !== "standby") {
        latest = await host.next("participants");
      }
      expect(latest.list).toHaveLength(1);
    } finally {
      client.stop();
      await host.close();
    }
  });

  it("ParticipantClient shows not-found for an unknown code", async () => {
    const { deps } = nodeParticipantDeps(server.wsUrl);
    const client = new ParticipantClient("ZZZZZZ", deps);
    client.start();
    await until(() => client.getSnapshot().fatal !== null);
    expect(participantScreen(client.getSnapshot())).toBe("not-found");
    expect(client.getSnapshot().connection).toBe("closed");
  });
});

/** Deps that drive `HostClient` with Node's built-in WebSocket. */
function nodeHostDeps(url: string): HostClientDeps {
  const map = new Map<string, string>();
  return {
    wsUrl: url,
    createSocket: (u) => new globalThis.WebSocket(u),
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
    random: () => 0,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    reconnectBaseMs: 50,
    reconnectMaxMs: 200,
    clock: nodeClockEnv(),
  };
}

describe("host page", () => {
  it("creates a session and serves /sessions/<code>/host with 200", async () => {
    const deps = nodeHostDeps(server.wsUrl);
    const code = await createHostedSession("test", deps);
    expect(deps.storage!.getItem(hostStorageKey(code))).toBeTruthy();
    const res = await fetch(`${server.httpUrl}/sessions/${code}/host`);
    expect(res.status).toBe(200);
  }, 60_000);

  it("HostClient re-attaches with its token and sees participants reach standby", async () => {
    const deps = nodeHostDeps(server.wsUrl);
    const code = await createHostedSession("test", deps);
    const host = new HostClient(code, deps);
    host.start();
    const phone = await TestClient.connect(server.wsUrl);
    try {
      await until(() => host.getSnapshot().session !== null);
      expect(host.getSnapshot().session?.joinUrl).toMatch(
        new RegExp(`/j/${code}$`),
      );

      phone.send({ type: "join", code });
      const { participantId } = await phone.next("welcome");
      await until(() =>
        host.getSnapshot().participants.some((p) => p.id === participantId),
      );
      phone.send({ type: "seat", x: 0.7, y: 0.4 });
      phone.send({ type: "ready" });
      await phone.next("schedule");
      // Schedule in, clock not reported: syncing, not standby (SPEC 4.4).
      await until(
        () => host.getSnapshot().participants[0]?.state === "syncing",
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(host.getSnapshot().participants[0]?.state).toBe("syncing");

      phone.send({ type: "clock", ready: true, degraded: true, rttMs: 180 });
      await until(
        () => host.getSnapshot().participants[0]?.state === "standby",
      );
      expect(host.getSnapshot().participants).toEqual([
        {
          id: participantId,
          // Fitted to the crowd (SPEC 2.5), so not as sent.
          x: expect.any(Number),
          y: expect.any(Number),
          state: "standby",
          rttMs: 180,
          degraded: true,
        },
      ]);
      // The host's own clock syncs against the same server.
      await until(() => host.getSnapshot().clockReady);
      expect(host.clock.bestRtt).toBeLessThan(400);

      await phone.close();
      await until(
        () => host.getSnapshot().participants[0]?.state === "disconnected",
      );
    } finally {
      host.stop();
      await phone.close();
    }
  });

  it("Start reaches a real ParticipantClient with the host's T0, and Stop clears it", async () => {
    const hostDeps = nodeHostDeps(server.wsUrl);
    const code = await createHostedSession("test", hostDeps);
    const host = new HostClient(code, hostDeps);
    host.start();
    const { deps } = nodeParticipantDeps(server.wsUrl);
    const phone = new ParticipantClient(code, deps);
    phone.start();
    try {
      await until(() => host.getSnapshot().session !== null);
      // Nobody in standby yet: refused.
      host.startShow();
      await until(() => host.getSnapshot().lastError !== null);
      expect(host.getSnapshot().T0).toBeNull();

      await until(() => participantScreen(phone.getSnapshot()) === "seat");
      phone.setSeat({ x: 0.5, y: 0.5 });
      phone.ready();
      await until(() => participantScreen(phone.getSnapshot()) === "standby");
      await until(() =>
        host.getSnapshot().participants.some((p) => p.state === "standby"),
      );
      expect(host.startShow()).toBe(true);
      await until(() => phone.getSnapshot().T0 !== null);
      expect(phone.getSnapshot().T0).toBe(host.getSnapshot().T0);
      expect(participantScreen(phone.getSnapshot())).toBe("playing");
      // T0 is START_LEAD_MS (900) ahead of the server clock at Start.
      const lead = phone.getSnapshot().T0! - phone.clock.serverNow();
      expect(lead).toBeGreaterThan(500);
      expect(lead).toBeLessThanOrEqual(900 + 50);
      await until(() =>
        host.getSnapshot().participants.some((p) => p.state === "playing"),
      );

      host.stopShow();
      await until(() => phone.getSnapshot().T0 === null);
      expect(participantScreen(phone.getSnapshot())).toBe("standby");
    } finally {
      phone.stop();
      host.stop();
    }
  });

  it("HostClient without the right token is not the host", async () => {
    const creator = nodeHostDeps(server.wsUrl);
    const code = await createHostedSession("test", creator);

    const noToken = new HostClient(code, nodeHostDeps(server.wsUrl));
    noToken.start();
    expect(noToken.getSnapshot().fatal).toBe("no-token");

    const wrongDeps = nodeHostDeps(server.wsUrl);
    wrongDeps.storage!.setItem(hostStorageKey(code), "not-the-token");
    const wrong = new HostClient(code, wrongDeps);
    wrong.start();
    await until(() => wrong.getSnapshot().fatal !== null);
    expect(wrong.getSnapshot().fatal).toBe("not-host");
    expect(wrong.getSnapshot().session).toBeNull();
  });
});

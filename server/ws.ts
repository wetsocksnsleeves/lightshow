import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ClientMessageType,
  type ErrorReason,
  type MessageOfType,
  type ServerMessage,
} from "@/lib/protocol";
import { builtinShow } from "@/lib/builtin-shows";
import { TEST_SHOW_ID, testSchedule } from "@/lib/test-show";
import { getShow } from "./db";
import { compileInWorker } from "./compile-pool";
import { LOOPBACK_HOSTNAMES } from "./http";
import { lanAddresses } from "./lan";
import { readOwnerIdFromCookieHeader } from "./owner";
import type { Point, PositioningConfig, Show } from "@/lib/types";
import {
  SessionError,
  getSessionStore,
  tokensMatch,
  type Participant,
  type Session,
  type SessionStore,
  type TimedSchedule,
} from "./sessions";

/** Path the app's WebSocket listens on (SPEC 5.1). */
export const WS_PATH = "/ws";

/** Largest client message accepted. Client messages are tiny. */
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

/** Host `participants` updates are throttled to 4 per second (SPEC 5.2). */
export const PARTICIPANTS_THROTTLE_MS = 250;

/** Lead time from Start to `T0` (SPEC 4.6). Override with `START_LEAD_MS`. */
export const DEFAULT_START_LEAD_MS = 900;

/** `START_LEAD_MS` from the environment, or the default if unset or invalid. */
export function startLeadMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.START_LEAD_MS?.trim();
  if (!raw) return DEFAULT_START_LEAD_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_START_LEAD_MS;
}

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;

/** Upgrade paths Next owns (dev HMR lives at `/_next/hmr`). */
const NEXT_UPGRADE_PREFIX = "/_next/";

export type ScheduleComputer = (
  show: Show,
  seat: Point,
) => TimedSchedule | Promise<TimedSchedule>;

export type ShowResolver = (
  showId: string,
  ownerId: string | null,
) => Show | undefined | Promise<Show | undefined>;

/**
 * Default: compile the seat's schedule from the show's clips on a worker
 * thread (SPEC 3.3), so compiles never delay `sync` replies.
 */
export const defaultComputeSchedule: ScheduleComputer = compileInWorker;

/**
 * Every show plays the hardcoded test wave, without the compiler. For tests
 * that want exact, instant schedules.
 */
export const testWaveComputeSchedule: ScheduleComputer = (show, seat) => ({
  ...testSchedule(seat),
  durationMs: show.audio.durationMs,
});

/**
 * A built-in show (`lib/builtin-shows.ts`, open to everyone), else a saved
 * show from SQLite owned by `ownerId`. The session keeps a snapshot taken here
 * (SPEC 8), so later edits do not reach a running session.
 */
export const defaultResolveShow: ShowResolver = (showId, ownerId) =>
  builtinShow(showId) ??
  (ownerId ? getShow(showId, ownerId) : null) ??
  undefined;

/** A stored room: enough to bring a session back with the same code. */
export type RoomRecord = {
  code: string;
  hostToken: string;
  showId: string;
  positioning: PositioningConfig;
  ownerId?: string | null;
};

export type RoomStore = {
  load(code: string): RoomRecord | null;
  save(room: RoomRecord): void;
};

export type AttachOptions = {
  /** Next's `app.getUpgradeHandler()`. */
  nextUpgrade: UpgradeHandler;
  /** Forward `/_next/*` upgrades to Next. True in dev, where HMR needs it. */
  forwardNextUpgrades: boolean;
  /** Defaults to the process-wide `getSessionStore()`. */
  store?: SessionStore;
  /**
   * Base URL for join links (`<publicUrl>/j/<code>`). Defaults to the
   * `PUBLIC_URL` env var, then to the origin the host connected through.
   */
  publicUrl?: string;
  /**
   * LAN addresses for join links when the host page is open on localhost,
   * which phones cannot reach. Defaults to `lanAddresses()`.
   */
  lanAddresses?: () => string[];
  computeSchedule?: ScheduleComputer;
  resolveShow?: ShowResolver;
  /**
   * Where rooms are kept so they survive a restart (SPEC 2.5). The app server
   * passes the SQLite store; without one, rooms live in memory only.
   */
  rooms?: RoomStore;
  /**
   * Fit shows to the crowd (SPEC 2.5): seats are mapped through the crowd's
   * bounding box before compiling. The app server turns it on; off, seats
   * are used as sent.
   */
  fitCrowd?: boolean;
  /** Delay before refitting the crowd box after seats change. Default 500 ms. */
  refitDelayMs?: number;
  /**
   * Minimum time between refits of one session, each of which can recompile
   * every phone. Default 3 s, so seat spam can't keep the server compiling.
   */
  refitIntervalMs?: number;
  /** Defaults to `PARTICIPANTS_THROTTLE_MS`. */
  participantsThrottleMs?: number;
  /** How often to drop participants disconnected for 60 s. Default 5 s. */
  sweepIntervalMs?: number;
  /** Ping interval; a socket that misses a pong is terminated. Default 15 s. */
  heartbeatMs?: number;
  /** Start to `T0` lead. Defaults to `startLeadMsFromEnv()`. */
  startLeadMs?: number;
  /** Server clock (SPEC 4.1). Defaults to `performance.now`. */
  now?: () => number;
};

/**
 * Attach the app WebSocket server to `server` and route every upgrade:
 *
 * - `/ws` goes to the `ws` server (SPEC 5.1).
 * - `/_next/*` goes to Next's upgrade handler, in dev only (HMR).
 * - Anything else, and `/_next/*` in production, gets a 404 and the socket is
 *   destroyed, so clients cannot park idle sockets on unknown paths.
 *
 * If Next's handler throws or rejects, the socket is destroyed.
 *
 * Note on Next 16 (checked against next@16.4.6): `app.getUpgradeHandler()` is
 * a no-op. On the first HTTP request Next adds its own `upgrade` listener to
 * the server, and that listener is what serves `/_next/hmr`. It ignores paths
 * it does not route, so it leaves `/ws` alone. We still forward to
 * `getUpgradeHandler()` as the spec asks, so HMR keeps working if a later
 * version stops attaching its own listener. `server/server.test.ts` fails if
 * Next ever handles an HMR upgrade twice.
 */
export function attachWebSocketServer(
  server: Server,
  options: AttachOptions,
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  });
  const router = new WsRouter(options);

  server.on("upgrade", (req, socket, head) => {
    const pathname = pathnameOf(req);
    if (pathname === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    if (
      options.forwardNextUpgrades &&
      pathname?.startsWith(NEXT_UPGRADE_PREFIX)
    ) {
      forwardToNext(options.nextUpgrade, req, socket, head);
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
    router.handleConnection(ws, req),
  );
  wss.on("close", () => router.close());
  return wss;
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

type Role =
  | { kind: "none" }
  | {
      kind: "participant";
      session: Session;
      participantId: string;
      /** `Participant.connectionToken` when this socket joined. */
      token: number;
    }
  | { kind: "host"; session: Session };

/** One open socket. */
export type Connection = {
  ws: WebSocket;
  /** Origin the client connected through, for join URLs without PUBLIC_URL. */
  origin: string;
  /** Hashed `lightshow_owner` cookie from the upgrade request, if present. */
  ownerId: string | null;
  role: Role;
  alive: boolean;
};

type Handler<K extends ClientMessageType> = (
  conn: Connection,
  message: MessageOfType<ClientMessage, K>,
) => void | Promise<void>;

/** One handler per client message type. Adding a type to the protocol
 * without a handler here is a type error. */
type Handlers = { [K in ClientMessageType]: Handler<K> };

/**
 * Routes client messages to the session store and sends replies.
 *
 * Extension points for later chunks:
 * - `sync` / `clock` (chunk 4): `onSync` replies with the server clock to
 *   any socket; `onClock` records a participant's ClockSync status.
 * - `start` / `stop` (chunk 5): host only. `T0 = now + startLeadMs`, stored
 *   in the session (so `welcome` and host re-attach carry it), broadcast to
 *   participants and hosts.
 * - Schedules: `defaultComputeSchedule` compiles on a worker; pass
 *   `computeSchedule` to replace it.
 * - Shows (chunks 10, 15): pass `resolveShow`, or change `defaultResolveShow`.
 */
export class WsRouter {
  readonly store: SessionStore;
  private readonly options: AttachOptions;
  private readonly computeSchedule: ScheduleComputer;
  private readonly resolveShow: ShowResolver;
  private readonly throttleMs: number;
  private readonly startLeadMs: number;
  private readonly now: () => number;
  /** Host sockets per session code. */
  private readonly hosts = new Map<string, Set<Connection>>();
  /** The participant each room's host is moving, by session code. */
  private readonly highlighted = new Map<string, string>();
  /** Pending crowd refits per session code. */
  private readonly refitTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** When each session last refitted (wall clock). */
  private readonly lastRefit = new Map<string, number>();
  private readonly refitDelayMs: number;
  private readonly refitIntervalMs: number;
  /** The current socket of each participant id. */
  private readonly participantSockets = new Map<string, Connection>();
  private readonly participantsThrottle = new Map<
    string,
    { lastSentAt: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly connections = new Set<Connection>();

  constructor(options: AttachOptions) {
    this.options = options;
    this.store = options.store ?? getSessionStore();
    this.computeSchedule = options.computeSchedule ?? defaultComputeSchedule;
    this.resolveShow = options.resolveShow ?? defaultResolveShow;
    this.refitDelayMs = options.refitDelayMs ?? 500;
    this.refitIntervalMs = options.refitIntervalMs ?? 3_000;
    this.throttleMs =
      options.participantsThrottleMs ?? PARTICIPANTS_THROTTLE_MS;
    this.startLeadMs = options.startLeadMs ?? startLeadMsFromEnv();
    this.now = options.now ?? (() => performance.now());
    this.sweepTimer = setInterval(
      () => this.sweep(),
      options.sweepIntervalMs ?? 5_000,
    );
    this.sweepTimer.unref();
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      options.heartbeatMs ?? 15_000,
    );
    this.heartbeatTimer.unref();
  }

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const conn: Connection = {
      ws,
      origin: originOf(req),
      ownerId: readOwnerIdFromCookieHeader(req.headers.cookie),
      role: { kind: "none" },
      alive: true,
    };
    this.connections.add(conn);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      void this.onMessage(conn, data, isBinary);
    });
    ws.on("close", () => this.onClose(conn));
    ws.on("error", () => ws.terminate());
  }

  /** Stop timers. Sockets are closed by the WebSocketServer. */
  close(): void {
    clearInterval(this.sweepTimer);
    clearInterval(this.heartbeatTimer);
    for (const t of this.participantsThrottle.values()) {
      if (t.timer) clearTimeout(t.timer);
    }
    this.participantsThrottle.clear();
  }

  // -- Sending ---------------------------------------------------------------

  send(conn: Connection, message: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(encodeMessage(message));
    }
  }

  sendError(conn: Connection, reason: ErrorReason, message: string): void {
    this.send(conn, { type: "error", reason, message });
  }

  /** Send to every connected participant socket in the session. */
  broadcastToParticipants(session: Session, message: ServerMessage): void {
    const encoded = encodeMessage(message);
    for (const id of session.participants.keys()) {
      const conn = this.participantSockets.get(id);
      if (conn && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(encoded);
    }
  }

  sendToHosts(session: Session, message: ServerMessage): void {
    for (const conn of this.hosts.get(session.code) ?? []) {
      this.send(conn, message);
    }
  }

  /**
   * Queue a `participants` update for the session's hosts. Sends at once if
   * none went out in the last throttle window, otherwise once at its end.
   */
  notifyParticipantsChanged(session: Session): void {
    if (!this.hosts.get(session.code)?.size) return;
    let t = this.participantsThrottle.get(session.code);
    if (!t) {
      t = { lastSentAt: -Infinity, timer: null };
      this.participantsThrottle.set(session.code, t);
    }
    if (t.timer) return;
    const wait = t.lastSentAt + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.flushParticipants(session);
      return;
    }
    t.timer = setTimeout(() => this.flushParticipants(session), wait);
  }

  private flushParticipants(session: Session): void {
    const t = this.participantsThrottle.get(session.code);
    if (t) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      t.lastSentAt = Date.now();
    }
    this.sendToHosts(session, this.participantsMessage(session));
  }

  private participantsMessage(session: Session): ServerMessage {
    return {
      type: "participants",
      list: this.store.summaries(session),
      room: this.store.roomSize(session),
    };
  }

  // -- Receiving -------------------------------------------------------------

  private async onMessage(
    conn: Connection,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      this.sendError(conn, "bad-message", "binary messages are not supported");
      return;
    }
    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) {
      this.sendError(conn, "bad-message", parsed.error);
      return;
    }
    const message = parsed.message;
    try {
      // The mapped type guarantees handlers[K] takes MessageOfType<..., K>;
      // TypeScript cannot correlate the two through `message.type`.
      const handler = this.handlers[message.type] as Handler<ClientMessageType>;
      await handler(conn, message as never);
    } catch (err) {
      if (err instanceof SessionError) {
        this.sendError(conn, err.reason, err.message);
        return;
      }
      console.error(`ws: ${message.type} handler failed`, err);
      this.sendError(conn, "bad-message", "internal error");
    }
  }

  private onClose(conn: Connection): void {
    this.connections.delete(conn);
    const role = conn.role;
    if (role.kind === "participant") {
      if (this.participantSockets.get(role.participantId) === conn) {
        this.participantSockets.delete(role.participantId);
      }
      if (this.store.disconnect(role.session, role.participantId, role.token)) {
        this.scheduleRefit(role.session);
        this.notifyParticipantsChanged(role.session);
      }
    } else if (role.kind === "host") {
      this.hosts.get(role.session.code)?.delete(conn);
      this.setHighlight(role.session.code, null);
    }
  }

  private readonly handlers: Handlers = {
    join: (conn, msg) => this.onJoin(conn, msg),
    seat: (conn, msg) => this.onSeat(conn, msg),
    ready: (conn) => this.onReady(conn),
    host: (conn, msg) => this.onHost(conn, msg),
    sync: (conn, msg) => this.onSync(conn, msg),
    clock: (conn, msg) => this.onClock(conn, msg),
    start: (conn) => this.onStart(conn),
    stop: (conn) => this.onStop(conn),
    positioning: (conn, msg) => this.onPositioning(conn, msg),
    load: (conn, msg) => this.onLoad(conn, msg),
    place: (conn, msg) => this.onPlace(conn, msg),
    highlight: (conn, msg) => this.onHighlight(conn, msg),
  };

  /**
   * Clock handshake (SPEC 4.2). Replies at once with the server clock, before
   * any other work, so the reply's queueing time stays out of the RTT. Any
   * socket may ask: participants (also before `join`) and hosts alike.
   */
  private onSync(conn: Connection, msg: MessageOfType<ClientMessage, "sync">) {
    this.send(conn, { type: "sync", c0: msg.c0, s1: this.now() });
  }

  /**
   * Host clicked Start (SPEC 4.6). Needs one participant in standby. Every
   * participant socket gets `start`, ready or not: one that readies later
   * plays from the current position.
   */
  private onStart(conn: Connection) {
    const session = this.requireHost(conn);
    if (session.T0 !== null) {
      throw new SessionError("show-running", "the show is already running");
    }
    if (this.store.countByState(session).standby === 0) {
      throw new SessionError("no-standby", "no participant is in standby yet");
    }
    const T0 = this.now() + this.startLeadMs;
    this.store.startShow(session, T0);
    this.broadcastToParticipants(session, { type: "start", T0 });
    this.sendToHosts(session, { type: "start", T0 });
    this.notifyParticipantsChanged(session);
  }

  /** Host clicked Stop: clear `T0`; playing participants return to standby. */
  private onStop(conn: Connection) {
    const session = this.requireHost(conn);
    this.store.stopShow(session);
    this.broadcastToParticipants(session, { type: "stop" });
    this.sendToHosts(session, { type: "stop" });
    this.notifyParticipantsChanged(session);
  }

  /**
   * Host set the sizes for finding seats with the camera (SPEC 2.4). Every
   * participant and host gets them, so open seat pickers use them at once.
   */
  private onPositioning(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "positioning">,
  ) {
    const session = this.requireHost(conn);
    this.store.setPositioning(session, msg.config);
    this.saveRoom(session);
    // The minimum room is in metres, so it moves with the sizes.
    this.scheduleRefit(session);
    const reply = { type: "positioning", config: session.positioning } as const;
    this.broadcastToParticipants(session, reply);
    this.sendToHosts(session, reply);
  }

  /** The participant's ClockSync status changed (SPEC 4.4). */
  private onClock(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "clock">,
  ) {
    const { session, participant } = this.requireParticipant(conn);
    const prev = participant.clock;
    if (
      prev.ready === msg.ready &&
      prev.degraded === msg.degraded &&
      prev.rttMs === msg.rttMs
    ) {
      return;
    }
    this.store.setClock(session, participant.id, {
      ready: msg.ready,
      degraded: msg.degraded,
      rttMs: msg.rttMs,
    });
    this.notifyParticipantsChanged(session);
  }

  private async onJoin(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "join">,
  ) {
    if (conn.role.kind !== "none") {
      throw new SessionError("bad-message", "this socket already joined");
    }
    const session = await this.sessionFor(msg.code);
    const { participant, resumed } = this.store.join(session, {
      participantId: msg.participantId,
      resumeToken: msg.resumeToken,
    });
    conn.role = {
      kind: "participant",
      session,
      participantId: participant.id,
      token: participant.connectionToken,
    };

    // A rejoin can arrive before the server noticed the old socket died.
    // Only a verified resume (id + resumeToken) gets here with an existing id.
    const previous = this.participantSockets.get(participant.id);
    this.participantSockets.set(participant.id, conn);
    if (previous && previous !== conn) previous.ws.close(4000, "replaced");

    this.send(conn, {
      type: "welcome",
      participantId: participant.id,
      resumeToken: participant.resumeToken,
      venue: session.show.venue,
      state: {
        participant: participant.state,
        seat: participant.seat,
        T0: session.T0,
      },
      positioning: session.positioning,
    });
    if (resumed && participant.readyTapped) {
      if (participant.schedule) {
        this.sendSchedule(participant, participant.schedule);
      } else {
        void this.updateSchedule(session, participant);
      }
    }
    if (participant.seat) this.scheduleRefit(session);
    this.notifyParticipantsChanged(session);
  }

  private onSeat(conn: Connection, msg: MessageOfType<ClientMessage, "seat">) {
    const { session, participant } = this.requireParticipant(conn);
    this.store.setSeat(session, participant.id, { x: msg.x, y: msg.y });
    // Only Ready phones shape the crowd, so only they trigger a refit.
    if (participant.readyTapped) {
      void this.updateSchedule(session, participant);
      this.scheduleRefit(session);
    }
    this.notifyParticipantsChanged(session);
  }

  private onReady(conn: Connection) {
    const { session, participant } = this.requireParticipant(conn);
    this.store.markReady(session, participant.id);
    void this.updateSchedule(session, participant);
    this.scheduleRefit(session);
    this.notifyParticipantsChanged(session);
  }

  private async onHost(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "host">,
  ) {
    if (conn.role.kind !== "none") {
      throw new SessionError("bad-message", "this socket already joined");
    }
    let session: Session;
    let created = false;
    if ("showId" in msg) {
      const show = await this.resolveShow(msg.showId, conn.ownerId);
      if (!show) {
        throw new SessionError("unknown-show", `no show "${msg.showId}"`);
      }
      // Skip codes a stored room still owns, so rooms never share a code.
      session = this.store.createSession(
        show,
        undefined,
        (code) => this.options.rooms?.load(code) != null,
      );
      created = true;
      this.startCrowd(session);
      this.saveRoom(session, conn.ownerId);
    } else {
      session = await this.sessionFor(msg.code);
      // The join code is public (QR code), so re-attaching needs the token.
      if (!tokensMatch(session.hostToken, msg.hostToken)) {
        throw new SessionError("not-host", "wrong or missing host token");
      }
    }
    conn.role = { kind: "host", session };
    let set = this.hosts.get(session.code);
    if (!set) {
      set = new Set();
      this.hosts.set(session.code, set);
    }
    set.add(conn);

    // Only the creating host learns the token; re-attaching hosts have it.
    this.send(conn, this.sessionMessage(conn, session, created));
    this.send(conn, this.participantsMessage(session));
  }

  /**
   * Host loads a show into the room, or reloads it after saving an edit
   * (SPEC 2.5). Phones stay connected and get schedules for the new show.
   */
  /**
   * Light up the phone the host is moving, and turn off the last one. One
   * per room; cleared when that host disconnects.
   */
  private onHighlight(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "highlight">,
  ) {
    const session = this.requireHost(conn);
    if (msg.participantId !== null) {
      this.store.getParticipant(session, msg.participantId);
    }
    this.setHighlight(session.code, msg.participantId);
  }

  private setHighlight(code: string, participantId: string | null): void {
    const previous = this.highlighted.get(code) ?? null;
    if (previous === participantId) return;
    if (previous) {
      const socket = this.participantSockets.get(previous);
      if (socket) this.send(socket, { type: "highlight", on: false });
    }
    if (participantId) {
      this.highlighted.set(code, participantId);
      const socket = this.participantSockets.get(participantId);
      if (socket) this.send(socket, { type: "highlight", on: true });
    } else {
      this.highlighted.delete(code);
    }
  }

  /** The host dragged a phone to a new spot (SPEC 2.5). */
  private onPlace(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "place">,
  ) {
    const session = this.requireHost(conn);
    const participant = this.store.place(session, msg.participantId, {
      x: msg.x,
      y: msg.y,
    });
    if (participant.readyTapped) void this.updateSchedule(session, participant);
    // A placed phone no longer counts towards the crowd's shape.
    this.scheduleRefit(session);
    this.notifyParticipantsChanged(session);
  }

  private async onLoad(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "load">,
  ) {
    const session = this.requireHost(conn);
    if (session.T0 !== null) {
      throw new SessionError("show-running", "stop the show before loading");
    }
    const show = await this.resolveShow(msg.showId, conn.ownerId);
    if (!show) {
      throw new SessionError("unknown-show", `no show "${msg.showId}"`);
    }
    const stale = this.store.setShow(session, show);
    this.saveRoom(session, conn.ownerId);
    for (const host of this.hosts.get(session.code) ?? []) {
      this.send(host, this.sessionMessage(host, session, false));
    }
    for (const p of stale) void this.updateSchedule(session, p);
    this.notifyParticipantsChanged(session);
  }

  /** The `session` message for one host socket (its join URL depends on its origin). */
  private sessionMessage(
    conn: Connection,
    session: Session,
    withToken: boolean,
  ): ServerMessage {
    const base = (
      this.options.publicUrl ??
      process.env.PUBLIC_URL ??
      reachableOrigin(
        conn.origin,
        (this.options.lanAddresses ?? lanAddresses)(),
      )
    ).replace(/\/+$/, "");
    return {
      type: "session",
      code: session.code,
      joinUrl: `${base}/j/${session.code}`,
      showId: session.showId,
      venue: session.show.venue,
      T0: session.T0,
      show: session.show,
      positioning: session.positioning,
      ...(withToken ? { hostToken: session.hostToken } : {}),
    };
  }

  /**
   * The live session for `code`, or a stored room brought back after a
   * restart (SPEC 2.5). Throws `unknown-session` if neither exists.
   */
  private async sessionFor(code: string): Promise<Session> {
    const live = this.store.getSession(code);
    if (live) return live;
    const room = this.options.rooms?.load(code.toUpperCase());
    if (!room) return this.store.requireSession(code);
    const show =
      (await this.resolveShow(room.showId, room.ownerId ?? null)) ??
      (await this.resolveShow(TEST_SHOW_ID, null));
    if (!show) return this.store.requireSession(code);
    // Another request may have restored it while the show resolved.
    const again = this.store.getSession(code);
    if (again) return again;
    const session = this.store.createSession(show, {
      code: room.code,
      hostToken: room.hostToken,
      positioning: room.positioning,
    });
    this.startCrowd(session);
    return session;
  }

  /**
   * With crowd fitting on, a new room starts as the minimum room around the
   * screen, so the first phones show where they are before anyone is ready.
   */
  private startCrowd(session: Session): void {
    if (this.options.fitCrowd) this.store.refitCrowd(session);
  }

  private saveRoom(session: Session, ownerId?: string | null): void {
    try {
      this.options.rooms?.save({
        code: session.code,
        hostToken: session.hostToken,
        showId: session.showId,
        positioning: session.positioning,
        ...(ownerId ? { ownerId } : {}),
      });
    } catch (err) {
      console.error("ws: could not save the room", err);
    }
  }

  /**
   * Refit the crowd box a moment after seats change (a burst of joins
   * becomes one refit), at most once per `refitIntervalMs`, and recompile
   * everyone if it moved.
   */
  private scheduleRefit(session: Session): void {
    if (!this.options.fitCrowd || this.refitTimers.has(session.code)) return;
    const since = Date.now() - (this.lastRefit.get(session.code) ?? -Infinity);
    const wait = Math.max(this.refitDelayMs, this.refitIntervalMs - since);
    const timer = setTimeout(() => {
      this.refitTimers.delete(session.code);
      this.lastRefit.set(session.code, Date.now());
      const stale = this.store.refitCrowd(session);
      for (const p of stale) void this.updateSchedule(session, p);
      if (stale.length) this.notifyParticipantsChanged(session);
    }, wait);
    timer.unref?.();
    this.refitTimers.set(session.code, timer);
  }

  // -- Helpers ---------------------------------------------------------------

  /** Throws `not-joined` unless this socket joined as a participant. */
  requireParticipant(conn: Connection): {
    session: Session;
    participant: Participant;
  } {
    const role = conn.role;
    if (role.kind !== "participant") {
      throw new SessionError("not-joined", "send join first");
    }
    return {
      session: role.session,
      participant: this.store.getParticipant(role.session, role.participantId),
    };
  }

  /** Throws `not-host` unless this socket attached as a host. */
  requireHost(conn: Connection): Session {
    if (conn.role.kind !== "host") {
      throw new SessionError("not-host", "send host first");
    }
    return conn.role.session;
  }

  /**
   * Compute the participant's schedule for the current seat and send it. If
   * the seat moves while computing, the stale result is dropped (the move
   * started a newer computation).
   */
  private async updateSchedule(
    session: Session,
    participant: Participant,
  ): Promise<void> {
    const seat = this.store.showSeat(session, participant);
    const { scheduleVersion } = participant;
    if (!seat) return;
    let schedule: TimedSchedule;
    try {
      schedule = await this.computeSchedule(session.show, seat);
    } catch (err) {
      console.error("ws: schedule computation failed", err);
      return;
    }
    if (
      this.store.setSchedule(session, participant.id, schedule, scheduleVersion)
    ) {
      this.sendSchedule(participant, schedule);
      this.notifyParticipantsChanged(session);
    }
  }

  private sendSchedule(participant: Participant, schedule: TimedSchedule) {
    const conn = this.participantSockets.get(participant.id);
    if (!conn) return;
    this.send(conn, {
      type: "schedule",
      events: schedule.events,
      durationMs: schedule.durationMs,
    });
  }

  private sweep(): void {
    for (const session of this.store.removeExpired()) {
      this.notifyParticipantsChanged(session);
    }
  }

  private heartbeat(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }
}

// ---------------------------------------------------------------------------
// Upgrade helpers
// ---------------------------------------------------------------------------

function forwardToNext(
  handler: UpgradeHandler,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const fail = (err: unknown) => {
    console.error("Next upgrade handler failed", err);
    socket.destroy();
  };
  try {
    Promise.resolve(handler(req, socket, head)).catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** Answer an upgrade with a plain HTTP error and close the socket. */
export function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  }
  socket.destroy();
}

/** The request path, or null if the URL cannot be parsed. */
function pathnameOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/** `proto://host` the client used, honouring a tunnel's forwarded headers. */
function originOf(req: IncomingMessage): string {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
  const host =
    first(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

/**
 * `origin`, unless it is a loopback address: phones cannot reach that, so
 * swap in the first LAN address, keeping the scheme and port.
 */
export function reachableOrigin(origin: string, lan: string[]): string {
  try {
    const url = new URL(origin);
    if (!LOOPBACK_HOSTNAMES.includes(url.hostname) || lan.length === 0) {
      return origin;
    }
    url.hostname = lan[0];
    return url.origin;
  } catch {
    return origin;
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PositioningConfig, Show } from "@/lib/types";
import { dbPath } from "./data-dir";
import { emptyShowInput, type ShowInput } from "./show-validation";

export type ShowSummary = Pick<
  Show,
  "id" | "name" | "createdAt" | "updatedAt"
> & {
  /** `showDurationMs(show)`: the audio length or the last clip end, if later. */
  durationMs: number;
  /** The show has an audio file. */
  hasAudio: boolean;
};

type Handle = { path: string; db: Database.Database };

// Next bundles each route handler separately, and dev mode re-evaluates
// modules on change. Keeping the handle on globalThis means one connection
// per process instead of one per bundle or per reload.
const holder = globalThis as typeof globalThis & { __lightshowDb?: Handle };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    owner_id TEXT,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shows_updated_at ON shows (updated_at);
  CREATE TABLE IF NOT EXISTS audio_files (
    file_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    owner_id TEXT,
    host_token TEXT NOT NULL,
    show_id TEXT NOT NULL,
    positioning TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function ensureColumn(
  db: Database.Database,
  table: "shows" | "rooms",
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Open (or reuse) the database at `dbPath()`, creating the schema on first use. */
export function getDb(): Database.Database {
  const file = dbPath();
  const existing = holder.__lightshowDb;
  if (existing && existing.path === file && existing.db.open)
    return existing.db;
  if (existing?.db.open) existing.db.close();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  ensureColumn(db, "shows", "owner_id", "TEXT");
  ensureColumn(db, "rooms", "owner_id", "TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS shows_owner_updated ON shows (owner_id, updated_at)",
  );
  holder.__lightshowDb = { path: file, db };
  return db;
}

/** Close the shared connection. Tests call this between temp databases. */
export function closeDb(): void {
  const existing = holder.__lightshowDb;
  if (existing?.db.open) existing.db.close();
  holder.__lightshowDb = undefined;
}

type ShowRow = {
  id: string;
  name: string;
  data: string;
  created_at: string;
  updated_at: string;
};

function rowToShow(row: ShowRow): Show {
  const body = JSON.parse(row.data) as Pick<Show, "venue" | "audio" | "clips">;
  return {
    id: row.id,
    name: row.name,
    venue: body.venue,
    audio: body.audio,
    clips: body.clips,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function showData(show: Pick<Show, "venue" | "audio" | "clips">): string {
  return JSON.stringify({
    venue: show.venue,
    audio: show.audio,
    clips: show.clips,
  });
}

type SummaryRow = Omit<ShowRow, "data"> & {
  audio_ms: number | null;
  clips_end_ms: number | null;
  audio_file: string | null;
};

/**
 * Shows owned by `ownerId`, most recently updated first. Summaries only:
 * SQLite reads the duration and audio id out of the JSON, so the show bodies
 * are not parsed.
 */
export function listShows(ownerId: string): ShowSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, created_at, updated_at,
        json_extract(data, '$.audio.durationMs') AS audio_ms,
        json_extract(data, '$.audio.fileId') AS audio_file,
        (SELECT MAX(json_extract(c.value, '$.endMs'))
           FROM json_each(data, '$.clips') AS c) AS clips_end_ms
      FROM shows
      WHERE owner_id = ?
      ORDER BY updated_at DESC, id`,
    )
    .all(ownerId) as SummaryRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    durationMs: Math.max(0, r.audio_ms ?? 0, r.clips_end_ms ?? 0),
    hasAudio: typeof r.audio_file === "string" && r.audio_file !== "",
  }));
}

type AudioRow = {
  file_id: string;
  duration_ms: number | null;
  title: string | null;
  artist: string | null;
};

/**
 * The music used by `ownerId`'s saved shows, most recently updated show first,
 * one entry per file. A title or artist missing from the newest show that uses
 * a file is taken from an older one.
 */
export function listRecentAudio(ownerId: string, limit = 12): Show["audio"][] {
  const rows = getDb()
    .prepare(
      `SELECT json_extract(data, '$.audio.fileId') AS file_id,
        json_extract(data, '$.audio.durationMs') AS duration_ms,
        json_extract(data, '$.audio.title') AS title,
        json_extract(data, '$.audio.artist') AS artist
      FROM shows
      WHERE owner_id = ? AND file_id IS NOT NULL AND file_id != ''
      ORDER BY updated_at DESC, id`,
    )
    .all(ownerId) as AudioRow[];
  const byFile = new Map<string, Show["audio"]>();
  for (const r of rows) {
    if (typeof r.file_id !== "string") continue;
    const seen = byFile.get(r.file_id);
    if (!seen && byFile.size >= limit) continue;
    const track = seen ?? { fileId: r.file_id, durationMs: 0 };
    track.durationMs ||= Math.max(0, r.duration_ms ?? 0);
    if (!track.title && typeof r.title === "string") track.title = r.title;
    if (!track.artist && typeof r.artist === "string") track.artist = r.artist;
    byFile.set(r.file_id, track);
  }
  return [...byFile.values()];
}

export function getShow(id: string, ownerId: string): Show | null {
  const row = getDb()
    .prepare("SELECT * FROM shows WHERE id = ? AND owner_id = ?")
    .get(id, ownerId) as ShowRow | undefined;
  return row ? rowToShow(row) : null;
}

/** Unscoped lookup for local CLI scripts. Never call from HTTP/WS handlers. */
export function getShowById(id: string): Show | null {
  const row = getDb().prepare("SELECT * FROM shows WHERE id = ?").get(id) as
    ShowRow | undefined;
  return row ? rowToShow(row) : null;
}

/** Create a show owned by `ownerId`. Missing fields get the defaults from `emptyShowInput`. */
export function createShow(
  input: Partial<ShowInput> = {},
  ownerId: string | null = null,
): Show {
  const now = new Date().toISOString();
  const show: Show = {
    ...emptyShowInput(),
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      "INSERT INTO shows (id, owner_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      show.id,
      ownerId,
      show.name,
      showData(show),
      show.createdAt,
      show.updatedAt,
    );
  return show;
}

/** Merge `patch` over the stored show owned by `ownerId`. Returns null if not found. */
export function updateShow(
  id: string,
  patch: Partial<ShowInput>,
  ownerId?: string,
): Show | null {
  const db = getDb();
  const update = db.transaction((): Show | null => {
    const current =
      ownerId !== undefined ? getShow(id, ownerId) : getShowById(id);
    if (!current) return null;
    const next: Show = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (ownerId !== undefined) {
      db.prepare(
        "UPDATE shows SET name = ?, data = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
      ).run(next.name, showData(next), next.updatedAt, id, ownerId);
    } else {
      db.prepare(
        "UPDATE shows SET name = ?, data = ?, updated_at = ? WHERE id = ?",
      ).run(next.name, showData(next), next.updatedAt, id);
    }
    return next;
  });
  return update();
}

/** Returns false if there was no such show owned by `ownerId`. */
export function deleteShow(id: string, ownerId: string): boolean {
  return (
    getDb()
      .prepare("DELETE FROM shows WHERE id = ? AND owner_id = ?")
      .run(id, ownerId).changes > 0
  );
}

// ---------------------------------------------------------------------------
// Uploaded audio ownership
// ---------------------------------------------------------------------------

/** Record which browser owns an uploaded audio file. */
export function registerAudioFile(fileId: string, ownerId: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO audio_files (file_id, owner_id, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(fileId, ownerId, new Date().toISOString());
}

export function getAudioOwner(fileId: string): string | null {
  const row = getDb()
    .prepare("SELECT owner_id FROM audio_files WHERE file_id = ?")
    .get(fileId) as { owner_id: string } | undefined;
  return row?.owner_id ?? null;
}

export function isAudioOwnedBy(fileId: string, ownerId: string): boolean {
  return getAudioOwner(fileId) === ownerId;
}

// ---------------------------------------------------------------------------
// Rooms (SPEC 2.5): a host's session, kept so phones can rejoin the same room
// after a server restart.
// ---------------------------------------------------------------------------

export type RoomRecord = {
  code: string;
  hostToken: string;
  showId: string;
  positioning: PositioningConfig;
  ownerId?: string | null;
};

type RoomRow = {
  code: string;
  owner_id: string | null;
  host_token: string;
  show_id: string;
  positioning: string;
};

export function getRoom(code: string): RoomRecord | null {
  const row = getDb()
    .prepare(
      "SELECT code, owner_id, host_token, show_id, positioning FROM rooms WHERE code = ?",
    )
    .get(code) as RoomRow | undefined;
  if (!row) return null;
  return {
    code: row.code,
    hostToken: row.host_token,
    showId: row.show_id,
    positioning: JSON.parse(row.positioning) as PositioningConfig,
    ...(row.owner_id !== null ? { ownerId: row.owner_id } : {}),
  };
}

export function saveRoom(room: RoomRecord): void {
  getDb()
    .prepare(
      `INSERT INTO rooms (code, owner_id, host_token, show_id, positioning, updated_at)
       VALUES (@code, @ownerId, @hostToken, @showId, @positioning, @updatedAt)
       ON CONFLICT(code) DO UPDATE SET
         owner_id = COALESCE(excluded.owner_id, rooms.owner_id),
         show_id = excluded.show_id,
         positioning = excluded.positioning,
         updated_at = excluded.updated_at`,
    )
    .run({
      code: room.code,
      ownerId: room.ownerId ?? null,
      hostToken: room.hostToken,
      showId: room.showId,
      positioning: JSON.stringify(room.positioning),
      updatedAt: new Date().toISOString(),
    });
}

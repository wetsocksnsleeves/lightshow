import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BUILTIN_TRACKS } from "@/lib/builtin-tracks";
import { MIXTAPE_AUDIO_FILE_ID } from "@/lib/mixtape-show";
import { audioDir } from "./data-dir";

/** Accepted upload formats (SPEC 2.1) and the content type each is served with. */
export const AUDIO_CONTENT_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
} as const;

export type AudioExt = keyof typeof AUDIO_CONTENT_TYPES;

/** A 3-minute 16-bit stereo wav is about 32 MB. Uploads are held in memory while parsed, so keep this modest. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

const MIME_TO_EXT: Record<string, AudioExt> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
};

// `<uuid>.<ext>`. Strict, so a file id can never name a path outside audioDir().
const FILE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|wav|m4a)$/;

export function isAudioFileId(value: string): boolean {
  return FILE_ID.test(value);
}

function isAudioExt(value: string): value is AudioExt {
  return Object.hasOwn(AUDIO_CONTENT_TYPES, value);
}

/** Pick the stored extension from the file name, falling back to the MIME type. */
export function audioExtFor(
  fileName: string,
  mimeType: string,
): AudioExt | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  if (isAudioExt(ext)) return ext;
  return MIME_TO_EXT[mimeType.toLowerCase().split(";")[0].trim()] ?? null;
}

export function contentTypeFor(fileId: string): string {
  const ext = path.extname(fileId).slice(1);
  return isAudioExt(ext)
    ? AUDIO_CONTENT_TYPES[ext]
    : "application/octet-stream";
}

/**
 * A file id made from the file's SHA-256, for audio bundled with the app.
 * Audio is served as `immutable`, so a bundled file that changes needs a new
 * id or browsers keep playing the copy they cached.
 */
export function contentFileId(bytes: Uint8Array, ext: AudioExt): string {
  const h = createHash("sha256").update(bytes).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}.${ext}`;
}

/** Audio shipped with the app for built-in shows, by file id. Paths are relative to the working directory. */
const BUILTIN_AUDIO: Record<string, string> = {
  [MIXTAPE_AUDIO_FILE_ID]: "public/builtin-audio/mixtape.mp3",
  ...Object.fromEntries(BUILTIN_TRACKS.map((t) => [t.fileId, t.path])),
};

/** Whether `fileId` is one of the public built-in audio files shipped with the app. */
export function isBuiltinAudio(fileId: string): boolean {
  return Object.hasOwn(BUILTIN_AUDIO, fileId);
}

export function audioFilePath(fileId: string): string {
  if (!isAudioFileId(fileId))
    throw new Error(`invalid audio file id: ${fileId}`);
  const bundled = BUILTIN_AUDIO[fileId];
  if (bundled) return path.resolve(/*turbopackIgnore: true*/ bundled);
  return path.join(/*turbopackIgnore: true*/ audioDir(), fileId);
}

/** Write the bytes to `data/audio/<uuid>.<ext>` and return the new file id. */
export async function saveAudio(
  bytes: Uint8Array,
  ext: AudioExt,
): Promise<string> {
  const fileId = `${randomUUID()}.${ext}`;
  const dir = audioDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const target = path.join(/*turbopackIgnore: true*/ dir, fileId);
  // Write then rename, so a reader never sees a half-written file.
  const temp = `${target}.part`;
  await fs.promises.writeFile(temp, bytes);
  await fs.promises.rename(temp, target);
  return fileId;
}

export type ByteRange = { start: number; end: number };

/**
 * Parse an HTTP `Range` header for a file of `size` bytes (RFC 9110 14.1.2).
 *
 * - `null`: no usable range, serve the whole file with 200. This covers a
 *   missing or malformed header and multi-range requests, which servers may
 *   ignore.
 * - `"unsatisfiable"`: reply 416.
 * - `{ start, end }`: inclusive byte offsets, reply 206.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === "" && last === "") return null;

  if (first === "") {
    // Suffix range: the last N bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(first);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return { start, end };
}

/**
 * Generates a light show from an audio file: decodes it with ffmpeg, finds
 * the beats, kicks, snares and loudness (lib/audio-analysis.ts), lays out
 * flashes and waves to match (lib/light-show-generator.ts), and saves the
 * show to the database so it appears in the show list.
 *
 *   npx tsx scripts/light-show.ts "demo/2hollis - poster boy (official audio).mp3"
 *   npx tsx scripts/light-show.ts song.mp3 --name "Opener"
 *   npx tsx scripts/light-show.ts song.mp3 --show <id>   # replace that show's clips, keep its venue
 *   npx tsx scripts/light-show.ts song.mp3 --out show.json  # write JSON, touch nothing
 *
 * Needs `ffmpeg` on PATH.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyseAudio } from "@/lib/audio-analysis";
import { compileSchedule } from "@/lib/compile";
import { barIntensity, generateLightShow } from "@/lib/light-show-generator";
import { TEST_VENUE } from "@/lib/test-show";
import type { Show, Venue } from "@/lib/types";
import { audioExtFor, saveAudio } from "@/server/audio-store";
import { audioDir } from "@/server/data-dir";
import { createShow, getShowById, updateShow } from "@/server/db";
import { parseShowPatch } from "@/server/show-validation";

const SAMPLE_RATE = 22_050;

const HELP = `Usage: npx tsx scripts/light-show.ts <audio file> [options]

  --name NAME   show name (default: the file name)
  --show ID     replace the clips and audio of this saved show, keeping its venue
  --out FILE    write the show as JSON instead of saving it
  --help`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      show: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const file = positionals[0];

  const existing = values.show ? getShowById(values.show) : null;
  if (values.show && !existing)
    throw new Error(`no show with id ${values.show}`);
  const venue: Venue = existing?.venue.shapes.length
    ? existing.venue
    : TEST_VENUE;

  const samples = await decode(file);
  const analysis = analyseAudio(samples, SAMPLE_RATE);
  const clips = generateLightShow(analysis, venue);
  const durationMs = Math.round(analysis.durationMs);

  const loudBars = analysis.bars.filter((b) => barIntensity(b) >= 0.45).length;
  console.log(
    `${(durationMs / 1000).toFixed(1)} s, ${analysis.bpm.toFixed(1)} BPM, ` +
      `${analysis.beats.length} beats, ${analysis.bars.length} bars (${loudBars} loud), ` +
      `${analysis.hits.low.length} kicks, ${analysis.hits.mid.length} snares`,
  );
  console.log(`${clips.length} clips`);

  const name = values.name ?? path.basename(file, path.extname(file));
  const draft: Show = {
    id: "draft",
    name,
    venue,
    audio: { fileId: "", durationMs },
    clips,
    createdAt: "",
    updatedAt: "",
  };
  for (const seat of [
    { x: 0.1, y: 0.3 },
    { x: 0.5, y: 0.5 },
    { x: 0.9, y: 0.8 },
  ]) {
    const n = compileSchedule(draft, seat).events.length;
    console.log(`  seat (${seat.x}, ${seat.y}): ${n} schedule events`);
  }

  if (values.out) {
    fs.writeFileSync(values.out, JSON.stringify(draft, null, 2));
    console.log(`wrote ${values.out}`);
    return;
  }

  const fileId = await storeAudio(file);
  const patch = parseShowPatch({
    name: existing?.name ?? name,
    venue,
    audio: { fileId, durationMs },
    clips,
  });
  if (!patch.ok) throw new Error(`generated show is invalid: ${patch.error}`);
  const show = existing
    ? updateShow(existing.id, patch.value)
    : createShow(patch.value);
  if (!show) throw new Error("show disappeared while saving");
  console.log(`saved "${show.name}": /shows/${show.id}/edit`);
}

/** Mono float PCM at SAMPLE_RATE, via ffmpeg. */
function decode(file: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        "-f",
        "f32le",
        "-",
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}`));
      const buf = Buffer.concat(chunks);
      // Copy so the floats are aligned regardless of the Buffer's offset.
      const aligned = new Uint8Array(buf.byteLength - (buf.byteLength % 4));
      aligned.set(buf.subarray(0, aligned.byteLength));
      resolve(new Float32Array(aligned.buffer));
    });
  });
}

/** Reuse an identical file already in data/audio, or store a copy. */
async function storeAudio(file: string): Promise<string> {
  const bytes = fs.readFileSync(file);
  const ext = audioExtFor(file, "");
  if (!ext) throw new Error(`unsupported audio type: ${file}`);
  const hash = sha256(bytes);
  const dir = audioDir();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(`.${ext}`)) continue;
      const other = path.join(dir, name);
      if (fs.statSync(other).size !== bytes.byteLength) continue;
      if (sha256(fs.readFileSync(other)) === hash) return name;
    }
  }
  return saveAudio(bytes, ext);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

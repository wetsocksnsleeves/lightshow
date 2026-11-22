"use client";

import { useState, useSyncExternalStore } from "react";
import type { HostClient } from "@/app/sessions/host-client";
import { AUDIO_OFFSET_LIMIT_MS } from "@/lib/audio-schedule";
import {
  screenFromConfig,
  screenFromDiagonal,
  targetWidthFromScreen,
} from "@/lib/positioning/seat";
import type { SessionMessage } from "@/lib/protocol";
import type { PositioningConfig, ScreenSize } from "@/lib/types";
import type { HostAudioControls } from "./use-host-audio";
import styles from "./room.module.css";

type Unit = "in" | "cm";
type ScreenMode = "diagonal" | "dimensions";
const METRES_PER: Record<Unit, number> = { in: 0.0254, cm: 0.01 };
const UNIT_KEY = "lightshow-screen-unit";
const MODE_KEY = "lightshow-screen-mode";
/** Smallest and largest screen side, in metres. */
const MIN_SIDE_M = 0.1;
const MAX_SIDE_M = 100;

/**
 * Room settings behind one button: the big screen's size (phones need it to
 * measure distance), the audio delay, the click track, and the room itself.
 */
export function Settings({
  client,
  session,
  audio,
  clickOn,
  setClickOn,
  onNewRoom,
}: {
  client: HostClient;
  session: SessionMessage;
  audio: HostAudioControls;
  clickOn: boolean;
  setClickOn: (on: boolean) => void;
  onNewRoom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const config = session.positioning;
  const { offsetMs, setOffsetMs, snapshot } = audio;

  return (
    <div className={styles.settings}>
      <button
        type="button"
        className={styles.ghost}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Settings
      </button>
      {open ? (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div className={styles.panel} role="dialog" aria-label="Settings">
            <ScreenFields
              config={config}
              onChange={(screen) =>
                client.setPositioning({
                  ...config,
                  screen,
                  targetWidthM: targetWidthFromScreen(screen),
                })
              }
            />

            <label className={styles.setting}>
              <span>
                Audio delay{" "}
                <output className={styles.dim}>
                  {offsetMs > 0 ? "+" : ""}
                  {offsetMs} ms
                </output>
              </span>
              <input
                type="range"
                min={-AUDIO_OFFSET_LIMIT_MS}
                max={AUDIO_OFFSET_LIMIT_MS}
                step={5}
                value={offsetMs}
                onChange={(e) => setOffsetMs(Number(e.target.value))}
              />
            </label>
            <p className={styles.hint}>
              Go negative to cancel speaker lag (Bluetooth: 100–300 ms).
              {offsetMs !== 0 ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => setOffsetMs(0)}
                  >
                    Reset
                  </button>
                </>
              ) : null}
            </p>
            {snapshot.context !== "running" ? (
              <button
                type="button"
                className={styles.ghost}
                onClick={() => void audio.audio.unlock()}
              >
                Enable audio
              </button>
            ) : null}
            {snapshot.load.kind === "error" ? (
              <p className={styles.error}>
                Audio failed to load: {snapshot.load.message}
              </p>
            ) : null}

            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={clickOn}
                onChange={(e) => setClickOn(e.target.checked)}
              />
              Beep at each clip start
            </label>

            <a
              className={styles.link}
              href="/mock"
              target="_blank"
              rel="noreferrer"
            >
              Open the 3D view
            </a>

            <hr />
            <div className={styles.setting}>
              <span>
                Room <span className={styles.code}>{session.code}</span>
              </span>
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  if (
                    window.confirm(
                      "Start a new room? Phones in this one will need to scan again.",
                    )
                  ) {
                    onNewRoom();
                  }
                }}
              >
                New room
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

const unitListeners = new Set<() => void>();

function readUnit(): Unit {
  try {
    return localStorage.getItem(UNIT_KEY) === "cm" ? "cm" : "in";
  } catch {
    return "in";
  }
}

function writeUnit(unit: Unit): void {
  try {
    localStorage.setItem(UNIT_KEY, unit);
  } catch {
    // Not remembered; inches next time.
  }
  for (const fn of unitListeners) fn();
}

/** Inches or centimetres, remembered on this laptop. */
function useUnit(): [Unit, (unit: Unit) => void] {
  const unit = useSyncExternalStore(
    (fn) => {
      unitListeners.add(fn);
      return () => unitListeners.delete(fn);
    },
    readUnit,
    () => "in" as Unit,
  );
  return [unit, writeUnit];
}

const modeListeners = new Set<() => void>();

function readMode(): ScreenMode {
  try {
    return localStorage.getItem(MODE_KEY) === "dimensions"
      ? "dimensions"
      : "diagonal";
  } catch {
    return "diagonal";
  }
}

function writeMode(mode: ScreenMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not remembered; diagonal next time.
  }
  for (const fn of modeListeners) fn();
}

/** Diagonal or width × height entry, remembered on this laptop. */
function useScreenMode(): [ScreenMode, (mode: ScreenMode) => void] {
  const mode = useSyncExternalStore(
    (fn) => {
      modeListeners.add(fn);
      return () => modeListeners.delete(fn);
    },
    readMode,
    () => "diagonal" as ScreenMode,
  );
  return [mode, writeMode];
}

/**
 * The big screen's size, entered either as a diagonal (default 55" 16:9) or
 * as width × height. Phones judge distance from how big the target looks on
 * the screen.
 */
function ScreenFields({
  config,
  onChange,
}: {
  config: PositioningConfig;
  onChange: (screen: ScreenSize) => void;
}) {
  const [unit, setUnit] = useUnit();
  const [mode, setMode] = useScreenMode();
  const screen = screenFromConfig(config);
  const per = METRES_PER[unit];
  // Whole centimetres, or inches to a tenth.
  const shown = (m: number) =>
    unit === "cm" ? Math.round(m / per) : Math.round((m / per) * 10) / 10;
  const commit = (next: ScreenSize) => {
    const ok = (m: number) => m >= MIN_SIDE_M && m <= MAX_SIDE_M;
    if (!ok(next.widthM) || !ok(next.heightM)) return;
    if (
      Math.abs(next.widthM - screen.widthM) < 1e-6 &&
      Math.abs(next.heightM - screen.heightM) < 1e-6
    ) {
      return;
    }
    onChange(next);
  };
  const diagonalM = Math.hypot(screen.widthM, screen.heightM);
  const diagonalIn = diagonalM / 0.0254;
  const side = (key: keyof ScreenSize, label: string) => (
    <label className={styles.inputWithUnit}>
      <input
        // Remount when the value or unit changes, so it shows through.
        key={`${unit}-${screen[key]}`}
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        defaultValue={shown(screen[key])}
        aria-label={`Screen ${label} in ${unit === "in" ? "inches" : "centimetres"}`}
        onBlur={(e) => {
          const value = Number(e.target.value) * per;
          if (Number.isFinite(value)) commit({ ...screen, [key]: value });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {label === "width" ? "×" : null}
    </label>
  );

  return (
    <>
      <div className={styles.setting}>
        <span>Screen</span>
        <span
          className={styles.shapeButtons}
          role="group"
          aria-label="Screen size mode"
        >
          {(
            [
              ["diagonal", "Diagonal"],
              ["dimensions", "W × H"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className={styles.setting}>
        {mode === "diagonal" ? (
          <label className={styles.inputWithUnit}>
            <input
              key={`${unit}-${diagonalM}`}
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              defaultValue={shown(diagonalM)}
              aria-label={`Screen diagonal in ${unit === "in" ? "inches" : "centimetres"}`}
              onBlur={(e) => {
                const value = Number(e.target.value) * per;
                if (Number.isFinite(value)) commit(screenFromDiagonal(value));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
        ) : (
          <span className={styles.screenSides}>
            {side("widthM", "width")}
            {side("heightM", "height")}
          </span>
        )}
        <span className={styles.shapeButtons} role="group" aria-label="Units">
          {(["in", "cm"] as const).map((u) => (
            <button
              key={u}
              type="button"
              aria-pressed={u === unit}
              onClick={() => setUnit(u)}
            >
              {u}
            </button>
          ))}
        </span>
      </div>
      <p className={styles.hint}>
        {mode === "diagonal"
          ? `${shown(screen.widthM)} × ${shown(screen.heightM)} ${unit} (16:9).`
          : `About ${Math.round(diagonalIn)}″ diagonal.`}{" "}
        Phones use it to judge distance.
      </p>
    </>
  );
}

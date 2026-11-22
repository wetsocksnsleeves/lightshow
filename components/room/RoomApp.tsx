"use client";

import { Inter, Space_Grotesk } from "next/font/google";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  HostClient,
  browserHostDeps,
  createHostedSession,
  readHostToken,
  type HostSnapshot,
  ROOM_STORAGE_KEY,
} from "@/app/sessions/host-client";
import { listShows } from "@/components/editor/api";
import type { Size } from "@/components/editor/geometry";
import { isTypingTarget, timelineKeys } from "@/components/editor/keyboard";
import { saveEditorShow } from "@/components/editor/save";
import {
  createEditorStore,
  initialEditorState,
  isDirty,
  type EditorStore,
} from "@/components/editor/store";
import {
  EditorStoreProvider,
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import { toolHandlers } from "@/components/editor/tools";
import { VenueCanvas } from "@/components/editor/VenueCanvas";
import { clickTimesForShow } from "@/lib/audio-schedule";
import {
  BUILTIN_SHOWS,
  builtinShow,
  clickTrackByDefault,
} from "@/lib/builtin-shows";
import { showDurationMs } from "@/lib/compile";
import { countByState } from "@/lib/host-map";
import { screenFromConfig } from "@/lib/positioning/seat";
import type { SessionMessage } from "@/lib/protocol";
import { Coach } from "./Coach";
import { CrowdCanvas } from "./CrowdCanvas";
import {
  copySelected,
  deleteSelected,
  duplicateSelected,
  paste,
  splitSelected,
} from "./edit-actions";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { ROOM_LAYERS } from "./room-layers";
import { Settings } from "./Settings";
import { ShowControls } from "./ShowControls";
import { MusicChooserProvider } from "./MusicChooser";
import { ShowPicker } from "./ShowPicker";
import { Timeline } from "./timeline/Timeline";
import { CameraPanel } from "./camera/CameraPanel";
import { Splitter } from "./Splitter";
import { usePanels } from "./use-panels";
import { useCamera } from "./camera/use-camera";
import { useRecorder, type Recorder } from "./camera/use-recorder";
import { useDecodedAudio, usePlayback } from "./timeline/playback";
import { useRoomPointer } from "./use-room-pointer";
import { useToast } from "./use-toast";
import { useHostAudio, type HostAudioControls } from "./use-host-audio";
import styles from "./room.module.css";

const body = Inter({ subsets: ["latin"], weight: ["300", "400", "500"] });
const wordmark = Space_Grotesk({ subsets: ["latin"], weight: "700" });

/** Edits wait this long before they are saved and sent to the phones. */
const AUTOSAVE_MS = 800;
/** The studio grid's outer padding and the gap between panels (px). */
const STUDIO_PAD = 12;
const STUDIO_GAP = 12;
/** A failed save is retried after this long. */
const RETRY_MS = 3_000;

/**
 * The laptop screen (SPEC 2.5): one room that phones join once, with the
 * editor and the live view merged. The room keeps its code across reloads
 * and server restarts (its host token is in localStorage), so the host can
 * swap shows and edit while phones stay connected.
 */
export function RoomApp() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (fresh: boolean) => {
    setError(null);
    const deps = browserHostDeps();
    const stored = fresh ? null : readRoomCode();
    // Ensure the browser has its owner cookie before opening `/ws`, so saved
    // shows created in this session resolve on the same socket.
    const shows = await listShows().catch(() => []);
    if (stored && readHostToken(deps.storage, stored)) {
      setCode(stored);
      return;
    }
    setCode(null);
    try {
      const showId = shows[0]?.id ?? BUILTIN_SHOWS[0]!.show.id;
      const created = await createHostedSession(showId, deps);
      writeRoomCode(created);
      setCode(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Opening the room on mount; state is set after the awaits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void open(false);
  }, [open]);

  if (code) {
    return <Room key={code} code={code} onLost={() => void open(true)} />;
  }
  return (
    <main className={`${styles.room} ${body.className}`}>
      <div className={styles.message}>
        <span className={`${styles.mark} ${wordmark.className}`}>
          lightshow
        </span>
        {error ? (
          <>
            <p role="alert">Could not open a room: {error}</p>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void open(false)}
            >
              Try again
            </button>
          </>
        ) : (
          <p>Opening your room…</p>
        )}
      </div>
    </main>
  );
}

function readRoomCode(): string | null {
  try {
    return window.localStorage.getItem(ROOM_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRoomCode(code: string): void {
  try {
    window.localStorage.setItem(ROOM_STORAGE_KEY, code);
  } catch {
    // Storage blocked: the next visit opens a new room.
  }
}

/** Everything the studio needs from the room connection. */
type RoomProps = {
  client: HostClient;
  snapshot: HostSnapshot;
  session: SessionMessage;
  audio: HostAudioControls;
  clickOn: boolean;
  setClickOn: (on: boolean) => void;
  onNewRoom: () => void;
  stage: StageShared;
};

/**
 * What outlives a show switch: the camera, a recording in progress, and
 * presenting full screen. Switching shows rebuilds the editor below.
 */
type StageShared = {
  camera: ReturnType<typeof useCamera>;
  cameraOpen: boolean;
  setCameraOpen: (open: boolean) => void;
  recorder: Recorder;
  /** The room's canvases, whichever show is loaded. */
  frameRef: RefObject<HTMLDivElement | null>;
  /** The screen bar's width, for the recording. */
  screenShareRef: RefObject<number>;
  presenting: boolean;
  present: () => void;
};

function Room({ code, onLost }: { code: string; onLost: () => void }) {
  const [client] = useState(() => new HostClient(code, browserHostDeps));
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  // A tab back from hidden resyncs its clock (SPEC 4.3, 4.9).
  useEffect(() => {
    const onVisibility = () =>
      client.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [client]);

  // This laptop lost the room (token gone, or the room no longer exists):
  // open a fresh one.
  const { fatal, session, T0, clockReady } = snapshot;
  useEffect(() => {
    if (fatal) onLost();
  }, [fatal, onLost]);

  const show = session?.show ?? null;
  // Click track: null until the host toggles it, then their choice.
  const [clickChoice, setClickChoice] = useState<boolean | null>(null);
  const clickOn = clickChoice ?? clickTrackByDefault(session?.showId ?? "");
  const clickTimesMs = useMemo(
    () => (clickOn && show ? clickTimesForShow(show) : null),
    [clickOn, show],
  );
  const audio = useHostAudio(client, show, T0, clockReady, clickTimesMs);

  const camera = useCamera();
  const [cameraOpen, setCameraOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const screenShareRef = useRef(0.34);
  const recorder = useRecorder({
    room: {
      frame: () => frameRef.current,
      screenShare: () => screenShareRef.current,
    },
    audio: audio.audio,
    camera: camera.stream,
  });
  const presentRef = useRef<HTMLDivElement>(null);
  const [presenting, setPresenting] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setPresenting(document.fullscreenElement === presentRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // While presenting, the top bar shows when the mouse moves, then hides.
  const [awake, setAwake] = useState(false);
  useEffect(() => {
    if (!presenting) return;
    let timer = 0;
    const wake = () => {
      setAwake(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAwake(false), 2500);
    };
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      window.clearTimeout(timer);
    };
  }, [presenting]);
  const stage: StageShared = {
    camera,
    cameraOpen,
    setCameraOpen,
    recorder,
    frameRef,
    screenShareRef,
    presenting,
    /** The room (and camera) full screen, for casting; again to leave. */
    present: () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void presentRef.current?.requestFullscreen().catch(() => {});
    },
  };

  if (!session) {
    return (
      <main className={`${styles.room} ${body.className}`}>
        <div className={styles.message}>
          <span className={`${styles.mark} ${wordmark.className}`}>
            lightshow
          </span>
          <p>Connecting…</p>
        </div>
      </main>
    );
  }
  return (
    <div
      ref={presentRef}
      className={styles.presentRoot}
      data-presenting={presenting || undefined}
      data-awake={(presenting && awake) || undefined}
    >
      <ShowStudio
        key={session.showId}
        client={client}
        snapshot={snapshot}
        session={session}
        audio={audio}
        clickOn={clickOn}
        setClickOn={setClickChoice}
        onNewRoom={onLost}
        stage={stage}
      />
    </div>
  );
}

/** One editor store per loaded show. */
function ShowStudio(props: RoomProps) {
  const [store] = useState(() =>
    createEditorStore(initialEditorState(props.session.show)),
  );
  return (
    <EditorStoreProvider store={store}>
      <Studio {...props} />
    </EditorStoreProvider>
  );
}

/** Tools that draw on the room; after one shape the room goes back to select. */
const DRAWING_TOOLS = new Set(["shape", "brush", "moving", "fill"]);

function Studio({
  client,
  snapshot,
  session,
  audio,
  clickOn,
  setClickOn,
  onNewRoom,
  stage,
}: RoomProps) {
  const {
    camera,
    cameraOpen,
    setCameraOpen,
    recorder,
    frameRef,
    screenShareRef,
    presenting,
    present,
  } = stage;
  const store = useEditorStore();
  const readOnly = builtinShow(session.showId) !== undefined;
  const { participants, T0, clockReady, connection } = snapshot;
  const playing = T0 !== null;
  const liveShow = playing && clockReady ? session.show : null;
  const locked = playing || readOnly;
  const sync = useShowSync(store, client, session, readOnly, playing);
  const counts = useMemo(() => countByState(participants), [participants]);
  const canvasSize = useRef<Size>({ width: 0, height: 0 });
  const panels = usePanels();
  const [toastState, toast] = useToast();
  const fileId = useEditorSelector((s) => s.show.audio.fileId);
  const empty = useEditorSelector((s) => s.show.clips.length === 0);
  const tool = useEditorSelector((s) => s.tool);
  const decoded = useDecodedAudio(store, fileId);

  usePlayback(store, fileId, playing);
  usePlayheadFollowsShow(store, client, liveShow, T0);
  const dragged = useRoomPointer(frameRef, {
    store,
    client,
    participants,
    canPlace: !playing,
    canSelect: !playing,
  });

  // Drawing a shape is one-off: once it's added, go back to selecting.
  useEffect(() => {
    let count = store.getState().show.clips.length;
    return store.subscribe(() => {
      const s = store.getState();
      const next = s.show.clips.length;
      if (next > count && DRAWING_TOOLS.has(s.tool)) {
        store.dispatch({ type: "setTool", tool: "select" });
      }
      count = next;
    });
  }, [store]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (cmd && key === "s") {
        e.preventDefault();
        void sync.flush();
        return;
      }
      if (isTypingTarget(e.target) || playing) return;
      const handled = roomKey(e, cmd, key);
      if (handled) e.preventDefault();
    };
    const roomKey = (e: KeyboardEvent, cmd: boolean, key: string): boolean => {
      const state = store.getState();
      // A drawing tool sees keys first (Enter closes a shape, Esc cancels).
      const handler = toolHandlers[state.tool];
      if (
        !readOnly &&
        handler.onKeyDown?.(e.key, { store, size: canvasSize.current })
      ) {
        return true;
      }
      if (key === "escape") {
        store.dispatch({ type: "setDraft", draft: null });
        store.dispatch({ type: "select", selection: null });
        store.dispatch({ type: "setTool", tool: "select" });
        return true;
      }
      if (timelineKeys(store)(e)) return true;
      if (readOnly) return false;
      if (cmd && key === "z") {
        store.dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return true;
      }
      if (cmd && key === "y") {
        store.dispatch({ type: "redo" });
        return true;
      }
      if (cmd && key === "d") {
        duplicateSelected(store, toast);
        return true;
      }
      if (cmd && key === "c") {
        copySelected(store, toast);
        return true;
      }
      if (cmd && key === "v") {
        paste(store, toast);
        return true;
      }
      if (cmd || e.altKey) return false;
      if (key === "s") {
        splitSelected(store, toast);
        return true;
      }
      if (key === "delete" || key === "backspace") {
        deleteSelected(store, toast);
        return true;
      }
      return false;
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, sync, playing, readOnly, toast]);

  const screenHref = `/sessions/${session.code}/screen?join=${encodeURIComponent(session.joinUrl)}`;
  const inRoom = counts.total - counts.disconnected;
  const drawing = DRAWING_TOOLS.has(tool);
  // The screen to scale: its real width against the room's.
  const screenM = screenFromConfig(session.positioning).widthM;
  const room = snapshot.room;
  const screenShare = room
    ? Math.min(1, Math.max(0.02, screenM / room.widthM))
    : 0.34;
  // The recorder reads the screen's width every frame.
  useEffect(() => {
    screenShareRef.current = screenShare;
  }, [screenShare, screenShareRef]);

  return (
    <main
      className={`${styles.room} ${body.className}`}
      data-playing={playing || undefined}
    >
      {/* Inside <main>, so the dialog gets the room's colour variables. */}
      <MusicChooserProvider toast={toast}>
        <header className={styles.bar}>
          <div className={styles.left}>
            <span className={`${styles.mark} ${wordmark.className}`}>
              lightshow
            </span>
            <ShowPicker
              currentId={session.showId}
              readOnly={readOnly}
              disabled={playing || connection !== "open"}
              beforeSwitch={sync.flush}
              onLoad={(id) => client.loadShow(id)}
            />
            <SyncStatus
              state={sync.state}
              error={sync.error}
              readOnly={readOnly}
            />
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.ghost}
              aria-pressed={cameraOpen}
              disabled={cameraOpen && recorder.since !== null}
              title={
                cameraOpen && recorder.since !== null
                  ? "Stop recording first"
                  : "Film the crowd beside the room, and record both"
              }
              onClick={() => {
                if (cameraOpen) {
                  camera.close();
                  setCameraOpen(false);
                } else {
                  camera.open();
                  setCameraOpen(true);
                }
              }}
            >
              Camera
            </button>
            <a
              className={styles.ghost}
              href={screenHref}
              target="_blank"
              rel="noreferrer"
            >
              Open big screen
            </a>
            <Settings
              client={client}
              session={session}
              audio={audio}
              clickOn={clickOn}
              setClickOn={setClickOn}
              onNewRoom={onNewRoom}
            />
            <ShowControls
              client={client}
              snapshot={snapshot}
              counts={counts}
              show={session.show}
              ready={sync.state === "synced" || sync.state === "error"}
              onStart={() => {
                // The click is the gesture that lets the AudioContext run.
                void audio.audio.unlock();
                store.dispatch({ type: "setPlaying", playing: false });
                client.startShow();
              }}
            />
          </div>
        </header>

        <div
          className={styles.studio}
          style={{
            gridTemplateColumns: `${panels.sizes.left}px minmax(0, 1fr) ${panels.sizes.right}px`,
            gridTemplateRows: `minmax(0, 1fr) ${panels.sizes.bottom}px`,
          }}
        >
          <div
            className={panels.sizes.left ? styles.contents : styles.hiddenPanel}
          >
            <Library audio={decoded} disabled={locked} toast={toast} />
          </div>
          <section
            className={styles.stage}
            aria-label="Room"
            data-camera={cameraOpen || undefined}
          >
            <div ref={frameRef} className={styles.roomFrame}>
              <VenueCanvas
                layers={ROOM_LAYERS}
                className={styles.canvasFill}
                onResize={(size) => {
                  canvasSize.current = size;
                }}
              >
                <CrowdCanvas
                  client={client}
                  participants={participants}
                  liveShow={liveShow}
                  T0={T0}
                  dragged={dragged}
                />
                <div
                  className={styles.screenBar}
                  style={{ width: `${screenShare * 100}%` }}
                  aria-hidden
                />
                {room ? (
                  <p className={styles.roomSize}>
                    {metres(room.widthM)} across · {metres(room.depthM)} deep
                  </p>
                ) : null}
                <p className={styles.screenTag}>Screen</p>
                {empty && !readOnly && !drawing && !playing ? (
                  <Coach phonesIn={inRoom} screenHref={screenHref} />
                ) : null}
              </VenueCanvas>
            </div>
            {cameraOpen ? (
              <CameraPanel
                camera={camera}
                recorder={recorder}
                onPresent={present}
                presenting={presenting}
                toast={toast}
              />
            ) : null}
            {!cameraOpen ? (
              <button
                type="button"
                className={styles.presentButton}
                title={
                  presenting
                    ? "Leave full screen (Esc)"
                    : "Show the room full screen, for casting"
                }
                onClick={present}
              >
                {presenting ? "Exit" : "Present"}
              </button>
            ) : null}
            {drawing && !locked ? (
              <p className={styles.drawHint}>
                {tool === "brush"
                  ? "Paint an area on the room."
                  : "Drag a box on the room, or click its corners and press Enter."}{" "}
                <span>Esc to cancel</span>
              </p>
            ) : null}
            {toastState ? (
              <div key={toastState.id} className={styles.toast} role="status">
                {toastState.message}
                {toastState.undoable ? <span> · ⌘Z to undo</span> : null}
              </div>
            ) : null}
          </section>
          <div
            className={
              panels.sizes.right ? styles.contents : styles.hiddenPanel
            }
          >
            <Inspector
              counts={counts}
              playing={playing}
              readOnly={readOnly}
              toast={toast}
            />
          </div>
          <div
            className={
              panels.sizes.bottom ? styles.contents : styles.hiddenPanel
            }
          >
            <Timeline
              audio={decoded}
              locked={playing}
              readOnly={readOnly}
              toast={toast}
            />
          </div>
          {/* Dividers sit in the gaps between the room and the panels. */}
          <Splitter
            panel="left"
            size={panels.sizes.left}
            style={{
              left: STUDIO_PAD + panels.sizes.left + STUDIO_GAP / 2,
              top: 0,
              bottom: STUDIO_PAD + panels.sizes.bottom + STUDIO_GAP,
            }}
            onResize={(px, from) => panels.resize("left", px, from)}
            onToggle={() => panels.toggle("left")}
          />
          <Splitter
            panel="right"
            size={panels.sizes.right}
            style={{
              right: STUDIO_PAD + panels.sizes.right + STUDIO_GAP / 2,
              top: 0,
              bottom: STUDIO_PAD + panels.sizes.bottom + STUDIO_GAP,
            }}
            onResize={(px, from) => panels.resize("right", px, from)}
            onToggle={() => panels.toggle("right")}
          />
          <Splitter
            panel="bottom"
            size={panels.sizes.bottom}
            style={{
              left: STUDIO_PAD,
              right: STUDIO_PAD,
              bottom: STUDIO_PAD + panels.sizes.bottom + STUDIO_GAP / 2,
            }}
            onResize={(px, from) => panels.resize("bottom", px, from)}
            onToggle={() => panels.toggle("bottom")}
          />
        </div>
      </MusicChooserProvider>
    </main>
  );
}

/** "12 m", or "1.5 m" when small. */
function metres(m: number): string {
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

type SyncState = "synced" | "saving" | "updating" | "queued" | "error";

const SYNC_TEXT: Record<Exclude<SyncState, "error">, string> = {
  synced: "",
  saving: "Saving…",
  updating: "Updating phones…",
  queued: "Phones update after the show",
};

function SyncStatus({
  state,
  error,
  readOnly,
}: {
  state: SyncState;
  error: string | null;
  readOnly: boolean;
}) {
  if (readOnly) return <span className={styles.status}>Test show</span>;
  return (
    <span
      className={styles.status}
      data-error={state === "error" || undefined}
      role="status"
    >
      {state === "error"
        ? `Couldn’t save: ${error ?? "unknown error"}`
        : SYNC_TEXT[state]}
    </span>
  );
}

/**
 * Autosave: edits are saved `AUTOSAVE_MS` after they stop, then loaded into
 * the room so every phone recompiles (SPEC 2.5). While a show plays the room
 * refuses loads, so the reload waits for Stop. `flush` saves now, for
 * switching shows and Cmd+S.
 */
function useShowSync(
  store: EditorStore,
  client: HostClient,
  session: SessionMessage,
  readOnly: boolean,
  playing: boolean,
): { state: SyncState; error: string | null; flush: () => Promise<void> } {
  const [state, setState] = useState<SyncState>("synced");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const playingRef = useRef(playing);
  const queued = useRef(false);
  const showId = session.showId;
  // `flush` re-arms itself through this, as a callback can't name itself.
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushRef.current(), ms);
  }, []);

  const load = useCallback(() => {
    if (playingRef.current || !client.loadShow(showId)) {
      queued.current = true;
      setState("queued");
      return;
    }
    queued.current = false;
    setState("updating");
  }, [client, showId]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (readOnly || !isDirty(store.getState())) return;
    setState("saving");
    await saveEditorShow(store);
    const after = store.getState();
    if (after.saveStatus === "error") {
      setError(after.saveError);
      setState("error");
      schedule(RETRY_MS);
      return;
    }
    setError(null);
    if (isDirty(after)) {
      // Edited while saving: go round again.
      schedule(AUTOSAVE_MS);
    }
    load();
  }, [store, readOnly, load, schedule]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // Save a moment after the show changes.
  useEffect(() => {
    let revision = store.getState().revision;
    const unsubscribe = store.subscribe(() => {
      const next = store.getState().revision;
      if (next === revision || readOnly) return;
      revision = next;
      setState("saving");
      schedule(AUTOSAVE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer.current);
    };
  }, [store, readOnly, schedule]);

  // A reload held back by a running show goes out on Stop.
  useEffect(() => {
    playingRef.current = playing;
    if (!playing && queued.current) load();
  }, [playing, load]);

  // The room answers a load with a new session message.
  useEffect(() => {
    // Clearing "updating" when the room's answer arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => (s === "updating" ? "synced" : s));
  }, [session]);

  // Warn before closing the tab with an edit not yet saved.
  useEffect(() => {
    if (state !== "saving") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state]);

  return { state, error, flush };
}

/** While the show plays, the editor's playhead follows it on every frame. */
function usePlayheadFollowsShow(
  store: EditorStore,
  client: HostClient,
  liveShow: SessionMessage["show"] | null,
  T0: number | null,
) {
  useEffect(() => {
    if (!liveShow || T0 === null) return;
    store.dispatch({ type: "setPlaying", playing: false });
    const durationMs = showDurationMs(liveShow);
    let raf = 0;
    const follow = () => {
      raf = requestAnimationFrame(follow);
      const showMs = client.clock.serverNow() - T0;
      const timeMs = Math.min(Math.max(0, showMs), durationMs);
      store.dispatch({ type: "seek", timeMs });
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [store, client, liveShow, T0]);
}

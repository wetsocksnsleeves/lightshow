"use client";

import { useCallback, useState } from "react";
import {
  createShow,
  deleteShow,
  listShows,
  type ShowListItem,
} from "@/components/editor/api";
import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import { BUILTIN_SHOWS } from "@/lib/builtin-shows";
import { showDurationMs } from "@/lib/compile";
import { clockText } from "@/lib/host-map";
import styles from "./room.module.css";

/**
 * The loaded show's name (editable) and a menu to load another show, make a
 * new one, or delete one. Loading swaps the show for every phone in the room
 * without disconnecting them.
 */
export function ShowPicker({
  currentId,
  readOnly,
  disabled,
  beforeSwitch,
  onLoad,
}: {
  currentId: string;
  readOnly: boolean;
  /** No switching while the show plays or the room is offline. */
  disabled: boolean;
  /** Save pending edits first. */
  beforeSwitch: () => Promise<void>;
  onLoad: (showId: string) => void;
}) {
  const store = useEditorStore();
  const name = useEditorSelector((s) => s.show.name);
  const [open, setOpen] = useState(false);
  const [shows, setShows] = useState<ShowListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setShows(await listShows());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const load = async (id: string) => {
    setOpen(false);
    if (id === currentId) return;
    await beforeSwitch();
    onLoad(id);
  };

  const create = async () => {
    try {
      await beforeSwitch();
      const show = await createShow({ name: "Untitled show" });
      setOpen(false);
      onLoad(show.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (show: ShowListItem) => {
    if (!window.confirm(`Delete "${show.name}"? This can’t be undone.`)) return;
    try {
      await deleteShow(show.id);
      setShows((list) => list?.filter((s) => s.id !== show.id) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={styles.picker}>
      <input
        className={styles.showName}
        aria-label="Show name"
        value={name}
        maxLength={200}
        readOnly={readOnly}
        size={Math.max(8, Math.min(28, name.length + 1))}
        onChange={(e) =>
          store.dispatch({ type: "renameShow", name: e.target.value })
        }
      />
      <button
        type="button"
        className={styles.pickerButton}
        aria-label="Shows"
        aria-expanded={open}
        disabled={disabled}
        title={disabled ? "Stop the show to switch" : "Switch show"}
        onClick={() => {
          setOpen((o) => !o);
          void refresh();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div className={styles.menu} role="menu">
            {shows === null && !error ? (
              <p className={styles.menuNote}>Loading…</p>
            ) : null}
            {shows?.map((s) => (
              <div key={s.id} className={styles.menuRow}>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  aria-current={s.id === currentId || undefined}
                  onClick={() => void load(s.id)}
                >
                  {s.name}
                  <span>
                    {clockText(s.durationMs)}
                    {s.id === currentId ? " · loaded" : ""}
                  </span>
                </button>
                {s.id === currentId ? null : (
                  <button
                    type="button"
                    className={styles.menuDelete}
                    aria-label={`Delete ${s.name}`}
                    onClick={() => void remove(s)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {shows?.length ? <hr /> : null}
            {BUILTIN_SHOWS.map(({ show }) => (
              <button
                key={show.id}
                type="button"
                role="menuitem"
                className={styles.menuItem}
                aria-current={show.id === currentId || undefined}
                onClick={() => void load(show.id)}
              >
                {show.name}
                <span>
                  {clockText(showDurationMs(show))} · test
                  {show.id === currentId ? " · loaded" : ""}
                </span>
              </button>
            ))}
            <hr />
            <button
              type="button"
              role="menuitem"
              className={styles.menuItem}
              onClick={() => void create()}
            >
              + New show
            </button>
            {error ? (
              <p className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

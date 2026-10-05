import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const PANEL_WIDTH_KEY = "snoboard:details-width:v1";
/** Same as the old fixed `max-w-xl`. */
export const DEFAULT_PANEL_WIDTH = 576;
export const MIN_PANEL_WIDTH = 360;
/** Fraction of the viewport the panel may take. */
export const MAX_PANEL_FRACTION = 0.9;
export const PANEL_KEY_STEP = 16;
/** Below this viewport width the panel is full width and cannot be resized. */
export const MOBILE_BREAKPOINT = 640;

export function maxPanelWidth(viewport: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.floor(viewport * MAX_PANEL_FRACTION));
}

export function clampPanelWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return Math.min(DEFAULT_PANEL_WIDTH, maxPanelWidth(viewport));
  return Math.round(Math.min(maxPanelWidth(viewport), Math.max(MIN_PANEL_WIDTH, width)));
}

function readStored(): number | undefined {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_KEY);
    if (raw === null || !/^\d{2,5}$/.test(raw)) return undefined;
    return Number(raw);
  } catch {
    return undefined;
  }
}

function store(width: number | undefined): void {
  try {
    if (width === undefined) window.localStorage.removeItem(PANEL_WIDTH_KEY);
    else window.localStorage.setItem(PANEL_WIDTH_KEY, String(width));
  } catch {
    // Private mode or a full quota: the width just is not remembered.
  }
}

function viewportWidth(): number {
  return typeof window === "undefined" ? 1280 : window.innerWidth;
}

/** Remembered details panel width, clamped to the current viewport. `null` on narrow screens. */
export function usePanelWidth() {
  const [viewport, setViewport] = useState(viewportWidth);
  const [preferred, setPreferred] = useState<number>(() =>
    typeof window === "undefined" ? DEFAULT_PANEL_WIDTH : (readStored() ?? DEFAULT_PANEL_WIDTH),
  );

  useEffect(() => {
    const onResize = () => setViewport(viewportWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const mobile = viewport < MOBILE_BREAKPOINT;
  const width = clampPanelWidth(preferred, viewport);
  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampPanelWidth(next, viewportWidth());
      setPreferred(clamped);
      store(clamped);
    },
    [],
  );
  const reset = useCallback(() => {
    setPreferred(DEFAULT_PANEL_WIDTH);
    store(undefined);
  }, []);
  return { width: mobile ? null : width, min: MIN_PANEL_WIDTH, max: maxPanelWidth(viewport), setWidth, reset };
}

/**
 * Drag handle on the panel's left edge. The panel is anchored right, so moving the pointer
 * left widens it. Keyboard: arrows ±16 px, Home/End jump to min/max; double-click resets.
 */
export function PanelResizeHandle({
  width,
  min,
  max,
  onResize,
  onReset,
}: {
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    onResize(current.startWidth + (current.startX - event.clientX));
  }

  function onPointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: number | undefined;
    // Left widens (the edge moves left), right narrows.
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = width + PANEL_KEY_STEP;
    else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = width - PANEL_KEY_STEP;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === undefined) return;
    event.preventDefault();
    onResize(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details panel"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid="details-resize"
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover:after:bg-ring focus-visible:after:w-0.5 focus-visible:after:bg-ring"
    />
  );
}

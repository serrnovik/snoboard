// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_WIDTH_KEY,
  PanelResizeHandle,
  usePanelWidth,
} from "./panel-width";

function Harness() {
  const panel = usePanelWidth();
  if (panel.width === null) return <p data-testid="mobile">full width</p>;
  return (
    <div data-testid="panel" style={{ width: panel.width }}>
      <PanelResizeHandle width={panel.width} min={panel.min} max={panel.max} onResize={panel.setWidth} onReset={panel.reset} />
    </div>
  );
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
}

beforeEach(() => {
  setViewport(1000);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("details panel width", () => {
  it("clamps to 360 px and 90% of the viewport", () => {
    expect(clampPanelWidth(100, 1000)).toBe(MIN_PANEL_WIDTH);
    expect(clampPanelWidth(2000, 1000)).toBe(900);
    expect(clampPanelWidth(500, 1000)).toBe(500);
    expect(clampPanelWidth(Number.NaN, 1000)).toBe(DEFAULT_PANEL_WIDTH);
    expect(clampPanelWidth(500, 300)).toBe(MIN_PANEL_WIDTH);
  });

  it("is a keyboard separator: arrows move 16 px, Home and End jump to the limits, and it persists", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator", { name: "Resize details panel" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_PANEL_WIDTH));
    expect(handle.getAttribute("aria-valuemin")).toBe("360");
    expect(handle.getAttribute("aria-valuemax")).toBe("900");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_PANEL_WIDTH + 16));
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_PANEL_WIDTH - 16));
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe(String(DEFAULT_PANEL_WIDTH - 16));
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("900");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("360");
  });

  it("follows a pointer drag on the left edge and resets on double-click", () => {
    render(<Harness />);
    const handle = screen.getByRole("separator");
    fireEvent.pointerDown(handle, { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_PANEL_WIDTH + 100));
    fireEvent.pointerMove(handle, { clientX: -500, pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe("900");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 });
    expect(handle.getAttribute("aria-valuenow")).toBe("900");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_PANEL_WIDTH));
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBeNull();
  });

  it("restores the stored width, clamped to the current viewport, and ignores junk", () => {
    localStorage.setItem(PANEL_WIDTH_KEY, "700");
    render(<Harness />);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("700");
    act(() => {
      setViewport(700);
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("630");
    cleanup();
    setViewport(1000);
    localStorage.setItem(PANEL_WIDTH_KEY, "wide");
    render(<Harness />);
    expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe(String(DEFAULT_PANEL_WIDTH));
  });

  it("keeps the panel full width with no handle on narrow screens", () => {
    setViewport(500);
    render(<Harness />);
    expect(screen.getByTestId("mobile")).toBeTruthy();
    expect(screen.queryByRole("separator")).toBeNull();
  });
});

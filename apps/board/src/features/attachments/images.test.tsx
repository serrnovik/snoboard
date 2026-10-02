// @vitest-environment jsdom

import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BoardItem } from "snoboard/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentPayload } from "@/features/basket/SubmitDialog";
import { resetBasketStore, useBasket } from "@/features/basket/store";
import { EditControls } from "@/features/details/EditControls";
import { SummaryMarkdown } from "@/features/details/markdown";
import { assetPathOf, resolveImageSrc } from "./images";
import { memoryImageBackend, setImageBackend } from "./store";

const HASH = "ab".repeat(32);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let images: ReturnType<typeof memoryImageBackend>;

beforeEach(() => {
  images = memoryImageBackend();
  setImageBackend(images);
  let next = 0;
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:http://localhost/image-${(next += 1)}`),
      revokeObjectURL: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setImageBackend(undefined);
  localStorage.clear();
  resetBasketStore();
});

function item(): BoardItem {
  return {
    id: "acme-002",
    title: "Billing",
    status: "planned",
    priority: "p1",
    depends_on: [],
    updated: "2026-09-29",
    path: "initiatives/acme/002-billing/initiative.md",
    project: "acme",
    number: "002",
    summary: "Charge customers.",
    sourceRef: "main",
    sourceSha: "abc",
    updatedAt: "2026-09-29T00:00:00.000Z",
    isReady: true,
    blockedBy: [],
    onBranches: ["main"],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockApis(existingAssets: readonly string[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/edit-config")) {
      return json({ enabled: true, modes: ["direct"], canSubmit: false, needsGithubWrite: false, defaultMode: "direct" });
    }
    if (url.endsWith("/board")) {
      return json({ config: { statuses: ["planned", "done"], priorities: ["p1", "p2"], doneStatuses: ["done"] } });
    }
    if (url.endsWith("/body")) return json({ body: "Intro\n", hash: HASH });
    if (existingAssets.some((name) => url.endsWith(`/assets/${name}`))) return new Response(null, { status: 200 });
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("image attachments", () => {
  it("paste an image: bytes go to IndexedDB, the basket keeps a reference, markdown is inserted", async () => {
    const user = userEvent.setup();
    mockApis(["shot.png"]);
    const basket = renderHook(() => useBasket());
    render(<EditControls item={item()} />);
    await user.click(await screen.findByRole("button", { name: "Edit text" }));
    const wrapper = await screen.findByTestId("markdown-editor", {}, { timeout: 10_000 });
    const textarea = await waitFor(() => {
      const found = wrapper.querySelector("textarea");
      if (found === null) throw new Error("no textarea");
      return found;
    });
    expect(screen.getByRole("button", { name: "Attach image" })).toBeTruthy();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const file = new File([PNG], "Shot.png", { type: "image/png" });
    fireEvent.paste(textarea, { clipboardData: { files: [file], types: ["Files"] } });

    // shot.png is already committed, so the new name gets a suffix.
    await waitFor(() => expect(textarea.value).toBe("Intro\n![Shot](assets/shot-2.png)\n"));
    const preview = wrapper.querySelector(".wmde-markdown");
    await waitFor(() => expect(preview?.querySelector("img")?.getAttribute("src")).toBe("blob:http://localhost/image-1"));

    await user.click(screen.getByRole("button", { name: "Save" }));
    const edits = basket.result.current.list();
    expect(edits[0]).toMatchObject({ kind: "setBody", id: "acme-002", to: "Intro\n![Shot](assets/shot-2.png)\n" });
    expect(edits[1]).toMatchObject({
      kind: "addAttachment",
      id: "acme-002",
      path: "assets/shot-2.png",
      contentType: "image/png",
      size: PNG.length,
    });
    const stored = JSON.parse(localStorage.getItem("snoboard:basket:v1:default") ?? "[]") as Record<string, unknown>[];
    expect(JSON.stringify(stored)).not.toContain("base64");
    expect(images.size()).toBe(1);

    const payload = await attachmentPayload(edits);
    if ("error" in payload) throw new Error(payload.error);
    const edit = edits[1];
    if (edit?.kind !== "addAttachment") throw new Error("no attachment");
    expect(payload.map[edit.sha256]).toBe(btoa(String.fromCharCode(...PNG)));

    basket.result.current.clear();
    await waitFor(() => expect(images.size()).toBe(0));
  });

  it("refuses files that are not PNG, JPEG, WebP or GIF by their bytes", async () => {
    const user = userEvent.setup();
    mockApis();
    const basket = renderHook(() => useBasket());
    render(<EditControls item={item()} />);
    await user.click(await screen.findByRole("button", { name: "Edit text" }));
    const wrapper = await screen.findByTestId("markdown-editor", {}, { timeout: 10_000 });
    const input = await waitFor(() => {
      const found = wrapper.querySelector<HTMLInputElement>("input[type=file]");
      if (found === null) throw new Error("no input");
      return found;
    });
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "logo.png", { type: "image/png" });
    await user.upload(input, svg);
    expect((await screen.findByRole("alert")).textContent).toContain("not a PNG, JPEG, WebP or GIF");
    expect(images.size()).toBe(0);
    expect(basket.result.current.list()).toEqual([]);
  });

  it("previews only assets/ paths: committed through the endpoint, remote URLs blocked", () => {
    expect(assetPathOf("./assets/a.png")).toBe("assets/a.png");
    expect(assetPathOf("assets/../x.png")).toBeUndefined();
    expect(resolveImageSrc("assets/a.png", { repoId: "acme", id: "acme-002" })).toBe(
      "/api/repos/acme/initiatives/acme-002/assets/a.png",
    );
    expect(resolveImageSrc("assets/a.png", { repoId: "acme", pending: new Map([["assets/a.png", "blob:x"]]) })).toBe(
      "blob:x",
    );
    expect(resolveImageSrc("assets/a.png", { repoId: "acme" })).toBe("");
    for (const remote of ["https://example.com/a.png", "//example.com/a.png", "data:image/png;base64,AAAA", "/etc/a.png"]) {
      expect(resolveImageSrc(remote, { repoId: "acme", id: "acme-002" }), remote).toBe("");
    }

    render(
      <SummaryMarkdown
        markdown={"![ok](assets/a.png)\n\n![remote](https://example.com/y.png)"}
        resolveImage={(src) => resolveImageSrc(src, { repoId: "default", id: "acme-002" })}
      />,
    );
    const shown = [...document.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(shown).toEqual(["/api/repos/default/initiatives/acme-002/assets/a.png"]);
    expect(document.body.textContent).toContain("[remote]");
  });
});

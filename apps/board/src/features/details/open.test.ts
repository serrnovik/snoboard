// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  currentOpenDoc,
  currentOpenId,
  documentHref,
  setOpenDoc,
  setOpenId,
} from "./open.js";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("document query", () => {
  it("reads ?doc=, optional ?format=html, and #heading", () => {
    expect(currentOpenDoc("?open=acme-002", "")).toBeNull();
    expect(currentOpenDoc("?open=acme-002&doc=ROADMAP", "")).toEqual({ key: "ROADMAP", format: "md" });
    expect(currentOpenDoc("?doc=reports/final.report&format=html", "#later")).toEqual({
      key: "reports/final.report",
      format: "html",
      anchor: "later",
    });
    expect(currentOpenDoc("?doc=../secret", "")).toBeNull();
    expect(currentOpenDoc("?doc=/etc/passwd", "")).toBeNull();
    expect(currentOpenDoc("?doc=", "")).toBeNull();
  });

  it("writes ?doc= into the address bar and drops it when the viewer closes", () => {
    window.history.replaceState(null, "", "/r/acme/?open=acme-002&project=billing");
    setOpenDoc({ key: "ROADMAP", format: "md" });
    expect(window.location.pathname).toBe("/r/acme/");
    expect(window.location.search).toBe("?open=acme-002&project=billing&doc=ROADMAP");
    expect(currentOpenDoc()).toEqual({ key: "ROADMAP", format: "md" });

    setOpenDoc({ key: "reports/final.report", format: "html", anchor: "later" });
    expect(window.location.search).toBe("?open=acme-002&project=billing&doc=reports%2Ffinal.report&format=html");
    expect(window.location.hash).toBe("#later");

    setOpenDoc(null);
    expect(window.location.search).toBe("?open=acme-002&project=billing");
    expect(window.location.hash).toBe("");
    expect(currentOpenDoc()).toBeNull();
  });

  it("builds a copyable href that keeps the open initiative", () => {
    window.history.replaceState(null, "", "/r/acme/?open=acme-002");
    expect(documentHref("decisions")).toBe("/r/acme/?open=acme-002&doc=decisions");
    expect(documentHref("ROADMAP", { format: "html" })).toBe("/r/acme/?open=acme-002&doc=ROADMAP&format=html");
  });

  it("drops the document when the initiative changes or the panel closes", () => {
    window.history.replaceState(null, "", "/?open=acme-001&doc=ROADMAP");
    setOpenId("acme-002");
    expect(currentOpenId()).toBe("acme-002");
    expect(currentOpenDoc()).toBeNull();
    expect(window.location.search).toBe("?open=acme-002");

    setOpenDoc({ key: "ROADMAP", format: "md" });
    setOpenId(null);
    expect(window.location.search).toBe("");
    expect(currentOpenDoc()).toBeNull();
  });
});

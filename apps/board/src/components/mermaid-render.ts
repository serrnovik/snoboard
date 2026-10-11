import type { MermaidConfig } from "mermaid";

type MermaidApi = (typeof import("mermaid"))["default"];

let loading: Promise<MermaidApi> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;

/** Loads mermaid on first use only, so pages without diagrams never fetch it. */
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((module) => module.default);
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

// Keys a diagram's own `%%{init}%%` directive or front matter may not override.
const SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
  "theme",
  "themeCSS",
  "themeVariables",
  "darkMode",
  "fontFamily",
  "altFontFamily",
];

/** Strict mode sanitizes labels and disables click callbacks; directives cannot loosen it. */
export function mermaidConfig(dark: boolean): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    theme: dark ? "dark" : "default",
    darkMode: dark,
    secure: SECURE_KEYS,
  };
}

const BLOCKED_TAGS = "script, iframe, object, embed, img, image, audio, video";
const REMOTE_CSS = /@import[^;]*;?|url\(\s*(?!['"]?#)[^)]*\)/gi;

/**
 * Defense in depth on top of mermaid strict mode: parse the SVG in an inert template,
 * drop scripting and media elements, event handler attributes, every non-fragment link
 * target and any CSS that could load a remote resource.
 */
export function hardenSvg(svg: string): string {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const root = template.content;
  for (const element of root.querySelectorAll(BLOCKED_TAGS)) element.remove();
  for (const style of root.querySelectorAll("style")) style.textContent = (style.textContent ?? "").replace(REMOTE_CSS, "");
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      else if ((name === "href" || name === "xlink:href") && !attribute.value.trim().startsWith("#")) {
        element.removeAttribute(attribute.name);
      } else if (name === "style" && REMOTE_CSS.test(attribute.value)) {
        element.setAttribute("style", attribute.value.replace(REMOTE_CSS, ""));
      }
      REMOTE_CSS.lastIndex = 0;
    }
  }
  const output = root.querySelector("svg");
  return output === null ? "" : output.outerHTML;
}

/** Renders one diagram to hardened SVG markup. Renders run one at a time because the theme is global. */
export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(mermaidConfig(dark));
    sequence += 1;
    const id = `snoboard-mermaid-${sequence}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return hardenSvg(svg);
    } finally {
      // Mermaid renders in a temporary node; make sure nothing is left behind on errors.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

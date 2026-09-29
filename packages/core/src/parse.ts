import { parse } from "yaml";
import { z } from "zod";
import type { Config } from "./config.js";
import { InitiativeFrontmatterSchema, type InitiativeFrontmatter } from "./schema.js";

export type ParsedFile =
  | {
      kind: "initiative";
      path: string;
      project: string;
      number: string;
      frontmatter: InitiativeFrontmatter;
      summary: string;
    }
  | {
      kind: "legacy";
      path: string;
      project: string;
      number: string;
      title: string;
      summary: string;
    }
  | {
      kind: "error";
      path: string;
      message: string;
    };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "frontmatter";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function extractSummary(body: string): string {
  const lines = normalizeNewlines(body).split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Summary");
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function legacyTitle(body: string): string {
  const match = /(?:^|\n)# (?!#)(.*)/.exec(normalizeNewlines(body));
  if (!match) return "";
  return match[1]!.replace(/^Initiative:\s*/, "").trim();
}

function locateInitiative(
  filePath: string,
  config: Config,
): { project: string; number: string } | undefined {
  const parts = filePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  const rootParts = config.root
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  if (parts.length !== rootParts.length + 3) return undefined;
  if (rootParts.some((part, index) => parts[index] !== part)) return undefined;
  const project = parts[rootParts.length];
  const folder = parts[rootParts.length + 1];
  const file = parts[rootParts.length + 2];
  if (file !== config.file || project === undefined || folder === undefined) {
    return undefined;
  }
  const match = /^(\d{3})-.+$/.exec(folder);
  if (!match?.[1]) return undefined;
  return { project, number: match[1] };
}

function errorFile(path: string, message: string): ParsedFile {
  return { kind: "error", path, message };
}

export function parseInitiativeFile(path: string, text: string, config: Config): ParsedFile {
  const located = locateInitiative(path, config);
  if (!located) {
    return errorFile(
      path,
      `Path does not match ${config.root}/<project>/<NNN>-<slug>/${config.file}`,
    );
  }

  const source = text.replace(/^\uFEFF/, "");
  let body = source;

  if (!source.startsWith("---")) {
    return {
      kind: "legacy",
      path,
      project: located.project,
      number: located.number,
      title: legacyTitle(body),
      summary: extractSummary(body),
    };
  }

  const matched = FRONTMATTER.exec(source);
  if (!matched) {
    return errorFile(path, "Initiative frontmatter was not closed");
  }

  const yamlText = matched[1] ?? "";
  body = matched[2] ?? "";
  let raw: unknown;
  try {
    raw = parse(yamlText, { schema: "core" });
  } catch (error) {
    // Legacy files may carry hand-written YAML that doesn't parse. Only files
    // that opted in (an `id:` key) are reported as errors.
    if (!/^id\s*:/m.test(yamlText)) {
      return {
        kind: "legacy",
        path,
        project: located.project,
        number: located.number,
        title: legacyTitle(body),
        summary: extractSummary(body),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorFile(path, message);
  }

  if (raw === null || raw === undefined || (isRecord(raw) && !Object.prototype.hasOwnProperty.call(raw, "id"))) {
    return {
      kind: "legacy",
      path,
      project: located.project,
      number: located.number,
      title: legacyTitle(body),
      summary: extractSummary(body),
    };
  }
  if (!isRecord(raw) || raw.id === null || raw.id === undefined) {
    if (!isRecord(raw)) return errorFile(path, "Frontmatter must be a mapping");
    return {
      kind: "legacy",
      path,
      project: located.project,
      number: located.number,
      title: legacyTitle(body),
      summary: extractSummary(body),
    };
  }

  const parsed = InitiativeFrontmatterSchema(config).safeParse(raw);
  if (!parsed.success) {
    return errorFile(path, formatIssues(parsed.error));
  }

  return {
    kind: "initiative",
    path,
    project: located.project,
    number: located.number,
    frontmatter: parsed.data,
    summary: extractSummary(body),
  };
}
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { fetch as fetchRefs, listInitiativeFiles, listRefs, readBlobs } from "./git.js";
import { buildSnapshot, type BoardItem } from "./merge.js";
import { parseInitiativeFile, type ParsedFile } from "./parse.js";
import { fixInitiativeText, formatFixEvent, type FixEvent } from "./fix.js";
import { validate, type ValidationIssue } from "./validate.js";
import { MAX_ICON_BYTES, parseIcon } from "./icons.js";
import { VERSION } from "./version.js";

const HELP = `snoboard — read and check initiative documents

Usage:
  snoboard validate [--repo <dir>] [--ref <ref>] [--changed-since <ref>] [--json]
  snoboard next-number <project> [--repo <dir>] [--fetch]
  snoboard status [--ready | --stale] [--project <project>] [--repo <dir>] [--json]
  snoboard new <project> <slug> [--title <title>] [--priority <priority>] [--repo <dir>] [--fetch]
  snoboard fix [--repo <dir>] [--dry-run] [--json] [paths...]
  snoboard --version
  snoboard --help

Commands:
  validate      Check initiative files. Exits 1 when any issue is an error.
  next-number   Print the next free NNN for a project.
  status        List initiatives as a table, or as JSON with --json.
  new           Create the next initiative from the built-in template.
  fix           Normalise opted-in initiative files in the working tree.

Global flags:
  --repo <dir>  Repository root. Defaults to the current directory.
  --version     Print the version and exit.
  --help        Print this help and exit.

validate:
  --ref <ref>            Read files from this git ref instead of the working tree.
  --changed-since <ref>  Validate only files changed since <ref>, using
                         git diff --name-only <ref>...HEAD limited to the
                         configured root. Id uniqueness is still checked
                         across the whole repository.
  --json                 Print issues as JSON.

next-number:
  --fetch                Run git fetch against origin before numbering.

status:
  --ready                Only initiatives whose dependencies are all done.
  --stale                Only initiatives past the stale window.
  --project <project>    Only this project.
  --json                 Print JSON.

new:
  --title <title>        Initiative title. Defaults to a title derived from the slug.
  --priority <priority>  Priority. Defaults to p2.
  --fetch                Run git fetch against origin before choosing the number.

fix:
  --dry-run              Print pending changes and exit 1. Write nothing.
  --json                 Print changes and reports as JSON.
  paths                  Optional initiative files or directories. Defaults to
                         every initiative file under the configured root.

Exit codes:
  0  Success. Warnings alone do not fail validate. fix exits 0 when nothing
     changed or every change was written.
  1  Validation errors, pending fix changes with --dry-run, or the command failed.
  2  Invalid arguments.
`;

const OPTIONS = {
  repo: { type: "string" },
  ref: { type: "string" },
  "changed-since": { type: "string" },
  json: { type: "boolean" },
  "dry-run": { type: "boolean" },
  fetch: { type: "boolean" },
  ready: { type: "boolean" },
  stale: { type: "boolean" },
  project: { type: "string" },
  title: { type: "string" },
  priority: { type: "string" },
  version: { type: "boolean" },
  help: { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

type FlagValues = {
  repo?: string;
  ref?: string;
  "changed-since"?: string;
  json?: boolean;
  "dry-run"?: boolean;
  fetch?: boolean;
  ready?: boolean;
  stale?: boolean;
  project?: string;
  title?: string;
  priority?: string;
  version?: boolean;
  help?: boolean;
};

const PROJECT_NAME = /^[a-z0-9_][a-z0-9_-]*$/;
const SLUG_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLDER_NUMBER = /^(\d{3})-/;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  /** Observes git argv (without the leading `git`) for tests. */
  onGit?: (args: readonly string[]) => void;
}

class CommandError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

class UsageError extends CommandError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function normalize(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function repoRelative(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split(/[/\\]/))
    .filter((part) => part.length > 0 && part !== ".")
    .join("/");
}

function runningAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) return false;
  // npm/pnpm global installs start the bin through a symlink or shim, so
  // compare real paths rather than the literal argv[1].
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry));
  } catch {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  }
}

export async function main(argv: readonly string[], io?: Partial<CliIo>): Promise<number> {
  const stdout = io?.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io?.stderr ?? ((text: string) => process.stderr.write(text));
  const cwd = io?.cwd ?? process.cwd();
  const full: CliIo = { stdout, stderr, cwd, onGit: io?.onGit };
  try {
    return await run(argv, full);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = message.endsWith("\n") ? message : `${message}\n`;
    if (error instanceof UsageError) {
      stderr(`${line}Run snoboard --help for usage.\n`);
      return error.exitCode;
    }
    stderr(line);
    return error instanceof CommandError ? error.exitCode : 1;
  }
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let values: FlagValues;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values as FlagValues;
    positionals = parsed.positionals;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(message);
  }

  if (values.version === true) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (values.help === true) {
    io.stdout(HELP);
    return 0;
  }

  const command = positionals[0];
  if (command === undefined) {
    throw new UsageError("Missing command.");
  }

  switch (command) {
    case "validate":
      rejectExtra(positionals, 1, "validate does not take positional arguments.");
      rejectFlags(values, ["repo", "ref", "changed-since", "json"]);
      return validateCommand(values, io);
    case "next-number":
      if (positionals.length < 2) throw new UsageError("next-number requires a project.");
      rejectExtra(positionals, 2, "next-number takes one project.");
      rejectFlags(values, ["repo", "fetch"]);
      return nextNumberCommand(positionals[1] ?? "", values, io);
    case "status":
      rejectExtra(positionals, 1, "status does not take positional arguments.");
      rejectFlags(values, ["repo", "ready", "stale", "project", "json"]);
      return statusCommand(values, io);
    case "new":
      if (positionals.length < 3) throw new UsageError("new requires a project and a slug.");
      rejectExtra(positionals, 3, "new takes a project and a slug.");
      rejectFlags(values, ["repo", "title", "priority", "fetch"]);
      return newCommand(positionals[1] ?? "", positionals[2] ?? "", values, io);
    case "fix":
      rejectFlags(values, ["repo", "dry-run", "json"]);
      return fixCommand(positionals.slice(1), values, io);
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

function rejectExtra(positionals: readonly string[], count: number, message: string): void {
  if (positionals.length > count) throw new UsageError(message);
}

function rejectFlags(values: FlagValues, allowed: readonly string[]): void {
  const present: Array<[keyof FlagValues, string]> = [
    ["repo", "repo"],
    ["ref", "ref"],
    ["changed-since", "changed-since"],
    ["json", "json"],
    ["dry-run", "dry-run"],
    ["fetch", "fetch"],
    ["ready", "ready"],
    ["stale", "stale"],
    ["project", "project"],
    ["title", "title"],
    ["priority", "priority"],
  ];
  for (const [key, flag] of present) {
    if (allowed.includes(key)) continue;
    const value = values[key];
    if (value === undefined || value === false) continue;
    throw new UsageError(`--${flag} is not valid for this command.`);
  }
}

async function repoDirOf(values: FlagValues, io: CliIo): Promise<string> {
  return path.resolve(io.cwd, values.repo ?? ".");
}

async function readConfig(repoDir: string): Promise<Config> {
  const configPath = path.join(repoDir, ".snoboard.yml");
  try {
    return loadConfig(await readFile(configPath, "utf8"));
  } catch (error) {
    if (isEnoent(error)) return loadConfig();
    throw error;
  }
}

async function validateCommand(values: FlagValues, io: CliIo): Promise<number> {
  const repoDir = await repoDirOf(values, io);
  const config = await readConfig(repoDir);
  const files =
    values.ref !== undefined
      ? await readAtRef(repoDir, values.ref, config)
      : await readWorkingTree(repoDir, config);
  files.sort((left, right) => left.path.localeCompare(right.path));
  let issues = validate(files, config);
  if (values.ref === undefined) issues.push(...(await iconFileIssues(repoDir, files, config)));
  const changedSince = values["changed-since"];
  if (changedSince !== undefined) {
    const changed = await changedPaths(repoDir, changedSince, config, io.onGit);
    const changedIds = idsOnPaths(files, changed);
    issues = issues.filter((issue) => issueApplies(issue, changed, changedIds));
  }
  if (values.json === true) {
    io.stdout(`${JSON.stringify(issues, null, 2)}\n`);
  } else {
    for (const issue of issues) io.stdout(formatIssue(issue));
  }
  return issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

/** Working tree only: image icons must be regular files inside the repository, at most 256 KB. */
async function iconFileIssues(repoDir: string, files: readonly ParsedFile[], config: Config): Promise<ValidationIssue[]> {
  const wanted: { path: string; field: string; icon: string }[] = [];
  for (const [project, display] of Object.entries(config.projects ?? {})) {
    const icon = parseIcon(display.icon);
    if (icon?.kind === "image") wanted.push({ path: ".snoboard.yml", field: `projects.${project}.icon`, icon: icon.path });
  }
  for (const file of files) {
    if (file.kind !== "initiative") continue;
    const icon = parseIcon(file.frontmatter.icon);
    if (icon?.kind === "image") wanted.push({ path: file.path, field: "icon", icon: icon.path });
  }
  const issues: ValidationIssue[] = [];
  for (const entry of wanted) {
    const absolute = path.resolve(repoDir, entry.icon);
    let message: string | undefined;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) message = `icon file "${entry.icon}" is not a file`;
      else if (info.size > MAX_ICON_BYTES) message = `icon file "${entry.icon}" is larger than 256 KB`;
    } catch {
      message = `icon file "${entry.icon}" was not found`;
    }
    if (message !== undefined) issues.push({ path: entry.path, field: entry.field, message, severity: "warning" });
  }
  return issues;
}

function formatIssue(issue: ValidationIssue): string {
  const prefix = issue.severity === "warning" ? "warning: " : "";
  return `${prefix}${issue.path}: ${issue.field}: ${issue.message}\n`;
}

/**
 * `--changed-since` uses `git diff --name-only <ref>...HEAD`, scoped to the
 * configured root. Other issues are kept only for those paths. Duplicate ids
 * are kept when a changed file shares that id, so uniqueness stays repo-wide.
 */
function issueApplies(
  issue: ValidationIssue,
  changed: ReadonlySet<string>,
  changedIds: ReadonlySet<string>,
): boolean {
  if (changed.has(normalize(issue.path))) return true;
  const duplicate = /^duplicate id "([^"]+)"$/.exec(issue.message);
  if (issue.field === "id" && duplicate?.[1] !== undefined && changedIds.has(duplicate[1])) {
    return true;
  }
  if (issue.message.startsWith("dependency cycle:")) {
    const body = issue.message.slice("dependency cycle: ".length);
    for (const token of body.split(" -> ")) {
      const id = token.split("#")[0] ?? "";
      if (changedIds.has(id)) return true;
    }
  }
  return false;
}

function idsOnPaths(files: readonly ParsedFile[], paths: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>();
  for (const file of files) {
    if (file.kind === "initiative" && paths.has(normalize(file.path))) {
      ids.add(file.frontmatter.id);
    }
  }
  return ids;
}

async function changedPaths(
  repoDir: string,
  since: string,
  config: Config,
  onGit: CliIo["onGit"],
): Promise<Set<string>> {
  const root = normalize(config.root);
  const stdout = await gitOk(
    repoDir,
    ["-c", "core.quotePath=false", "diff", "--name-only", `${since}...HEAD`, "--", root],
    onGit,
  );
  const changed = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const filePath = normalize(line.trim());
    if (filePath.length > 0) changed.add(filePath);
  }
  return changed;
}

async function nextNumberCommand(
  project: string,
  values: FlagValues,
  io: CliIo,
): Promise<number> {
  assertProject(project);
  const repoDir = await repoDirOf(values, io);
  const config = await readConfig(repoDir);
  if (values.fetch === true) await fetchOrigin(repoDir, io.onGit);
  io.stdout(`${await nextNumber(repoDir, project, config)}\n`);
  return 0;
}

async function newCommand(
  project: string,
  slug: string,
  values: FlagValues,
  io: CliIo,
): Promise<number> {
  assertProject(project);
  assertSlug(slug);
  const title = values.title ?? titleFromSlug(slug);
  if (/[\r\n]/.test(title)) throw new UsageError("Title cannot contain line breaks.");
  const repoDir = await repoDirOf(values, io);
  const config = await readConfig(repoDir);
  const priority = values.priority ?? "p2";
  if (!config.priorities.includes(priority)) {
    throw new UsageError(
      `Priority "${priority}" is not one of: ${config.priorities.join(", ")}.`,
    );
  }
  if (values.fetch === true) await fetchOrigin(repoDir, io.onGit);
  const number = await nextNumber(repoDir, project, config);
  const folder = `${number}-${slug}`;
  const relative = repoRelative(config.root, project, folder);
  const destination = path.join(repoDir, ...relative.split("/"));
  try {
    await stat(destination);
    throw new CommandError(`Folder already exists: ${relative}`);
  } catch (error) {
    if (error instanceof CommandError) throw error;
    if (!isEnoent(error)) throw error;
  }
  const status =
    config.statuses.find((item) => !config.doneStatuses.includes(item)) ?? config.statuses[0];
  if (status === undefined) throw new CommandError("Config has no statuses.");
  const id = config.idFormat.replaceAll("{project}", project).replaceAll("{number}", number);
  const updated = new Date().toISOString().slice(0, 10);
  const body = renderTemplate(await readTemplate(), {
    id,
    title,
    titleYaml: yamlDoubleQuoted(title),
    status,
    priority,
    updated,
  });
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, config.file), body, "utf8");
  io.stdout(`${repoRelative(relative, config.file)}\n`);
  return 0;
}

async function statusCommand(values: FlagValues, io: CliIo): Promise<number> {
  if (values.ready === true && values.stale === true) {
    throw new UsageError("Pass only one of --ready or --stale.");
  }
  const project = values.project;
  if (project !== undefined) assertProject(project);
  const repoDir = await repoDirOf(values, io);
  const config = await readConfig(repoDir);
  const snapshot = await buildSnapshot(repoDir, config, { onSpawn: io.onGit });
  for (const error of snapshot.errors) {
    io.stderr(`${error.path} (${error.ref}): ${error.message}\n`);
  }
  const stalePaths = staleInitiativePaths(snapshot.items, config);
  let items = snapshot.items;
  if (project !== undefined) items = items.filter((item) => item.project === project);
  if (values.ready === true) items = items.filter((item) => item.isReady);
  if (values.stale === true) items = items.filter((item) => stalePaths.has(item.path));
  const records = items.map((item) => statusRecord(item, stalePaths.has(item.path)));
  if (values.json === true) {
    io.stdout(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  const rows = [
    ["id", "title", "status", "priority", "updated", "ready"],
    ...records.map((record) => [
      record.id,
      record.title,
      record.status,
      record.priority,
      record.updated,
      record.ready ? "yes" : "no",
    ]),
  ];
  io.stdout(formatTable(rows));
  return 0;
}

function statusRecord(item: BoardItem, stale: boolean) {
  return {
    id: item.id,
    title: item.title,
    project: item.project,
    status: item.status,
    priority: item.priority,
    updated: item.updated,
    ready: item.isReady,
    stale,
    blockedBy: item.blockedBy,
    path: item.path,
  };
}

function staleInitiativePaths(items: readonly BoardItem[], config: Config): Set<string> {
  const parsed: ParsedFile[] = items.map((item) => ({
    kind: "initiative",
    path: item.path,
    project: item.project,
    number: item.number,
    frontmatter: item,
    summary: item.summary,
  }));
  const stale = new Set<string>();
  for (const issue of validate(parsed, config)) {
    if (issue.severity === "warning" && issue.field === "updated") stale.add(issue.path);
  }
  return stale;
}

function formatTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "";
  const width = rows[0]?.length ?? 0;
  const widths = Array.from({ length: width }, (_, index) =>
    Math.max(...rows.map((row) => row[index]?.length ?? 0)),
  );
  return (
    rows
      .map((row) =>
        row
          .map((cell, index) =>
            index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? cell.length),
          )
          .join("  "),
      )
      .join("\n") + "\n"
  );
}

async function fetchOrigin(repoDir: string, onGit: CliIo["onGit"]): Promise<void> {
  await fetchRefs(repoDir, [], { onSpawn: onGit });
}

async function nextNumber(repoDir: string, project: string, config: Config): Promise<string> {
  let highest = 0;
  const reserved = new Set(config.reservedNumbers);
  const consider = (value: number | undefined): void => {
    if (value !== undefined && !reserved.has(value) && value > highest) highest = value;
  };
  for (const found of await workingTreeNumbers(repoDir, project, config)) consider(found);
  for (const found of await gitNumbers(repoDir, project, config)) consider(found);
  let next = highest + 1;
  while (reserved.has(next)) next += 1;
  if (next > 999) {
    throw new CommandError(
      `No free number for project "${project}": the highest is ${highest}. ` +
        "Add parking-lot folders such as 999-backlog to reservedNumbers in .snoboard.yml.",
    );
  }
  return String(next).padStart(3, "0");
}

async function workingTreeNumbers(
  repoDir: string,
  project: string,
  config: Config,
): Promise<number[]> {
  const numbers: number[] = [];
  const projectDir = path.join(repoDir, ...normalize(config.root).split("/"), project);
  let folders: string[];
  try {
    folders = await readdir(projectDir);
  } catch (error) {
    if (isEnoent(error)) return numbers;
    throw error;
  }
  for (const folder of folders) {
    const folderPath = path.join(projectDir, folder);
    let info;
    try {
      info = await stat(folderPath);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (!info.isDirectory()) continue;
    let text: string;
    try {
      text = await readFile(path.join(folderPath, config.file), "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    considerFileNumbers(
      numbers,
      project,
      folder,
      text,
      config,
      repoRelative(config.root, project, folder, config.file),
    );
  }
  return numbers;
}

async function gitNumbers(repoDir: string, project: string, config: Config): Promise<number[]> {
  const numbers: number[] = [];
  const refs = await listRefs(repoDir, {
    defaultBranch: config.defaultBranch,
    branchPatterns: config.branchPatterns,
  });
  for (const ref of refs) {
    const files = await listInitiativeFiles(repoDir, ref.sha, config);
    const owned = files.filter((file) => projectFromInitiativePath(file.path) === project);
    if (owned.length === 0) continue;
    const blobs = await readBlobsOrEmpty(
      repoDir,
      owned.map((file) => file.blobSha),
    );
    for (const file of owned) {
      const folder = folderFromInitiativePath(file.path);
      if (folder === undefined) continue;
      const text = blobs.get(file.blobSha);
      if (text === undefined) {
        const folderNumber = numberInFolder(folder);
        if (folderNumber !== undefined) numbers.push(folderNumber);
        continue;
      }
      considerFileNumbers(numbers, project, folder, text, config, file.path);
    }
  }
  return numbers;
}

async function readBlobsOrEmpty(
  repoDir: string,
  shas: readonly string[],
): Promise<Map<string, string>> {
  try {
    return await readBlobs(repoDir, shas);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/missing|did not return object/i.test(message)) throw error;
    return new Map();
  }
}

function considerFileNumbers(
  numbers: number[],
  project: string,
  folder: string,
  text: string,
  config: Config,
  filePath: string,
): void {
  const folderNumber = numberInFolder(folder);
  if (folderNumber !== undefined) numbers.push(folderNumber);
  const parsed = parseInitiativeFile(filePath, text, config);
  if (parsed.kind !== "initiative") return;
  const idNumber = numberInId(project, parsed.frontmatter.id);
  if (idNumber !== undefined) numbers.push(idNumber);
}

function projectFromInitiativePath(filePath: string): string | undefined {
  const parts = normalize(filePath).split("/");
  return parts.length >= 3 ? parts[parts.length - 3] : undefined;
}

function folderFromInitiativePath(filePath: string): string | undefined {
  const parts = normalize(filePath).split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

function numberInFolder(folder: string): number | undefined {
  const match = FOLDER_NUMBER.exec(folder);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}

function numberInId(project: string, id: string): number | undefined {
  const prefix = `${project}-`;
  if (!id.startsWith(prefix)) return undefined;
  const rest = id.slice(prefix.length);
  if (!/^\d{3}$/.test(rest)) return undefined;
  return Number(rest);
}

type WorkingFile = { path: string; absolute: string };

async function listWorkingTreeFiles(repoDir: string, config: Config): Promise<WorkingFile[]> {
  const root = normalize(config.root);
  const rootDir = path.join(repoDir, ...root.split("/"));
  let projects;
  try {
    projects = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const files: WorkingFile[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(rootDir, project.name);
    const folders = await readdir(projectDir, { withFileTypes: true });
    for (const folder of folders) {
      if (!folder.isDirectory() || numberInFolder(folder.name) === undefined) continue;
      const absolute = path.join(projectDir, folder.name, config.file);
      try {
        await stat(absolute);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      files.push({
        path: repoRelative(root, project.name, folder.name, config.file),
        absolute,
      });
    }
  }
  return files;
}

async function readWorkingTree(repoDir: string, config: Config): Promise<ParsedFile[]> {
  const files: ParsedFile[] = [];
  for (const file of await listWorkingTreeFiles(repoDir, config)) {
    files.push(parseInitiativeFile(file.path, await readFile(file.absolute, "utf8"), config));
  }
  return files;
}

function selectWorkingFiles(
  repoDir: string,
  files: readonly WorkingFile[],
  requested: readonly string[],
): WorkingFile[] {
  if (requested.length === 0) return [...files];
  const chosen = new Map<string, WorkingFile>();
  for (const raw of requested) {
    const relative = normalize(path.relative(repoDir, path.resolve(repoDir, raw)));
    if (relative === ".." || relative.startsWith("../")) {
      throw new CommandError(`Path is outside the repository: ${raw}`);
    }
    const matches = files.filter(
      (file) => file.path === relative || file.path.startsWith(`${relative}/`),
    );
    if (matches.length === 0) {
      throw new CommandError(`No initiative file at ${relative}`);
    }
    for (const match of matches) chosen.set(match.path, match);
  }
  return [...chosen.values()];
}

async function fixCommand(
  requested: readonly string[],
  values: FlagValues,
  io: CliIo,
): Promise<number> {
  const repoDir = await repoDirOf(values, io);
  const config = await readConfig(repoDir);
  const files = selectWorkingFiles(repoDir, await listWorkingTreeFiles(repoDir, config), requested);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const events: FixEvent[] = [];
  let pending = false;
  for (const file of files) {
    const text = await readFile(file.absolute, "utf8");
    const fixed = fixInitiativeText(file.path, text, config);
    events.push(...fixed.events);
    if (!fixed.changed) continue;
    pending = true;
    if (values["dry-run"] === true) continue;
    await writeFile(file.absolute, fixed.text);
  }
  if (values.json === true) {
    io.stdout(`${JSON.stringify(events, null, 2)}\n`);
  } else {
    for (const event of events) io.stdout(formatFixEvent(event));
  }
  return values["dry-run"] === true && pending ? 1 : 0;
}

async function readAtRef(repoDir: string, ref: string, config: Config): Promise<ParsedFile[]> {
  const listed = await listInitiativeFiles(repoDir, ref, config);
  const blobs = await readBlobs(
    repoDir,
    listed.map((file) => file.blobSha),
  );
  return listed.map((file) => {
    const text = blobs.get(file.blobSha);
    if (text === undefined) {
      throw new CommandError(`Missing blob ${file.blobSha} for ${file.path}`);
    }
    return parseInitiativeFile(file.path, text, config);
  });
}

function assertProject(project: string): void {
  if (!PROJECT_NAME.test(project)) {
    throw new UsageError(
      'Project "' +
        project +
        '" must start with a letter or digit and use only lowercase letters, digits, "_" or "-".',
    );
  }
}

function assertSlug(slug: string): void {
  if (!SLUG_NAME.test(slug)) {
    throw new UsageError(
      `Slug "${slug}" must use lowercase letters, digits, and single hyphens.`,
    );
  }
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((word) => (word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`))
    .join(" ");
}

function yamlDoubleQuoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(/\{\{([A-Za-z]+)\}\}/g, (match, key: string) => values[key] ?? match);
}

async function readTemplate(): Promise<string> {
  const candidates = [
    new URL("./templates/initiative.md", import.meta.url),
    new URL("../src/templates/initiative.md", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return await readFile(url, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
  }
  throw new CommandError("Built-in initiative template was not found.");
}

function gitOk(
  repoDir: string,
  args: readonly string[],
  onGit?: (args: readonly string[]) => void,
): Promise<string> {
  onGit?.(args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], {
      cwd: repoDir,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "Never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout === null || stderr === null) {
      child.kill();
      reject(new CommandError("git stdio was not piped"));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finish = (handler: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        reject(new CommandError(`git ${args.join(" ")} timed out`));
      });
    }, 120_000);
    stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.on("error", (error) => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", (code) => {
      finish(() => {
        const out = Buffer.concat(stdoutChunks).toString("utf8");
        const err = Buffer.concat(stderrChunks).toString("utf8");
        if ((code ?? 1) !== 0) {
          const detail = err.trim();
          reject(
            new CommandError(
              `git ${args.join(" ")} failed (${code ?? 1})${detail.length > 0 ? `: ${detail}` : ""}`,
            ),
          );
          return;
        }
        resolve(out);
      });
    });
  });
}

if (runningAsCli()) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}

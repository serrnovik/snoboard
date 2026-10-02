import {
  applyEdit,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  NEW_INITIATIVE_REF,
  EditSchema,
  listInitiativeFiles,
  parseInitiativeFile,
  readBlobs,
  renderNewInitiative,
  validate,
  type Config,
  type Edit,
  type ParsedFile,
  type Snapshot,
  type ValidationIssue,
} from "snoboard";

export const MAX_VALIDATE_EDITS = 50;
export const MAX_VALIDATE_BODY_BYTES = 64 * 1024;

export type BlobContent = {
  sha: string;
  text: string;
};

/** Read the blob the snapshot showed for `path` at `ref` (a branch name or commit sha). */
export type ReadBlob = (ref: string, path: string) => Promise<BlobContent | undefined>;

export type EditResult = {
  index: number;
  ok: boolean;
  error?: string;
  id?: string;
  number?: string;
  path?: string;
};

export type PreparedFile = {
  path: string;
  /** Git blob sha of the file the edits were applied to. Null when the file is new. */
  baseSha: string | null;
  text: string;
};

/** An image the batch adds, at its full repo-relative path. The bytes come with the submit. */
export type PreparedAttachment = {
  index: number;
  path: string;
  contentType: string;
  sha256: string;
  size: number;
};

export type PrepareEditsResult = {
  results: EditResult[];
  files: PreparedFile[];
  attachments: PreparedAttachment[];
};

type Draft = {
  path: string;
  baseSha: string | null;
  text: string;
  failed: boolean;
};

type FieldEdit = Exclude<Edit, { kind: "createInitiative" | "addAttachment" }>;
type CreateEdit = Extract<Edit, { kind: "createInitiative" }>;
type AttachmentEdit = Extract<Edit, { kind: "addAttachment" }>;

const FOLDER_NUMBER = /^(\d{3})-/;

/**
 * Apply a batch in order and report each edit. Nothing is written.
 * New initiative numbers follow `next-number`: the highest folder or id number
 * on any snapshot branch, plus legacy paths, error paths, and numbers already
 * assigned in this batch. `reservedNumbers` are skipped.
 */
export async function prepareEdits(
  edits: readonly unknown[],
  snapshot: Snapshot,
  readBlob: ReadBlob,
  config: Config,
  today: string,
): Promise<PrepareEditsResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new Error("invalid date");
  }

  const results: EditResult[] = [];
  const drafts = new Map<string, Draft>();
  const parsedByPath = new Map<string, ParsedFile>();
  const taken = new Map<string, Set<number>>();

  for (const item of snapshot.items) {
    parsedByPath.set(item.path, synthetic(item));
  }

  const attachmentEdits: { index: number; edit: AttachmentEdit }[] = [];
  const createdFolders = new Map<string, string>();
  for (let index = 0; index < edits.length; index += 1) {
    const parsed = EditSchema.safeParse(edits[index]);
    if (!parsed.success) {
      results.push({ index, ok: false, error: formatIssue(parsed.error) });
      continue;
    }
    const edit = parsed.data;
    if (edit.kind === "createInitiative") {
      const created = createInitiative(index, edit);
      if (created.ok && created.path !== undefined) {
        createdFolders.set(`new:${edit.project}/${edit.slug}`, parentDir(created.path));
      }
      results.push(created);
      continue;
    }
    if (edit.kind === "addAttachment") {
      // Resolved after the loop: the initiative it belongs to may be created later in the batch.
      attachmentEdits.push({ index, edit });
      results.push({ index, ok: true });
      continue;
    }
    results.push(await applyField(index, edit));
  }

  const attachments: PreparedAttachment[] = [];
  let attachedBytes = 0;
  for (const { index, edit } of attachmentEdits) {
    const result = addAttachment(index, edit);
    results[results.findIndex((entry) => entry.index === index)] = result;
    if (!result.ok || result.path === undefined) continue;
    attachedBytes += edit.size;
    attachments.push({ index, path: result.path, contentType: edit.contentType, sha256: edit.sha256, size: edit.size });
  }
  if (attachedBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    const last = attachments.at(-1);
    if (last !== undefined) {
      results[results.findIndex((entry) => entry.index === last.index)] = {
        index: last.index,
        ok: false,
        error: `images in one submit are limited to ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB`,
      };
    }
  }

  const files: PreparedFile[] = [];
  for (const draft of drafts.values()) {
    if (draft.failed) continue;
    files.push({ path: draft.path, baseSha: draft.baseSha, text: draft.text });
  }
  return { results, files, attachments };

  function addAttachment(index: number, edit: AttachmentEdit): EditResult {
    if (attachments.length >= MAX_ATTACHMENTS) {
      return { index, ok: false, error: `at most ${MAX_ATTACHMENTS} images per submit` };
    }
    let folder: string | undefined;
    if (NEW_INITIATIVE_REF.test(edit.id)) {
      folder = createdFolders.get(edit.id);
      if (folder === undefined) {
        return { index, ok: false, error: `${edit.path}: the new initiative ${edit.id.slice(4)} is not in this basket` };
      }
    } else {
      const item = snapshot.items.find((entry) => entry.id === edit.id);
      if (item === undefined) return { index, ok: false, error: `unknown initiative ${edit.id}` };
      folder = parentDir(item.path);
    }
    const target = `${folder}/${edit.path}`;
    if (!isContainedPath(target) || !target.startsWith(`${folder}/assets/`)) {
      return { index, ok: false, error: `path not allowed: ${edit.path}` };
    }
    if (attachments.some((entry) => entry.path === target) || drafts.has(target)) {
      return { index, ok: false, error: `${edit.id}: ${edit.path} is already in this basket` };
    }
    return { index, ok: true, ...(NEW_INITIATIVE_REF.test(edit.id) ? {} : { id: edit.id }), path: target };
  }

  function createInitiative(index: number, edit: CreateEdit): EditResult {
    const allocated = nextFree(edit.project);
    if (typeof allocated !== "number") {
      return { index, ok: false, error: allocated.error };
    }
    let rendered: { path: string; text: string };
    try {
      rendered = renderNewInitiative(
        {
          project: edit.project,
          slug: edit.slug,
          title: edit.title,
          status: edit.status,
          priority: edit.priority,
          ...(edit.depends_on === undefined ? {} : { depends_on: edit.depends_on }),
          ...(edit.body === undefined ? {} : { body: edit.body }),
        },
        allocated,
        config,
        today,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "could not create initiative";
      return { index, ok: false, error: message };
    }
    if (!isContainedPath(rendered.path) || pathExists(rendered.path)) {
      return { index, ok: false, error: `path already exists: ${rendered.path}` };
    }
    const problem = acceptText(rendered.path, rendered.text);
    if (problem !== undefined) {
      return { index, ok: false, error: `create ${edit.project}/${edit.slug}: ${problem}` };
    }
    numbersFor(edit.project).add(allocated);
    const created = parsedByPath.get(rendered.path);
    const id = created?.kind === "initiative" ? created.frontmatter.id : undefined;
    const number = created?.kind === "initiative" ? created.number : String(allocated).padStart(3, "0");
    drafts.set(rendered.path, {
      path: rendered.path,
      baseSha: null,
      text: rendered.text,
      failed: false,
    });
    return {
      index,
      ok: true,
      ...(id === undefined ? {} : { id }),
      number,
      path: rendered.path,
    };
  }

  async function applyField(index: number, edit: FieldEdit): Promise<EditResult> {
    const item = snapshot.items.find((entry) => entry.id === edit.id);
    if (item === undefined) {
      return { index, ok: false, error: `unknown initiative ${edit.id}` };
    }
    let draft = drafts.get(item.path);
    if (draft === undefined) {
      const blob = await readBlob(refSha(item.sourceRef), item.path);
      if (blob === undefined) {
        return { index, ok: false, error: `${edit.id}: file could not be read`, path: item.path };
      }
      draft = { path: item.path, baseSha: blob.sha, text: blob.text, failed: false };
      drafts.set(item.path, draft);
    }
    const applied = applyEdit(draft.text, edit, config, today);
    if ("error" in applied) {
      draft.failed = true;
      return { index, ok: false, error: `${edit.id}: ${applied.error}`, path: item.path };
    }
    const problem = acceptText(item.path, applied.text);
    if (problem !== undefined) {
      draft.failed = true;
      return { index, ok: false, error: `${edit.id}: ${problem}`, path: item.path };
    }
    draft.text = applied.text;
    return { index, ok: true, path: item.path };
  }

  function acceptText(filePath: string, text: string): string | undefined {
    const parsed = parseInitiativeFile(filePath, text, config);
    if (parsed.kind !== "initiative") {
      return parsed.kind === "error" ? parsed.message : "file is not an initiative";
    }
    const before = errorIssues([...parsedByPath.values()]);
    const next = new Map(parsedByPath);
    next.set(filePath, parsed);
    const introduced = errorIssues([...next.values()]).filter(
      (issue) => !before.some((previous) => sameIssue(previous, issue)),
    );
    if (introduced.length > 0) {
      return introduced.map((issue) => `${issue.field}: ${issue.message}`).join("; ");
    }
    parsedByPath.set(filePath, parsed);
    return undefined;
  }

  function errorIssues(filesToCheck: readonly ParsedFile[]): ValidationIssue[] {
    return validate(filesToCheck, config).filter((issue) => issue.severity === "error");
  }

  function pathExists(filePath: string): boolean {
    if (parsedByPath.has(filePath)) return true;
    if (snapshot.legacy.some((item) => item.path === filePath)) return true;
    return snapshot.errors.some((item) => item.path === filePath);
  }

  function nextFree(project: string): number | { error: string } {
    const reserved = new Set(config.reservedNumbers);
    const used = numbersFor(project);
    let highest = 0;
    for (const value of used) {
      if (reserved.has(value)) continue;
      if (value > highest) highest = value;
    }
    let next = highest + 1;
    while (next <= 999 && (reserved.has(next) || used.has(next))) next += 1;
    if (next > 999) return { error: `no free number for project "${project}"` };
    return next;
  }

  function numbersFor(project: string): Set<number> {
    const existing = taken.get(project);
    if (existing !== undefined) return existing;
    const collected = collectNumbers(snapshot, project);
    taken.set(project, collected);
    return collected;
  }

  function refSha(sourceRef: string): string {
    return snapshot.refs.find((ref) => ref.name === sourceRef)?.sha ?? sourceRef;
  }
}

/** Every initiative blob at `ref`, keyed by repo-relative path. Read-only. */
export async function readRepoBlobs(
  repoDir: string,
  ref: string,
  config: Config,
): Promise<Map<string, BlobContent>> {
  const map = new Map<string, BlobContent>();
  try {
    const files = await listInitiativeFiles(repoDir, ref, config);
    if (files.length === 0) return map;
    const blobs = await readBlobs(repoDir, files.map((file) => file.blobSha));
    for (const file of files) {
      const text = blobs.get(file.blobSha);
      if (text === undefined) continue;
      map.set(file.path, { sha: file.blobSha, text });
    }
  } catch {
    return map;
  }
  return map;
}

function collectNumbers(snapshot: Snapshot, project: string): Set<number> {
  const numbers = new Set<number>();
  const add = (value: number | undefined): void => {
    if (value === undefined || !Number.isInteger(value) || value < 0 || value > 999) return;
    numbers.add(value);
  };
  for (const item of snapshot.items) {
    if (item.project !== project) continue;
    add(parsePadded(item.number));
    add(numberInId(project, item.id));
    const fromPath = folderNumberFromPath(item.path);
    if (fromPath?.project === project) add(fromPath.number);
  }
  for (const item of snapshot.legacy) {
    if (item.project !== project) continue;
    add(parsePadded(item.number));
    const fromPath = folderNumberFromPath(item.path);
    if (fromPath?.project === project) add(fromPath.number);
  }
  for (const error of snapshot.errors) {
    const fromPath = folderNumberFromPath(error.path);
    if (fromPath?.project === project) add(fromPath.number);
  }
  return numbers;
}

function parsePadded(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,3}$/.test(value)) return undefined;
  return Number(value);
}

function numberInId(project: string, id: string): number | undefined {
  const prefix = `${project}-`;
  if (!id.startsWith(prefix)) return undefined;
  const rest = id.slice(prefix.length);
  if (!/^\d{3}$/.test(rest)) return undefined;
  return Number(rest);
}

function folderNumberFromPath(filePath: string): { project: string; number: number } | undefined {
  const parts = filePath.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
  if (parts.length < 3) return undefined;
  const project = parts[parts.length - 3];
  const folder = parts[parts.length - 2];
  if (project === undefined || folder === undefined) return undefined;
  const match = FOLDER_NUMBER.exec(folder);
  if (match?.[1] === undefined) return undefined;
  return { project, number: Number(match[1]) };
}

function synthetic(item: Snapshot["items"][number]): ParsedFile {
  return {
    kind: "initiative",
    path: item.path,
    project: item.project,
    number: item.number,
    summary: item.summary,
    frontmatter: {
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      depends_on: [...(item.depends_on ?? [])],
      updated: item.updated,
      ...(item.branch === undefined ? {} : { branch: item.branch }),
      ...(item.labels === undefined ? {} : { labels: [...item.labels] }),
      ...(item.issues === undefined ? {} : { issues: [...item.issues] }),
      ...(item.links === undefined ? {} : { links: item.links.map((link) => ({ ...link })) }),
      ...(item.phases === undefined ? {} : { phases: item.phases.map((phase) => ({ ...phase })) }),
    },
  };
}

function parentDir(filePath: string): string {
  const at = filePath.lastIndexOf("/");
  return at === -1 ? "" : filePath.slice(0, at);
}

function sameIssue(left: ValidationIssue, right: ValidationIssue): boolean {
  return left.path === right.path && left.field === right.field && left.message === right.message;
}

function isContainedPath(filePath: string): boolean {
  if (filePath.includes("\\") || filePath.startsWith("/") || filePath.includes(":")) return false;
  return !filePath.split("/").includes("..");
}

function formatIssue(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid edit";
  const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "edit";
  return `${path}: ${issue.message}`;
}

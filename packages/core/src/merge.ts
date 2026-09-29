import type { Config } from "./config.js";
import {
  lastCommitsForPaths,
  listInitiativeFiles,
  listRefs,
  prefetchMissingBlobs,
  readBlobs,
  type CommitTouch,
  type GitCallOptions,
  type RefInfo,
} from "./git.js";
import { blockedBy, buildGraph, isReady, type Graph } from "./graph.js";
import { parseInitiativeFile } from "./parse.js";
import type { InitiativeFrontmatter } from "./schema.js";

export interface SnapshotOptions extends GitCallOptions {
  /** Remote whose `refs/remotes/<name>/*` tips are read. The caller updates remotes. */
  remote?: string;
}

export type BoardItem = InitiativeFrontmatter & {
  path: string;
  project: string;
  number: string;
  summary: string;
  sourceRef: string;
  sourceSha: string;
  updatedAt: string;
  isReady: boolean;
  blockedBy: string[];
  onBranches: string[];
};

export type LegacyItem = {
  path: string;
  project: string;
  number: string;
  title: string;
  summary: string;
};

export type ParsedFileError = {
  path: string;
  message: string;
  ref: string;
};

export type Snapshot = {
  generatedAt: string;
  refs: RefInfo[];
  items: BoardItem[];
  legacy: LegacyItem[];
  errors: ParsedFileError[];
  graph: Graph;
};

interface Candidate {
  ref: RefInfo;
  path: string;
  project: string;
  number: string;
  summary: string;
  frontmatter: InitiativeFrontmatter;
  touch: CommitTouch;
}

function commitTime(date: string): number {
  const parsed = Date.parse(date);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** Equal commit times keep the default branch, then the earlier ref name. */
function prefer(left: Candidate, right: Candidate): Candidate {
  const leftMs = commitTime(left.touch.date);
  const rightMs = commitTime(right.touch.date);
  if (leftMs !== rightMs) {
    return leftMs > rightMs ? left : right;
  }
  if (left.ref.isDefault !== right.ref.isDefault) {
    return left.ref.isDefault ? left : right;
  }
  const byName = left.ref.name.localeCompare(right.ref.name);
  if (byName !== 0) {
    return byName < 0 ? left : right;
  }
  return left.path.localeCompare(right.path) <= 0 ? left : right;
}

function selectCandidate(group: readonly Candidate[], config: Config): Candidate {
  const doneOnDefault = group.filter(
    (candidate) =>
      candidate.ref.isDefault && config.doneStatuses.includes(candidate.frontmatter.status),
  );
  const pool = doneOnDefault.length > 0 ? doneOnDefault : group;
  return pool.reduce((best, candidate) => prefer(best, candidate));
}

/** Branches whose copy of the file differs from the default branch (edited or added there). */
function onBranchesFor(
  filePath: string,
  refs: readonly RefInfo[],
  blobsByRef: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string[] {
  const defaultRef = refs.find((ref) => ref.isDefault);
  const defaultBlob = defaultRef ? blobsByRef.get(defaultRef.name)?.get(filePath) : undefined;
  const names: string[] = [];
  for (const ref of refs) {
    if (ref.isDefault) {
      continue;
    }
    const blob = blobsByRef.get(ref.name)?.get(filePath);
    if (blob !== undefined && blob !== defaultBlob) {
      names.push(ref.name);
    }
  }
  names.sort((left, right) => left.localeCompare(right));
  return names;
}

export async function buildSnapshot(
  repoDir: string,
  config: Config,
  options?: SnapshotOptions,
): Promise<Snapshot> {
  const refs = await listRefs(repoDir, {
    remote: options?.remote,
    defaultBranch: config.defaultBranch,
    branchPatterns: config.branchPatterns,
    onSpawn: options?.onSpawn,
    timeoutMs: options?.timeoutMs,
    env: options?.env,
  });
  const root = config.root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

  const listed = await Promise.all(
    refs.map(async (ref) => {
      const [files, touches] = await Promise.all([
        listInitiativeFiles(repoDir, ref.sha, config, options),
        lastCommitsForPaths(repoDir, ref.sha, root, options),
      ]);
      return { ref, files, touches };
    }),
  );

  const blobShas: string[] = [];
  const blobsByRef = new Map<string, Map<string, string>>();
  for (const entry of listed) {
    const paths = new Map<string, string>();
    for (const file of entry.files) {
      paths.set(file.path, file.blobSha);
      blobShas.push(file.blobSha);
    }
    blobsByRef.set(entry.ref.name, paths);
  }

  await prefetchMissingBlobs(repoDir, blobShas, { ...options, remote: options?.remote });
  const blobs = await readBlobs(repoDir, blobShas, options);
  // path -> blob sha on the default branch; branch errors are reported only
  // when the branch actually changed the file.
  const defaultBlobs = new Map<string, string>();
  for (const entry of listed) {
    if (!entry.ref.isDefault) {
      continue;
    }
    for (const file of entry.files) {
      defaultBlobs.set(file.path, file.blobSha);
    }
  }

  const initiatives: Candidate[] = [];
  const legacy: LegacyItem[] = [];
  const errors: ParsedFileError[] = [];

  for (const entry of listed) {
    for (const file of entry.files) {
      // Fall back to the ref tip (with an unknown date, so it never wins a
      // tie-break) rather than failing the whole snapshot on one odd history.
      const touch = entry.touches.get(file.path) ?? { sha: entry.ref.sha, date: "" };
      const text = blobs.get(file.blobSha);
      if (text === undefined) {
        throw new Error(`Missing blob ${file.blobSha} for ${file.path}`);
      }
      const parsed = parseInitiativeFile(file.path, text, config);
      if (parsed.kind === "legacy") {
        if (entry.ref.isDefault) {
          legacy.push({
            path: parsed.path,
            project: parsed.project,
            number: parsed.number,
            title: parsed.title,
            summary: parsed.summary,
          });
        }
        continue;
      }
      if (parsed.kind === "error") {
        if (entry.ref.isDefault || defaultBlobs.get(file.path) !== file.blobSha) {
          errors.push({
            path: parsed.path,
            message: parsed.message,
            ref: entry.ref.name,
          });
        }
        continue;
      }
      initiatives.push({
        ref: entry.ref,
        path: parsed.path,
        project: parsed.project,
        number: parsed.number,
        summary: parsed.summary,
        frontmatter: parsed.frontmatter,
        touch,
      });
    }
  }

  const byId = new Map<string, Candidate[]>();
  for (const candidate of initiatives) {
    const group = byId.get(candidate.frontmatter.id) ?? [];
    group.push(candidate);
    byId.set(candidate.frontmatter.id, group);
  }

  const selected = [...byId.values()]
    .map((group) => selectCandidate(group, config))
    .sort((left, right) => left.frontmatter.id.localeCompare(right.frontmatter.id));

  const graph = buildGraph(
    selected.map((candidate) => ({
      id: candidate.frontmatter.id,
      status: candidate.frontmatter.status,
      depends_on: [...(candidate.frontmatter.depends_on ?? [])],
      phases: candidate.frontmatter.phases,
    })),
    config,
  );

  const items: BoardItem[] = selected.map((candidate) => ({
    ...candidate.frontmatter,
    path: candidate.path,
    project: candidate.project,
    number: candidate.number,
    summary: candidate.summary,
    sourceRef: candidate.ref.name,
    sourceSha: candidate.touch.sha,
    updatedAt: candidate.touch.date,
    isReady: isReady(graph, candidate.frontmatter.id),
    blockedBy: blockedBy(graph, candidate.frontmatter.id),
    onBranches: onBranchesFor(candidate.path, refs, blobsByRef),
  }));

  legacy.sort((left, right) => left.path.localeCompare(right.path));
  errors.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) {
      return byPath;
    }
    return left.ref.localeCompare(right.ref);
  });

  return {
    generatedAt: new Date().toISOString(),
    refs,
    items,
    legacy,
    errors,
    graph,
  };
}

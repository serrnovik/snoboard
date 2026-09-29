export { VERSION } from "./version.js";

export {
  fetch,
  lastCommitTouching,
  lastCommitsForPaths,
  listInitiativeFiles,
  listRefs,
  prefetchMissingBlobs,
  readBlobs,
} from "./git.js";

export type {
  CommitTouch,
  GitCallOptions,
  GitConfig,
  InitiativeFile,
  RefInfo,
} from "./git.js";
export { ConfigSchema, loadConfig, type Config } from "./config.js";
export {
  InitiativeFrontmatterSchema,
  PhaseSchema,
  type InitiativeFrontmatter,
  type Phase,
} from "./schema.js";
export { parseInitiativeFile, type ParsedFile } from "./parse.js";
export { validate, type ValidationIssue } from "./validate.js";
export {
  blockedBy,
  blockedChain,
  buildGraph,
  findCycles,
  isReady,
  type Graph,
  type GraphEdge,
  type GraphItem,
  type GraphNode,
} from "./graph.js";
export {
  buildSnapshot,
  type BoardItem,
  type LegacyItem,
  type ParsedFileError,
  type Snapshot,
  type SnapshotOptions,
} from "./merge.js";

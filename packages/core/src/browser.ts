// Browser-safe entry point: no git or filesystem access. The board's client
// bundle imports from "snoboard/browser"; server code uses "snoboard".
export { VERSION } from "./version.js";
export { ConfigSchema, loadConfig, type Config } from "./config.js";
export {
  InitiativeFrontmatterSchema,
  PhaseSchema,
  type InitiativeFrontmatter,
  type Phase,
} from "./schema.js";
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
export type { BoardItem, LegacyItem, ParsedFileError, Snapshot } from "./merge.js";
export type { RefInfo } from "./git.js";

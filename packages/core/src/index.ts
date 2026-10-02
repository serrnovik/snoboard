export { VERSION } from "./version.js";

export {
  fetch,
  folderHistory,
  MAX_HISTORY_COMMITS,
  lastCommitTouching,
  lastCommitsForPaths,
  isReportFile,
  listInitiativeFiles,
  listInitiativeTree,
  listRefs,
  prefetchMissingBlobs,
  readBlobs,
} from "./git.js";

export type {
  CommitTouch,
  FolderHistory,
  HistoryCommit,
  GitCallOptions,
  GitConfig,
  InitiativeFile,
  InitiativeTree,
  RefInfo,
} from "./git.js";
export {
  groupReports,
  MAX_REPORT_BYTES,
  MAX_REPORTS_PER_INITIATIVE,
  reportPhase,
  type ReportEntry,
  type ReportFormat,
} from "./reports.js";
export { ConfigSchema, loadConfig, type Config } from "./config.js";
export {
  InitiativeFrontmatterSchema,
  PhaseSchema,
  type InitiativeFrontmatter,
  type Phase,
} from "./schema.js";
export {
  issueBaseUrl,
  issueLinkFor,
  issueRefFromUrl,
  MAX_ISSUE_REFS,
  normalizeIssueRef,
  parseIssueRef,
  type IssueLinkConfig,
  type IssueRef,
  type IssueUrlResult,
  type ParsedIssueRef,
} from "./issues.js";
export {
  isSafeLinkUrl,
  LinkSchema,
  linkProblem,
  MAX_LINK_TITLE_LENGTH,
  MAX_LINK_URL_LENGTH,
  MAX_LINKS,
  type ExternalLink,
} from "./links.js";
export {
  ASSET_FILE,
  ASSET_PATH,
  ATTACHMENT_TYPES,
  detectImageType,
  extensionFor,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  MAX_SUBMIT_BODY_BYTES,
  NEW_INITIATIVE_REF,
  safeAssetBaseName,
  typeForExtension,
  uniqueAssetPath,
  type AttachmentType,
} from "./attachments.js";
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
export {
  applyEdit,
  bodyHash,
  EditSchema,
  renderNewInitiative,
  summarizeEdit,
  type ApplyEditResult,
  type Edit,
  type NewInitiativeInput,
} from "./edits.js";
export { commitsUnder, MAX_ROOT_COMMITS, type CommitWithFiles, type FileChange } from "./git-commits.js";
export {
  botPatterns,
  DEFAULT_BOT_PATTERNS,
  humansOf,
  isBotAuthor,
  loginFromEmail,
  parseTrailers,
  peopleByFolder,
  type InitiativePeople,
  type PeopleCommit,
  type Person,
  type Trailers,
} from "./people.js";

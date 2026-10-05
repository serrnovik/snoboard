// Browser-safe entry point: no git or filesystem access. The board's client
// bundle imports from "snoboard/browser"; server code uses "snoboard".
export { VERSION } from "./version.js";
export { ConfigSchema, loadConfig, type Config, type LabelDisplay, type ProjectDisplay } from "./config.js";
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
export {
  detectIconType,
  iconProblem,
  iconTypeForPath,
  ICON_IMAGE_TYPES,
  isEmojiIcon,
  isIconPath,
  isLabelColor,
  LABEL_COLORS,
  MAX_ICON_BYTES,
  parseIcon,
  resolveIcon,
  type IconImageType,
  type IconValue,
  type LabelColor,
} from "./icons.js";
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
export type { HistoryCommit, RefInfo } from "./git.js";
export type { InitiativePeople, Person } from "./people.js";
export { EditSchema, MAX_INITIATIVE_BODY_LENGTH, type Edit } from "./edit-schema.js";

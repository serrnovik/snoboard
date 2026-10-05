export type IssueRef = {
  provider: string;
  key: string;
  raw: string;
};

export type IssueState = {
  raw: string;
  title: string;
  state: "open" | "closed" | "unknown";
  url: string;
  updatedAt?: string;
};

/** A new issue. `createdBy` and `initiativeId` go into the footer of trackers that write with a board token. */
export type NewIssue = {
  title: string;
  body: string;
  labels?: string[];
  createdBy: string;
  initiativeId: string;
  /** Vikunja only: project for the task. The server checks it before calling. */
  projectId?: number;
};

/** A tracker project the board's token can see. Only id and title leave the server. */
export type IssueProject = { id: number; title: string };

/** Short ref (`gh#12`, `fj#12`, `vj:45`) and the browser link of a created issue. */
export type CreatedIssue = {
  ref: string;
  url: string;
};

/** Per-request credential. GitHub needs the signed-in person's write token; board-token trackers ignore it. */
export type IssueCredential = {
  token?: string;
};

export type IssueCreateErrorCode = "auth" | "scope" | "not_found" | "rejected" | "upstream";

/** Failure from a tracker. The message never contains a token. */
export class IssueCreateError extends Error {
  readonly code: IssueCreateErrorCode;

  constructor(code: IssueCreateErrorCode, message: string) {
    super(message);
    this.name = "IssueCreateError";
    this.code = code;
  }
}

export interface IssueProvider {
  /** Stable id, for example `gh` or `vikunja`. */
  id: string;
  /** Whether this provider handles the ref. */
  parseRef(ref: IssueRef): boolean;
  /** Browser link. Must not use the network. */
  linkFor(ref: IssueRef): string;
  fetchStates(refs: IssueRef[], signal: AbortSignal): Promise<Map<string, IssueState>>;
  search?(query: string, signal: AbortSignal): Promise<IssueState[]>;
  /** Present only when the provider has what it needs to create issues (config and, for board tokens, a token). */
  createIssue?(issue: NewIssue, credential: IssueCredential, signal: AbortSignal): Promise<CreatedIssue>;
  /** Projects new issues can go to (Vikunja). */
  listProjects?(signal: AbortSignal): Promise<IssueProject[]>;
}

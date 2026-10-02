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

export interface IssueProvider {
  /** Stable id, for example `gh` or `vikunja`. */
  id: string;
  /** Whether this provider handles the ref. */
  parseRef(ref: IssueRef): boolean;
  /** Browser link. Must not use the network. */
  linkFor(ref: IssueRef): string;
  fetchStates(refs: IssueRef[], signal: AbortSignal): Promise<Map<string, IssueState>>;
  search?(query: string, signal: AbortSignal): Promise<IssueState[]>;
}

/**
 * The text "Copy prompt for agent" puts on the clipboard: enough context for a local coding agent
 * (Claude Code, Codex, ...) working in a checkout of the same repository to find the initiative,
 * and how to hand changes back to the board.
 */
export type PromptTarget = {
  repoId: string;
  /** Branch the board shows (or the default branch for the merged view). */
  branch: string;
  initiative?: { id: string; title: string; path: string; status?: string };
  phase?: { id: number; title: string; status?: string };
  /** Pending edits in the basket, for the basket prompt. */
  basket?: { count: number; lines: readonly string[] };
  /** Whether this board has the MCP bridge on for the person. */
  mcp: boolean;
};

export const TASK_PLACEHOLDER = "<describe the task here>";

export function buildAgentPrompt(target: PromptTarget): string {
  const lines: string[] = [];
  lines.push(`Task: ${TASK_PLACEHOLDER}`, "");
  lines.push("Context (Snoboard, a git-native initiative board):");
  lines.push(`- Repository id on the board: ${target.repoId}`);
  lines.push(`- Branch: ${target.branch}`);
  if (target.initiative !== undefined) {
    const { id, title, path, status } = target.initiative;
    lines.push(`- Initiative: ${id} — ${title}${status === undefined ? "" : ` (status: ${status})`}`);
    lines.push(`- File: ${path}`);
    lines.push(`- Folder: ${path.slice(0, path.lastIndexOf("/"))}/ (documents, phases/, reports/)`);
  }
  if (target.phase !== undefined) {
    const { id, title, status } = target.phase;
    lines.push(`- Phase ${id}: ${title}${status === undefined ? "" : ` (status: ${status})`}`);
  }
  if (target.basket !== undefined) {
    lines.push(`- Pending edits in my basket: ${target.basket.count}`);
    for (const line of target.basket.lines.slice(0, 30)) lines.push(`  - ${line}`);
  }
  lines.push("");
  lines.push("How to work:");
  lines.push(`- Work in a local checkout of this repository on branch ${target.branch} (git fetch; git switch ${target.branch}).`);
  if (target.mcp) {
    lines.push(
      `- Use the snoboard MCP tools: get_initiative / list_docs / read_doc (repo "${target.repoId}") to read the current version on the board.`,
      `- For board changes (status, priority, phases, labels, body, documents) call propose_edits (repo "${target.repoId}", branch "${target.branch}") or set_doc_from_local for a document you edited locally. Leave out from/fromHash; the server fills them. I review the proposal in the board inbox and submit it.`,
      `- Or edit the files, commit and push to ${target.branch}, then call notify_pushed (repo "${target.repoId}", branch "${target.branch}") so the board refreshes at once.`,
    );
  } else {
    lines.push(`- Edit the files, commit and push to ${target.branch}; the board picks the change up on its next refresh.`);
  }
  lines.push("- Keep initiative.md frontmatter valid (`snoboard validate` checks it). Do not change ids or folder numbers.");
  return lines.join("\n");
}

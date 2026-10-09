/** Longest branch name Snoboard accepts from a browser or a config file. */
export const MAX_BRANCH_NAME_LENGTH = 200;

/**
 * `git check-ref-format --branch` rules, checked without running git, plus a
 * length cap and no leading `-` (so a name can never be read as an option).
 * Branch names from the browser are untrusted: anything that fails is refused.
 */
export function isValidBranchName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) return false;
  if (name === "@" || name === "HEAD") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
    if (" ~^:?*[\\".includes(char)) return false;
  }
  for (const part of name.split("/")) {
    if (part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) return false;
  }
  if (name.startsWith("refs/")) return false;
  return true;
}

/** `*` and `?` match across `/`, like `branchPatterns`: `feat/*` covers `feat/a/b`. */
export function branchPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (/[.+^${}()|[\]\\]/.test(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`${source}$`);
}

export function matchesBranchPatterns(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => branchPatternToRegExp(pattern).test(name));
}

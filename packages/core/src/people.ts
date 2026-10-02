// Pure helpers (no Node imports): who created and who worked on each initiative,
// from commit metadata and message trailers only.

/** The commit fields people credit needs (a subset of `CommitWithFiles`). */
export type PeopleCommit = {
  date: string;
  authorName: string;
  authorEmail: string;
  body: string;
  files: readonly { status: string; path: string }[];
};

/** Case-insensitive substrings matched against author name and email. */
export const DEFAULT_BOT_PATTERNS: readonly string[] = [
  "[bot]",
  "noreply@anthropic.com",
  "claude",
  "cursor",
  "codex",
  "copilot",
  "dependabot",
  "woodpecker ci",
  "github-actions",
  "snapshot publisher",
];

export type Person = {
  /** Dedupe key: `login:<login>`, `email:<email>` or `name:<name>`, lower-case. */
  key: string;
  name: string;
  /** GitHub login when known (trailer or users.noreply.github.com email). */
  login?: string;
};

export type InitiativePeople = {
  creator: (Person & { date: string }) | null;
  /** Distinct humans, most recent first. */
  participants: Person[];
};

/** Defaults plus a comma list (e.g. SNOBOARD_BOT_AUTHORS). */
export function botPatterns(extra?: string | null): string[] {
  const added = (extra ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return [...new Set([...DEFAULT_BOT_PATTERNS, ...added])];
}

export function isBotAuthor(name: string, email: string, patterns: readonly string[]): boolean {
  const haystack = `${name}\n${email}`.toLowerCase();
  return patterns.some((pattern) => pattern.length > 0 && haystack.includes(pattern.toLowerCase()));
}

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export function loginFromEmail(email: string): string | undefined {
  const match = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  const login = match?.[1];
  return login !== undefined && LOGIN.test(login) ? login : undefined;
}

export type Trailers = {
  editBy: string[];
  coAuthors: { name: string; email: string }[];
};

export function parseTrailers(body: string): Trailers {
  const editBy: string[] = [];
  const coAuthors: { name: string; email: string }[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const edit = /^Snoboard-Edit-By:\s*@?([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/i.exec(line);
    if (edit?.[1] !== undefined) {
      editBy.push(edit[1]);
      continue;
    }
    const co = /^Co-Authored-By:\s*(.*?)\s*<([^<>\s]+)>\s*$/i.exec(line);
    if (co?.[1] !== undefined && co[2] !== undefined) coAuthors.push({ name: co[1], email: co[2] });
  }
  return { editBy, coAuthors };
}

function personFrom(name: string, email: string): Person {
  const cleanName = name.trim();
  const cleanEmail = email.trim();
  const login = loginFromEmail(cleanEmail);
  if (login !== undefined) return { key: `login:${login.toLowerCase()}`, name: cleanName || login, login };
  if (cleanEmail.length > 0) return { key: `email:${cleanEmail.toLowerCase()}`, name: cleanName || cleanEmail };
  return { key: `name:${cleanName.toLowerCase()}`, name: cleanName };
}

function loginPerson(login: string): Person {
  return { key: `login:${login.toLowerCase()}`, name: login, login };
}

/** Humans credited by one commit: Snoboard-Edit-By logins, the author unless a bot, human co-authors. */
export function humansOf(commit: Pick<PeopleCommit, "authorName" | "authorEmail" | "body">, patterns: readonly string[]): Person[] {
  const people: Person[] = [];
  const trailers = parseTrailers(commit.body);
  for (const login of trailers.editBy) people.push(loginPerson(login));
  if (commit.authorName.trim().length > 0 && !isBotAuthor(commit.authorName, commit.authorEmail, patterns)) {
    people.push(personFrom(commit.authorName, commit.authorEmail));
  }
  for (const co of trailers.coAuthors) {
    if (!isBotAuthor(co.name, co.email, patterns)) people.push(personFrom(co.name, co.email));
  }
  return dedupe(people);
}

function dedupe(people: readonly Person[]): Person[] {
  const seen = new Map<string, Person>();
  for (const person of people) {
    const existing = seen.get(person.key);
    if (existing === undefined) {
      seen.set(person.key, person);
    } else if (existing.login !== undefined && existing.name === existing.login && person.name !== existing.login) {
      // Prefer a real display name over the bare login.
      seen.set(person.key, { ...person, login: existing.login });
    }
  }
  return [...seen.values()];
}

/**
 * People per initiative folder (the folder holding `file`), from commits newest first.
 * Creator = first credited human of the oldest commit that added `<folder>/<file>`.
 */
export function peopleByFolder(
  commits: readonly PeopleCommit[],
  file: string,
  patterns: readonly string[],
): Map<string, InitiativePeople> {
  const folders = new Set<string>();
  for (const commit of commits) {
    for (const change of commit.files) {
      if (change.path.endsWith(`/${file}`)) folders.add(change.path.slice(0, -file.length - 1));
    }
  }
  const folderOf = (path: string): string | undefined => {
    let candidate = path;
    let index = candidate.lastIndexOf("/");
    while (index > 0) {
      candidate = candidate.slice(0, index);
      if (folders.has(candidate)) return candidate;
      index = candidate.lastIndexOf("/");
    }
    return undefined;
  };
  const result = new Map<string, InitiativePeople>();
  for (const commit of commits) {
    const touched = new Set<string>();
    for (const change of commit.files) {
      const folder = folderOf(change.path);
      if (folder !== undefined) touched.add(folder);
    }
    if (touched.size === 0) continue;
    const humans = humansOf(commit, patterns);
    for (const folder of touched) {
      let entry = result.get(folder);
      if (entry === undefined) {
        entry = { creator: null, participants: [] };
        result.set(folder, entry);
      }
      for (const human of humans) {
        const index = entry.participants.findIndex((person) => person.key === human.key);
        if (index === -1) entry.participants.push(human);
        else if (entry.participants[index]!.login === undefined && human.login !== undefined) entry.participants[index] = human;
      }
      const added = commit.files.some((change) => change.status.startsWith("A") && change.path === `${folder}/${file}`);
      // Newest first, so the last "added" commit seen is the oldest one.
      if (added) entry.creator = humans[0] === undefined ? null : { ...humans[0], date: commit.date };
    }
  }
  return result;
}

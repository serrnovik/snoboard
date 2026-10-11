export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Above this many changed lines the diff is shown as "all old, then all new". */
const MAX_EDIT_DISTANCE = 1500;

/**
 * Line diff (Myers, O((N+M)·D)). Line endings are normalised, so a CRLF file and its LF edit
 * only differ where the text does.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const limit = Math.min(max, MAX_EDIT_DISTANCE);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  // Frontier before step d, only diagonals -d-1..d+1 (index k + d + 1): memory grows with D², not D·(N+M).
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1 < 0 ? 0 : offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found !== -1) break;
  }
  if (found === -1) {
    return [...a.map((text) => ({ type: "del" as const, text })), ...b.map((text) => ({ type: "add" as const, text }))];
  }
  // Walk back through the saved frontiers.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const frontier = trace[d]!;
    const at = (diagonal: number) => frontier[diagonal + d + 1 - Math.max(0, d + 1 - offset)]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ type: "same", text: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (down) out.push({ type: "add", text: b[prevY]! });
    else out.push({ type: "del", text: a[prevX]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    out.push({ type: "same", text: a[x - 1]! });
    x -= 1;
    y -= 1;
  }
  return out.reverse();
}

/** Keeps `context` unchanged lines around each change; longer unchanged runs become one `…` marker. */
export function collapseDiff(lines: readonly DiffLine[], context = 3): (DiffLine | { type: "skip"; count: number })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === "same") return;
    for (let at = Math.max(0, index - context); at <= Math.min(lines.length - 1, index + context); at += 1) keep[at] = true;
  });
  const out: (DiffLine | { type: "skip"; count: number })[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ type: "skip", count: skipped });
      skipped = 0;
      out.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ type: "skip", count: skipped });
  return out;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

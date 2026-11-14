// A line diff (Myers' O(ND) algorithm) written as a unified diff: for "changed since shown" (a file against its
// snapshot) and for before/after text in a review, where there is no git to ask.

type Op = { t: ' ' | '-' | '+'; line: string };

/** the edit script from a to b, as kept / removed / added lines */
export function diffLines(a: string[], b: string[], maxD = 4000): Op[] {
  // trim the common start and end: most edits are small, and this keeps the search tiny
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA),
    B = b.slice(start, endB);
  const head: Op[] = a.slice(0, start).map((line) => ({ t: ' ', line }));
  const tail: Op[] = a.slice(endA).map((line) => ({ t: ' ', line }));
  const N = A.length,
    M = B.length;
  const max = N + M;
  if (!N || !M) return [...head, ...A.map((line): Op => ({ t: '-', line })), ...B.map((line): Op => ({ t: '+', line })), ...tail];
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0)) ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) {
    // too different to be worth the search: everything out, everything in
    return [...head, ...A.map((line): Op => ({ t: '-', line })), ...B.map((line): Op => ({ t: '+', line })), ...tail];
  }
  const ops: Op[] = [];
  let x = N,
    y = M;
  for (let d = found; d > 0; d--) {
    const vv = trace[d] as Int32Array;
    const k = x - y;
    const prevK = k === -d || (k !== d && (vv[off + k - 1] ?? 0) < (vv[off + k + 1] ?? 0)) ? k + 1 : k - 1;
    const prevX = vv[off + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: A[--x] ?? '' });
      y--;
    }
    if (x === prevX) ops.push({ t: '+', line: B[--y] ?? '' });
    else ops.push({ t: '-', line: A[--x] ?? '' });
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', line: A[--x] ?? '' });
    y--;
  }
  ops.reverse();
  return [...head, ...ops, ...tail];
}

/** a unified diff of two texts ("" when they're the same) */
export function unifiedDiff(before: string, after: string, nameA = 'before', nameB = 'after', context = 3): string {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  const ops = diffLines(a, b);
  if (!ops.some((o) => o.t !== ' ')) return '';
  const out = [`--- a/${nameA}`, `+++ b/${nameB}`];
  // walk the script, cutting it into hunks with `context` kept lines around each change
  let i = 0;
  let oa = 1,
    ob = 1;
  const pos: { a: number; b: number }[] = ops.map((o) => {
    const p = { a: oa, b: ob };
    if (o.t !== '+') oa++;
    if (o.t !== '-') ob++;
    return p;
  });
  while (i < ops.length) {
    while (i < ops.length && ops[i]?.t === ' ') i++;
    if (i >= ops.length) break;
    const from = Math.max(0, i - context);
    let to = i;
    let calm = 0;
    while (to < ops.length) {
      if (ops[to]?.t === ' ') {
        calm++;
        if (calm > context * 2) break;
      } else calm = 0;
      to++;
    }
    to = Math.min(ops.length, to - Math.max(0, calm - context));
    const hunk = ops.slice(from, to);
    const p = pos[from] ?? { a: 1, b: 1 };
    const na = hunk.filter((o) => o.t !== '+').length;
    const nb = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${na ? p.a : p.a - 1},${na} +${nb ? p.b : p.b - 1},${nb} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    i = to;
  }
  return out.join('\n') + '\n';
}

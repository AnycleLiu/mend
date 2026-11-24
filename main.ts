// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, the three matching tiers, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// Design notes: edits are closures over a Tree that tracks the original bytes of every path they touch, so a failed
// edit rolls back on its own and nothing is written unless every edit succeeds. Line matching is tiered (exact,
// then trailing-whitespace-insensitive, then fully trim-insensitive); a context line is always rewritten with the
// file's own matched line, and at tier 2 the other new lines are re-indented from the patch's first-line indent to
// the file's. Moves are recorded as they apply and reported with a single `R old -> new` line when the pair's
// before/after states are exactly a move.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- files as lines (SPEC.md section 3) ----------

interface FText {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitText(text: string): FText {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    fin = true;
    parts.pop();
  }
  return { lines: parts, br, fin };
}

function joinText(ft: FText): string {
  if (ft.lines.length === 0) return '';
  return ft.lines.join(ft.br) + (ft.fin ? ft.br : '');
}

// ---------- matching lines (SPEC.md section 5) ----------

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

function occurrences(fileLines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!tierEq(fileLines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(fileLines: string[], O: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(fileLines, O, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** Replace the O lines matched at `pos` by N; nMap[j] is the O index of N[j] when it is a context line, else -1. */
function applyMatch(fileLines: string[], pos: number, O: string[], N: string[], nMap: number[], tier: number): string[] {
  const F = leadST(fileLines[pos] ?? '');
  const P = leadST(O[0] ?? '');
  const mid: string[] = [];
  for (let j = 0; j < N.length; j++) {
    const oi = nMap[j]!;
    if (oi >= 0) {
      mid.push(fileLines[pos + oi]!);
      continue;
    }
    let line = N[j]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(P)) line = F + line.slice(P.length);
    mid.push(line);
  }
  return [...fileLines.slice(0, pos), ...mid, ...fileLines.slice(pos + O.length)];
}

// ---------- JSON edits (SPEC.md section 9) ----------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- unified diffs (SPEC.md section 6) ----------

type BodyKind = 'ctx' | 'del' | 'add' | 'bs';
interface BodyLine {
  kind: BodyKind;
  text: string;
  rawEmpty: boolean;
}
interface UHunk {
  a: number;
  body: BodyLine[];
}
interface USection {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  gitOld: string | null;
  gitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const trimSpaces = (s: string): string => s.replace(/^ +| +$/g, '');

function headPath(raw: string): string | null {
  const p = trimSpaces(raw.split('\t')[0]!);
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function hunkON(h: UHunk): { O: string[]; N: string[]; nMap: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nMap: number[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      nMap.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === 'del') {
      O.push(b.text);
    } else if (b.kind === 'add') {
      nMap.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, nMap };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function bsAfterLast(h: UHunk): boolean {
  let last = -1;
  h.body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'add') last = i;
  });
  return last >= 0 && h.body[last + 1]?.kind === 'bs';
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let inHeader = false;
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  const newSection = (): USection => {
    const s: USection = { pairOld: null, pairNew: null, hasPair: false, gitOld: null, gitNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    sec = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (sec === null || !inHeader || sec.hasPair) newSection();
      sec!.pairOld = headPath(l.slice(4));
      sec!.pairNew = headPath(lines[i + 1]!.slice(4));
      sec!.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (sec !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec.delFile || (sec.hasPair && sec.pairNew === null)) {
        // A deletion section (SPEC.md section 6): its hunks are not read, so
        // their lines are skipped unexamined up to the next section.
        let j = i + 1;
        while (j < lines.length && !lines[j]!.startsWith('diff --git ') && !pairAt(j)) j += 1;
        inHeader = false;
        i = j;
        continue;
      }
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: Number(m[1]), body: [] };
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || pairAt(j)) break;
        const c = b[0];
        if (b === '') hunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (c === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1), rawEmpty: false });
        else if (c === '-') hunk.body.push({ kind: 'del', text: b.slice(1), rawEmpty: false });
        else if (c === '+') hunk.body.push({ kind: 'add', text: b.slice(1), rawEmpty: false });
        else if (c === '\\') hunk.body.push({ kind: 'bs', text: b.slice(1), rawEmpty: false });
        else break;
        j += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawEmpty) hunk.body.pop();
      sec.hunks.push(hunk);
      inHeader = false;
      i = j;
      continue;
    }
    if (sec !== null && inHeader) {
      if (l.startsWith('rename from ')) sec.renameFrom = trimSpaces(l.slice(12).split('\t')[0]!);
      else if (l.startsWith('rename to ')) sec.renameTo = trimSpaces(l.slice(10).split('\t')[0]!);
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldP = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.gitOld);
  const newP = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.gitNew);
  const creation = sec.newFile || (sec.hasPair && sec.pairOld === null);
  const deletion = !creation && (sec.delFile || (sec.hasPair && sec.pairNew === null));
  return (tree) => {
    if (creation) {
      const p = newP ?? oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      let lastAddHunk = -1;
      let lastAddAt = -1;
      sec.hunks.forEach((h, hi) => {
        h.body.forEach((b, bi) => {
          if (b.kind === 'add') {
            content.push(b.text);
            lastAddHunk = hi;
            lastAddAt = bi;
          }
        });
      });
      let fin = true;
      if (lastAddHunk >= 0 && sec.hunks[lastAddHunk]!.body[lastAddAt + 1]?.kind === 'bs') fin = false;
      tree.now.set(p, content.length === 0 ? '' : content.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (deletion) {
      const p = oldP ?? newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldP ?? newP ?? '';
    const np = newP ?? oldP ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    if (np !== op && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const move = np !== op;
    if (move && tree.get(np) !== null) throw new Fail('exists', np);
    const ft = splitText(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N, nMap } = hunkON(h);
      if (O.length === 0) {
        const at = Math.min(h.a + d, ft.lines.length);
        const atEnd = at === ft.lines.length;
        ft.lines = [...ft.lines.slice(0, at), ...N, ...ft.lines.slice(at)];
        if (atEnd) ft.fin = !bsAfterLast(h);
      } else {
        const found = findTier(ft.lines, O, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let pos = found.at[0]!;
        for (const cand of found.at) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const touchesEnd = pos + O.length === ft.lines.length;
        ft.lines = applyMatch(ft.lines, pos, O, N, nMap, found.tier);
        if (touchesEnd) ft.fin = !bsAfterLast(h);
      }
      d += N.length - O.length;
    }
    if (move) {
      tree.now.set(op, null);
      tree.now.set(np, joinText(ft));
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, joinText(ft));
    }
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let boundary = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let k = at - 1; k >= boundary; k--) {
      const l = lines[k]!;
      if (!blank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${at + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = at + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    const oldLines = lines.slice(at + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const ft = splitText(before);
      const found = findTier(ft.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      ft.lines = applyMatch(ft.lines, found.at[0]!, oldLines, newLines, newLines.map(() => -1), found.tier);
      tree.now.set(p, joinText(ft));
    });
    prevPath = path;
    boundary = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lastNB = k;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'upd';
    const path = l.slice(kind === 'add' ? 14 : 17).trim();
    const startLine = i;
    i += 1;
    const bodyStart = i;
    while (i < lastNB && !isStart(lines[i]!)) i += 1;
    const body = lines.slice(bodyStart, i);
    edits.push(v4aSectionEdit(kind, path, body, bodyStart, startLine, strict));
  }
  return edits;
}

function v4aSectionEdit(kind: 'add' | 'del' | 'upd', path: string, rawBody: string[], bodyStart: number, startLine: number, strict: boolean): Edit {
  const body = [...rawBody];
  while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
  if (kind === 'add') {
    const content: string[] = [];
    body.forEach((l, j) => {
      if (l.startsWith('+')) content.push(l.slice(1));
      else if (l === '') content.push('');
      else throw new Exit2(`error: parse ${bodyStart + j + 1}`);
    });
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
    };
  }
  if (kind === 'del') {
    body.forEach((l, j) => {
      if (!blank(l)) throw new Exit2(`error: parse ${bodyStart + j + 1}`);
    });
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // Update File: skip leading blank lines (they sit between sections), then Move to / chunks.
  let lead = 0;
  while (lead < body.length && blank(body[lead]!)) lead += 1;
  const lines = body.slice(lead);
  const lineNo = (j: number): number => bodyStart + lead + j + 1;
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let closed = false;
  lines.forEach((l, j) => {
    if (j === 0 && l.startsWith('*** Move to: ')) {
      moveTo = l.slice(13).trim();
      return;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${lineNo(j)}`);
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
      chunks.push(cur);
      closed = false;
      return;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, eof: true, body: [] };
        chunks.push(cur);
      } else {
        cur.eof = true;
      }
      closed = true;
      return;
    }
    const c = l[0];
    const entry: BodyLine | null =
      l === '' ? { kind: 'ctx', text: '', rawEmpty: true }
      : c === ' ' ? { kind: 'ctx', text: l.slice(1), rawEmpty: false }
      : c === '-' ? { kind: 'del', text: l.slice(1), rawEmpty: false }
      : c === '+' ? { kind: 'add', text: l.slice(1), rawEmpty: false }
      : null;
    if (entry === null) throw new Exit2(`error: parse ${lineNo(j)}`);
    if (cur === null) {
      cur = { anchor: null, eof: false, body: [] };
      chunks.push(cur);
    } else if (closed) {
      throw new Exit2(`error: parse ${lineNo(j)}`);
    }
    cur.body.push(entry);
  });
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
  const mv = moveTo;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
    const ft = splitText(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let posA = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < ft.lines.length; k++) {
            if (tierEq(ft.lines[k]!, ch.anchor, t)) {
              posA = k;
              break;
            }
          }
          if (posA >= 0) break;
        }
        if (posA < 0) throw new Fail('no-match', path);
        cursor = posA + 1;
      }
      const O: string[] = [];
      const N: string[] = [];
      const nMap: number[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') {
          nMap.push(O.length);
          O.push(b.text);
          N.push(b.text);
        } else if (b.kind === 'del') {
          O.push(b.text);
        } else if (b.kind === 'add') {
          nMap.push(-1);
          N.push(b.text);
        }
      }
      if (O.length === 0) {
        const at = ch.eof ? ft.lines.length : Math.min(cursor, ft.lines.length);
        ft.lines = [...ft.lines.slice(0, at), ...N, ...ft.lines.slice(at)];
        cursor = at + N.length;
      } else {
        const found = findTier(ft.lines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        const cand = ch.eof ? found.at.filter((p) => p + O.length === ft.lines.length) : found.at;
        if (cand.length === 0) throw new Fail('no-match', path);
        const pos = cand[0]!;
        ft.lines = applyMatch(ft.lines, pos, O, N, nMap, found.tier);
        cursor = pos + N.length;
      }
    }
    if (mv !== null) {
      tree.now.set(path, null);
      tree.now.set(mv, joinText(ft));
      tree.moves.push([path, mv]);
    } else {
      tree.now.set(path, joinText(ft));
    }
  };
}

// ---------- the run (SPEC.md sections 1, 2 and 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const cur = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rByNew = new Map<string, string>();
  const suppressed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && cur(o) === null && tree.original(n) === null && cur(n) !== null && !rByNew.has(n)) {
      rByNew.set(n, o);
      suppressed.add(o);
    }
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    if (suppressed.has(p) || rByNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [n, o] of rByNew) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

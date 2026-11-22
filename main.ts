
// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Successful move edits, in the order they ran: [old path, new path]. */
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

/** A file held as its lines, its own line break and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Line equality at a matching tier (SPEC.md section 5): 0 exact, 1 trailing blanks off, 2 both ends off. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every start position at which `old` occurs in `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `old` occurs at least once, with its positions there; null when it occurs nowhere. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, old, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: `ctx` is its index in the old lines when it is a context line, else -1. */
interface NLine {
  text: string;
  ctx: number;
}

/**
 * The lines a match writes (SPEC.md section 5): a context line is the file's own matched line; at tier 2 every
 * other line that starts with the old lines' first line's indent has that indent swapped for the file's.
 */
function buildNew(fileLines: string[], pos: number, old: string[], nlines: NLine[], tier: number): string[] {
  let leadF = '';
  let leadP = '';
  if (tier === 2 && old.length > 0) {
    leadF = /^[ \t]*/.exec(fileLines[pos] ?? '')![0]!;
    leadP = /^[ \t]*/.exec(old[0]!)![0]!;
  }
  return nlines.map((n) => {
    if (n.ctx >= 0) return fileLines[pos + n.ctx]!;
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(leadP)) return leadF + n.text.slice(leadP.length);
    return n.text;
  });
}

function splice(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

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

/** One line of a hunk or chunk body: its kind (' ', '-', '+' or '\'), its text, and whether the patch line was empty. */
interface BodyEntry {
  kind: string;
  text: string;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  headOld?: string | null;
  headNew?: string | null;
  hasPair: boolean;
  renameOld?: string;
  renameNew?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const newSection = (): Section => ({ hasPair: false, create: false, del: false, hunks: [] });

/** The path a --- or +++ line names: up to the first tab, spaces off, /dev/null as null, an a/ or b/ prefix removed. */
function headPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Whether a `\` line follows the body's last context or `+` line (the no-final-break marker of section 6). */
function backslashAfterLast(entries: BodyEntry[]): boolean {
  let last = -1;
  entries.forEach((e, idx) => {
    if (e.kind === ' ' || e.kind === '+') last = idx;
  });
  return last >= 0 && entries[last + 1]?.kind === '\\';
}

/** Apply one unified hunk to `lines`; `d` is this section's line drift so far. Throws Fail when its lines are not found. */
function applyHunk(
  lines: string[],
  final: boolean,
  hunk: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { lines: string[]; final: boolean; delta: number } {
  const old: string[] = [];
  const nlines: NLine[] = [];
  for (const e of hunk.entries) {
    if (e.kind === ' ') {
      const oi = old.length;
      old.push(e.text);
      nlines.push({ text: e.text, ctx: oi });
    } else if (e.kind === '-') old.push(e.text);
    else if (e.kind === '+') nlines.push({ text: e.text, ctx: -1 });
  }
  if (old.length === 0) {
    const pos = Math.min(hunk.a + d, lines.length);
    const ins = nlines.map((n) => n.text);
    return { lines: splice(lines, pos, 0, ins), final: pos === lines.length ? !backslashAfterLast(hunk.entries) : final, delta: ins.length };
  }
  const found = findTier(lines, old, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.at[0]!;
  for (const p of found.at) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const written = buildNew(lines, pos, old, nlines, found.tier);
  const touchesEnd = pos + old.length === lines.length;
  return {
    lines: splice(lines, pos, old.length, written),
    final: touchesEnd ? !backslashAfterLast(hunk.entries) : final,
    delta: nlines.length - old.length,
  };
}

/** One unified section as an edit (SPEC.md section 6): a creation, a deletion, a move or a change of one path. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.headOld !== undefined ? sec.headOld : (sec.renameOld ?? sec.diffOld);
    const newP = sec.headNew !== undefined ? sec.headNew : (sec.renameNew ?? sec.diffNew);
    if (sec.create || oldP === null) {
      const p = newP ?? oldP;
      if (p === undefined) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      let lastPlusSlash: boolean | null = null;
      for (const h of sec.hunks) {
        h.entries.forEach((e, idx) => {
          if (e.kind === '+') {
            content.push(e.text);
            lastPlusSlash = h.entries[idx + 1]?.kind === '\\';
          }
        });
      }
      const fin = content.length > 0 && lastPlusSlash !== true;
      tree.now.set(p, joinFile({ lines: content, br: '\n', final: fin }));
      return;
    }
    if (sec.del || newP === null) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldP!;
    const to = newP!;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const model = splitFile(before);
    let lines = model.lines;
    let final = model.final;
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyHunk(lines, final, h, d, strict, from);
      lines = r.lines;
      final = r.final;
      d += r.delta;
    }
    tree.now.set(to, joinFile({ lines, br: model.br, final }));
    if (to !== from) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

/** Read a unified diff into its section edits (SPEC.md section 6). Parse faults throw Exit2 before any file is read. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.*?) b\/(.*)$/.exec(line.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!;
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      if (sec === null || !inHeader || sec.hasPair) {
        sec = newSection();
        sections.push(sec);
        inHeader = true;
      }
      sec.headOld = headPath(line);
      sec.headNew = headPath(next);
      sec.hasPair = true;
      i += 2;
      continue;
    }
    if (sec !== null && inHeader && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const entries: BodyEntry[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          entries.push({ kind: ' ', text: '', rawEmpty: true });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          entries.push({ kind: c, text: bl.slice(1), rawEmpty: false });
          i += 1;
          continue;
        }
        break;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.rawEmpty) entries.pop();
      sec.hunks.push({ a: Number(hm[1]), entries });
      inHeader = false;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('rename from ')) sec.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.create = true;
      else if (line.startsWith('deleted file mode')) sec.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7): empty old lines create the file, else one exact-tier match. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: [...newLines], br: '\n', final: newLines.length > 0 }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const nlines: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const written = buildNew(model.lines, pos, oldLines, nlines, found.tier);
    tree.now.set(path, joinFile({ lines: splice(model.lines, pos, oldLines.length, written), br: model.br, final: model.final }));
  };
}

/** Read SEARCH/REPLACE blocks into edits (SPEC.md section 7). A block's path is the nearest plain line above it. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let region = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j >= region; j -= 1) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(srEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, rep), strict));
    lastPath = path;
    region = rep + 1;
    i = rep + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  moveTo?: string;
  addLines: string[];
  chunks: VChunk[];
}

/** Apply one V4A chunk at or after the cursor (SPEC.md section 8). Throws Fail when its anchor or lines are not found. */
function applyVChunk(lines: string[], cursor: number, ch: VChunk, strict: boolean, path: string): { lines: string[]; cursor: number } {
  if (ch.anchor !== null) {
    let foundAt = -1;
    for (const tier of strict ? [0] : [0, 1, 2]) {
      for (let i = cursor; i < lines.length; i += 1) {
        if (lineEq(lines[i]!, ch.anchor, tier)) {
          foundAt = i;
          break;
        }
      }
      if (foundAt >= 0) break;
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cursor = foundAt + 1;
  }
  const old: string[] = [];
  const nlines: NLine[] = [];
  for (const e of ch.entries) {
    if (e.kind === ' ') {
      const oi = old.length;
      old.push(e.text);
      nlines.push({ text: e.text, ctx: oi });
    } else if (e.kind === '-') old.push(e.text);
    else if (e.kind === '+') nlines.push({ text: e.text, ctx: -1 });
  }
  if (old.length === 0) {
    const pos = ch.eof ? lines.length : Math.min(cursor, lines.length);
    const ins = nlines.map((n) => n.text);
    return { lines: splice(lines, pos, 0, ins), cursor: pos + ins.length };
  }
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, old, tier).filter((i) => i >= cursor && (!ch.eof || i + old.length === lines.length));
    if (at.length > 0) {
      const pos = at[0]!;
      const written = buildNew(lines, pos, old, nlines, tier);
      return { lines: splice(lines, pos, old.length, written), cursor: pos + written.length };
    }
  }
  throw new Fail('no-match', path);
}

/** One V4A section as an edit (SPEC.md section 8): an Add File, a Delete File or an Update File, with its Move to. */
function vSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls = sec.addLines;
      tree.now.set(p, joinFile({ lines: [...ls], br: '\n', final: ls.length > 0 }));
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const to = sec.moveTo;
    if (to !== undefined && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (to !== undefined && to !== p && tree.get(to) !== null) throw new Fail('exists', to);
    const model = splitFile(before);
    let lines = model.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      const r = applyVChunk(lines, cursor, ch, strict, p);
      lines = r.lines;
      cursor = r.cursor;
    }
    const dest = to !== undefined ? to : p;
    tree.now.set(dest, joinFile({ lines, br: model.br, final: model.final }));
    if (to !== undefined && to !== p) {
      tree.now.set(p, null);
      tree.moves.push([p, to]);
    }
  };
}

/** Read a V4A patch into its section edits (SPEC.md section 8). Parse faults throw Exit2 before any file is read. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstNB = lines.findIndex((l) => !blank(l));
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  const closeUpd = (): void => {
    if (cur !== null && cur.kind === 'upd') {
      const last = cur.chunks[cur.chunks.length - 1];
      if (last !== undefined) {
        // A blank line at the end of a section is not part of it (section 8): a trailing context line whose
        // patch line was empty or only whitespace (its text empty or only whitespace) is dropped.
        while (last.entries.length > 0) {
          const tail = last.entries[last.entries.length - 1]!;
          if (tail.kind === ' ' && tail.text.trim() === '') last.entries.pop();
          else break;
        }
        if (last.entries.length === 0 && last.anchor === null && !last.eof) cur.chunks.pop();
      }
      if (cur.chunks.length === 0 && cur.moveTo === undefined) throw new Exit2(`error: parse ${cur.lineNo}`);
    }
    if (cur !== null && cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
    }
  };
  for (let i = firstNB + 1; i < lastNB; i += 1) {
    const line = lines[i]!;
    const head = line.startsWith('*** Add File:')
      ? 'add'
      : line.startsWith('*** Delete File:')
        ? 'del'
        : line.startsWith('*** Update File:')
          ? 'upd'
          : null;
    if (head !== null) {
      closeUpd();
      cur = { kind: head, path: line.slice(line.indexOf(':') + 1).trim(), lineNo: i + 1, addLines: [], chunks: [] };
      sections.push(cur);
      chunk = null;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        cur.addLines.push(line.slice(1));
        continue;
      }
      if (line === '') {
        cur.addLines.push('');
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (line.startsWith('*** Move to:') && cur.chunks.length === 0 && chunk === null && cur.moveTo === undefined) {
      cur.moveTo = line.slice('*** Move to:'.length).trim();
      continue;
    }
    if (line.trimEnd() === '*** End of File') {
      if (chunk !== null) chunk.eof = true;
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
      cur.chunks.push(chunk);
      continue;
    }
    if (line === '' && chunk === null) continue;
    const c = line[0];
    if (line === '' || c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, entries: [] };
        cur.chunks.push(chunk);
      }
      chunk.entries.push({ kind: line === '' ? ' ' : c!, text: line === '' ? '' : line.slice(1), rawEmpty: line === '' });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  closeUpd();
  return sections.map((s) => vSectionEdit(s, strict));
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const fin = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && fin(o) === null && tree.original(n) === null && fin(n) !== null && !rNew.has(n)) {
      rOld.add(o);
      rNew.add(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!rOld.has(p) && !rNew.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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

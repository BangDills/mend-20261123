// mend: one patch tool for every AI edit format (SPEC.md v1).
// Node 22, stdlib only. Run: node main.ts [options] [PATCH].

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';
let STRICT = false;

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function splitFile(text: string): { br: string; lines: string[]; fin: boolean } {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadIndent(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Occurrences of O in fileLines at first tier with any. */
function tierOcc(fileLines: string[], O: string[]): { tier: number; pos: number[] } | null {
  const tiers = STRICT ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const nO = O.map((l) => normLine(l, t));
    const pos: number[] = [];
    if (O.length <= fileLines.length) {
      for (let i = 0; i + O.length <= fileLines.length; i += 1) {
        let ok = true;
        for (let j = 0; j < O.length; j += 1) {
          if (normLine(fileLines[i + j]!, t) !== nO[j]) { ok = false; break; }
        }
        if (ok) pos.push(i);
      }
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** Build replacement lines: ctx from file, others re-indented at tier 2. */
function buildN(fileLines: string[], at: number, O: string[], N: string[], isCtx: boolean[], ctxOIdx: number[], tier: number): string[] {
  const out: string[] = [];
  const F = tier === 2 && O.length > 0 ? leadIndent(fileLines[at] ?? '') : '';
  const P = tier === 2 && O.length > 0 ? leadIndent(O[0] ?? '') : '';
  let ci = 0;
  for (let i = 0; i < N.length; i += 1) {
    if (isCtx[i]) { out.push(fileLines[at + ctxOIdx[ci]!]!); ci += 1; }
    else {
      const l = N[i]!;
      if (tier === 2 && l !== '' && !/^[ \t]*$/.test(l) && l.startsWith(P)) out.push(F + l.slice(P.length));
      else out.push(l);
    }
  }
  return out;
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch { v = null; }
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
  if (lines.some((l, i) => l.startsWith('diff --git ') ||
    (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- unified (SPEC section 6) ----------

function uniPath(s: string): string | null {
  let t = s;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

interface UHunk { a: number; O: string[]; N: string[]; isCtx: boolean[]; ctxOIdx: number[]; noBreak: boolean; }
interface USec {
  oldP: string | null; newP: string | null; isNew: boolean; isDel: boolean;
  hasPaths: boolean; hunks: UHunk[];
}

function parseHunkBody(raw: string[]): { O: string[]; N: string[]; isCtx: boolean[]; ctxOIdx: number[]; noBreak: boolean } {
  const O: string[] = [];
  const N: string[] = [];
  const isCtx: boolean[] = [];
  const ctxOIdx: number[] = [];
  let oPtr = 0;
  let noBreak = false;
  for (const bl of raw) {
    if (bl[0] === '\\') { noBreak = true; continue; }
    noBreak = false;
    if (bl === '') { O.push(''); N.push(''); isCtx.push(true); ctxOIdx.push(oPtr); oPtr += 1; }
    else if (bl[0] === ' ') { const t = bl.slice(1); O.push(t); N.push(t); isCtx.push(true); ctxOIdx.push(oPtr); oPtr += 1; }
    else if (bl[0] === '-') { O.push(bl.slice(1)); oPtr += 1; }
    else if (bl[0] === '+') { N.push(bl.slice(1)); isCtx.push(false); }
  }
  return { O, N, isCtx, ctxOIdx, noBreak };
}

function unifiedEdits(lines: string[]): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  let inBody = false; // true once first hunk seen in cur
  let i = 0;
  const n = lines.length;
  const fresh = (): USec => ({ oldP: null, newP: null, isNew: false, isDel: false, hasPaths: false, hunks: [] });
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  while (i < n) {
    const l = lines[i]!;
    const diffM = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
    if (diffM) {
      cur = fresh();
      cur.oldP = diffM[1]!; cur.newP = diffM[2]!;
      secs.push(cur); inBody = false; i += 1; continue;
    }
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      if (cur === null || inBody) { cur = fresh(); secs.push(cur); inBody = false; }
      cur.oldP = uniPath(l.slice(4));
      cur.newP = uniPath(lines[i + 1]!.slice(4));
      cur.hasPaths = true;
      i += 2; continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1; continue;
    }
    if (!inBody) {
      if (l.startsWith('--- ') && !(i + 1 < n && lines[i + 1]!.startsWith('+++ '))) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) { cur.oldP = l.slice(12).trim(); cur.hasPaths = true; i += 1; continue; }
      if (l.startsWith('rename to ')) { cur.newP = l.slice(10).trim(); cur.hasPaths = true; i += 1; continue; }
      if (l === 'new file mode' || l.startsWith('new file mode ')) { cur.isNew = true; i += 1; continue; }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) { cur.isDel = true; i += 1; continue; }
      const hm = hunkRe.exec(l);
      if (hm && l.startsWith('@@')) {
        inBody = true;
        cur.hunks.push({ a: parseInt(hm[1]!, 10), O: [], N: [], isCtx: [], ctxOIdx: [], noBreak: false, _raw: [] } as unknown as UHunk);
        (cur.hunks[cur.hunks.length - 1] as unknown as { _raw: string[] })._raw = [];
        i += 1; continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1; continue;
    }
    // inBody: collect body lines
    const h = cur.hunks[cur.hunks.length - 1]! as unknown as UHunk & { _raw: string[] };
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      h._raw.push(l); i += 1; continue;
    }
    const hm2 = hunkRe.exec(l);
    if (hm2 && l.startsWith('@@')) {
      const p = parseHunkBody(h._raw);
      h.O = p.O; h.N = p.N; h.isCtx = p.isCtx; h.ctxOIdx = p.ctxOIdx; h.noBreak = p.noBreak;
      cur.hunks.push({ a: parseInt(hm2[1]!, 10), O: [], N: [], isCtx: [], ctxOIdx: [], noBreak: false, _raw: [] } as unknown as UHunk);
      i += 1; continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    // body ends: finalize current hunk (trim trailing empty raw lines)
    const raw = h._raw;
    while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    const p = parseHunkBody(raw);
    h.O = p.O; h.N = p.N; h.isCtx = p.isCtx; h.ctxOIdx = p.ctxOIdx; h.noBreak = p.noBreak;
    inBody = false;
    cur = null; // trailing prose until next section start; reprocess line
    continue;
  }
  // finalize open hunk
  for (const s of secs) {
    const last = s.hunks[s.hunks.length - 1] as unknown as (UHunk & { _raw?: string[] }) | undefined;
    if (last && last._raw !== undefined && last.O.length === 0 && last.N.length === 0) {
      const raw = last._raw;
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const p = parseHunkBody(raw);
      last.O = p.O; last.N = p.N; last.isCtx = p.isCtx; last.ctxOIdx = p.ctxOIdx; last.noBreak = p.noBreak;
      delete last._raw;
    } else if (last && last._raw !== undefined) delete last._raw;
  }

  const edits: Edit[] = [];
  for (const s of secs) {
    if (!s.hasPaths && s.oldP === null && s.newP === null && s.hunks.length === 0) continue;
    if (s.hunks.length === 0 && !s.hasPaths && s.oldP === null) continue;
    edits.push(((sec: USec) => {
      const fn = (tree: Tree): void => {
      const oldP = sec.oldP;
      const newP = sec.newP;
      const creation = oldP === null || sec.isNew;
      const deletion = newP === null || sec.isDel;
      const move = !creation && !deletion && oldP !== newP;
      if (creation) {
        const t = newP as string;
        if (!safe(t)) throw new Fail('unsafe', t);
        if (tree.get(t) !== null) throw new Fail('exists', t);
        const out: string[] = [];
        let noBreak = false;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.N.length; k += 1) {
            if (!h.isCtx[k]) out.push(h.N[k]!);
          }
          noBreak = h.noBreak;
        }
        tree.now.set(t, out.length === 0 ? '' : out.join('\n') + (noBreak ? '' : '\n'));
        return;
      }
      const op = oldP as string;
      if (!safe(op)) throw new Fail('unsafe', op);
      const cur0 = tree.get(op);
      if (cur0 === null) throw new Fail('missing', op);
      if (deletion) { tree.now.set(op, null); return; }
      if (move) {
        const np = newP as string;
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
      }
      const { br, lines: f0, fin: fin0 } = splitFile(cur0);
      let fl = [...f0];
      let fin = fin0;
      let d = 0;
      const oldLen = f0.length;
      for (const h of sec.hunks) {
        if (h.O.length === 0) {
          let ins = h.a + d;
          if (ins < 0) ins = 0;
          if (ins > fl.length) ins = fl.length;
          fl = [...fl.slice(0, ins), ...h.N, ...fl.slice(ins)];
          if (ins === fl.length - h.N.length && h.noBreak) fin = false;
          d += h.N.length;
          continue;
        }
        const occ = tierOcc(fl, h.O);
        if (occ === null) throw new Fail('no-match', op);
        const want = h.a - 1 + d;
        let at = occ.pos[0]!;
        let bd = Math.abs(at - want);
        for (const p of occ.pos) {
          const dd = Math.abs(p - want);
          if (dd < bd) { bd = dd; at = p; }
        }
        const atEnd = at + h.O.length === oldLen + d - (0);
        const built = buildN(fl, at, h.O, h.N, h.isCtx, h.ctxOIdx, occ.tier);
        fl = [...fl.slice(0, at), ...built, ...fl.slice(at + h.O.length)];
        if (atEnd && h.noBreak) fin = false;
        d += h.N.length - h.O.length;
      }
      const out = fl.length === 0 ? '' : fl.join(br) + (fin ? br : '');
      if (move) {
        tree.now.set(op, null);
        tree.now.set(newP as string, out);
        (fn as unknown as Record<string, unknown>).__move = { old: op, nw: newP as string };
      } else {
        tree.now.set(op, out);
      }
      };
      return fn;
    })(s));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------- search-replace (SPEC section 7) ----------

function srEdits(lines: string[]): Edit[] {
  interface Block { path: string; old: string[]; nw: string[]; }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, eq), nw: lines.slice(eq + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const { br, lines: fl, fin } = splitFile(cur);
    const occ = tierOcc(fl, b.old);
    if (occ === null) throw new Fail('no-match', b.path);
    if (occ.pos.length > 1) throw new Fail('ambiguous', b.path);
    const built = buildN(fl, occ.pos[0]!, b.old, b.nw, b.nw.map(() => false), [], occ.tier);
    const out = [...fl.slice(0, occ.pos[0]!), ...built, ...fl.slice(occ.pos[0]! + b.old.length)];
    tree.now.set(b.path, out.length === 0 ? '' : out.join(br) + (fin ? br : ''));
  });
}

// ---------- V4A (SPEC section 8) ----------

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface Chunk { anchor: string | null; raw: string[]; eof: boolean; }
  interface Chunk2 { anchor: string | null; O: string[]; N: string[]; isCtx: boolean[]; ctxOIdx: number[]; eof: boolean; }
  interface Sec { kind: 'add' | 'del' | 'upd'; path: string; moveTo: string | null; addLines: string[]; chunks: Chunk2[]; }
  const secs: Sec[] = [];
  const secStart = (l: string): 'add' | 'del' | 'upd' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'del';
    if (l.startsWith('*** Update File: ')) return 'upd';
    return null;
  };
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const k = secStart(lines[i]!);
    if (k === null) throw new Exit2(`error: parse ${i + 1}`);
    const pre = k === 'add' ? '*** Add File: ' : k === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const sec: Sec = { kind: k, path: lines[i]!.slice(pre.length).trim(), moveTo: null, addLines: [], chunks: [] };
    i += 1;
    if (k === 'del') { secs.push(sec); continue; }
    if (k === 'add') {
      const arr: string[] = [];
      while (i < last && secStart(lines[i]!) === null) {
        const l = lines[i]!;
        if (l === '') { arr.push(''); i += 1; continue; }
        if (!l.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        arr.push(l.slice(1));
        i += 1;
      }
      while (arr.length > 0 && arr[arr.length - 1] === '') arr.pop();
      sec.addLines = arr;
      secs.push(sec);
      continue;
    }
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i += 1;
    }
    let ch: Chunk | null = null;
    const push = (): void => {
      if (ch !== null) {
        // Blank lines at end of section are not part of it: drop trailing
        // blank raw lines, then build O/N.
        while (ch.raw.length > 0 && blank(ch.raw[ch.raw.length - 1]!)) ch.raw.pop();
        const O: string[] = [];
        const N: string[] = [];
        const isCtx: boolean[] = [];
        const ctxOIdx: number[] = [];
        for (const bl of ch.raw) {
          if (bl === '') { O.push(''); N.push(''); isCtx.push(true); ctxOIdx.push(O.length - 1); }
          else if (bl[0] === ' ') { const t = bl.slice(1); O.push(t); N.push(t); isCtx.push(true); ctxOIdx.push(O.length - 1); }
          else if (bl[0] === '-') O.push(bl.slice(1));
          else { N.push(bl.slice(1)); isCtx.push(false); }
        }
        (ch as unknown as { O: string[]; N: string[]; isCtx: boolean[]; ctxOIdx: number[] }).O = O;
        (ch as unknown as { O: string[]; N: string[]; isCtx: boolean[]; ctxOIdx: number[] }).N = N;
        (ch as unknown as { O: string[]; N: string[]; isCtx: boolean[]; ctxOIdx: number[] }).isCtx = isCtx;
        (ch as unknown as { O: string[]; N: string[]; isCtx: boolean[]; ctxOIdx: number[] }).ctxOIdx = ctxOIdx;
        sec.chunks.push(ch as unknown as Chunk2);
        ch = null;
      }
    };
    while (i < last && secStart(lines[i]!) === null) {
      const l = lines[i]!;
      if (l.trim() === '*** End of File') {
        if (ch === null) ch = { anchor: null, raw: [], eof: true };
        else ch.eof = true;
        push();
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        push();
        ch = { anchor: l.slice(2).trim(), raw: [], eof: false };
        i += 1;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (ch === null) ch = { anchor: null, raw: [], eof: false };
        ch.raw.push(l);
        i += 1;
        continue;
      }
      if (blank(l)) { i += 1; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    push();
    secs.push(sec);
  }
  if (secs.length === 0) throw new Exit2('error: parse 1');
  return secs.map((sec) => {
    const fn = (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    if (sec.chunks.length === 0 && sec.moveTo === null) throw new Fail('no-match', sec.path);
    const { br, lines: f0, fin } = splitFile(cur);
    let fl = [...f0];
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const tiers = STRICT ? [0] : [0, 1, 2];
        let hit = -1;
        for (const t of tiers) {
          const na = normLine(ch.anchor, t);
          hit = -1;
          for (let k = cursor; k < fl.length; k += 1) {
            if (normLine(fl[k]!, t) === na) { hit = k; break; }
          }
          if (hit >= 0) break;
        }
        if (hit < 0) throw new Fail('no-match', sec.path);
        cursor = hit + 1;
      }
      if (ch.O.length === 0) {
        const ins = ch.eof ? fl.length : cursor;
        fl = [...fl.slice(0, ins), ...ch.N, ...fl.slice(ins)];
        cursor = ins + ch.N.length;
        continue;
      }
      const tiers = STRICT ? [0] : [0, 1, 2];
      let best: { tier: number; at: number } | null = null;
      for (const t of tiers) {
        const nO = ch.O.map((l) => normLine(l, t));
        let at = -1;
        for (let k = cursor; k + ch.O.length <= fl.length; k += 1) {
          let ok = true;
          for (let j = 0; j < ch.O.length; j += 1) {
            if (normLine(fl[k + j]!, t) !== nO[j]) { ok = false; break; }
          }
          if (ok) { at = k; break; }
        }
        if (at >= 0) {
          if (ch.eof && at + ch.O.length !== fl.length) continue;
          best = { tier: t, at };
          break;
        }
      }
      if (best === null) throw new Fail('no-match', sec.path);
      const built = buildN(fl, best.at, ch.O, ch.N, ch.isCtx, ch.ctxOIdx, best.tier);
      fl = [...fl.slice(0, best.at), ...built, ...fl.slice(best.at + ch.O.length)];
      cursor = best.at + built.length;
    }
    const out = fl.length === 0 ? '' : fl.join(br) + (fin ? br : '');
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      (fn as unknown as Record<string, unknown>).__move = { old: sec.path, nw: sec.moveTo };
    } else {
      tree.now.set(sec.path, out);
    }
    };
    return fn;
  });
}

// ---------- JSON (SPEC section 9) ----------

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
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')) {
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
      const fl = before === '' ? [] : before.split(br);
      if (before !== '' && before.endsWith(br)) fl.pop();
      const final = before !== '' && before.endsWith(br);
      if (line < 0 || line > fl.length) throw new Fail('no-match', p);
      fl.splice(line, 0, ...add);
      tree.now.set(p, fl.length === 0 ? '' : fl.join(br) + (final ? br : ''));
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
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- driver ----------

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
  STRICT = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = srEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // safety-first: check every path before anything else
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<{ old: string; nw: string }> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      (edit as Edit & { __move?: { old: string; nw: string } })(tree);
      const mv = (edit as Edit & { __move?: { old: string; nw: string } }).__move;
      if (mv) moves.push(mv);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // R rows for successful move edits (old existed before, gone after; new is new)
  const moveNew = new Map<string, string>(); // new -> old
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null &&
      tree.original(m.nw) === null && tree.now.get(m.nw) !== null) {
      moveNew.set(m.nw, m.old);
    }
  }
  const moveOld = new Set(moveNew.values());
  interface Row { sort: string; line: string }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveNew.has(p)) rows.push({ sort: p, line: `R ${moveNew.get(p)} -> ${p}` });
    else if (moveOld.has(p)) continue; // paired D hidden by R
    else rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  const outRows = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

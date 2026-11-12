import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from './types';

export function defaultCtx(env: Record<string, string | undefined> = process.env): Ctx {
  const home = env.SKILLDECK_HOME || os.homedir();
  const platform = process.platform;
  let dataDir = env.SKILLDECK_DATA;
  if (!dataDir) {
    if (platform === 'darwin') dataDir = path.join(home, 'Library', 'Application Support', 'SkillDeck');
    else if (platform === 'win32') dataDir = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'SkillDeck');
    else dataDir = path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'skilldeck');
  }
  return { home, platform, env, dataDir };
}

export function hashId(...parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Preserve macOS case-sensitive volumes; enumerated real paths handle native aliases. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const n = path.normalize(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? n.toLowerCase() : n;
}

export function tilde(p: string, home: string): string {
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

export function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

export function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function realSafe(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export function readText(p: string, max = 2 * 1024 * 1024): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function readJson(p: string): any | null {
  const t = readText(p, 32 * 1024 * 1024);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export interface DirSummary {
  fileCount: number;
  size: number;
  mtime: number;
  hasScripts: boolean;
}

const WALK_SKIP = new Set(['node_modules', '.git']);

/** Walks a directory without following symlinks. Stops at the given entry budget. */
export function walk(dir: string, visit: (rel: string, st: fs.Stats) => void, budget = 5000): void {
  const stack: string[] = [''];
  let seen = 0;
  while (stack.length) {
    const rel = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, rel));
    } catch {
      continue;
    }
    for (const n of names) {
      if (++seen > budget) return;
      const r = rel ? rel + '/' + n : n;
      const st = lstatSafe(path.join(dir, r));
      if (!st) continue;
      visit(r, st);
      if (st.isDirectory() && !WALK_SKIP.has(n)) stack.push(r);
    }
  }
}

export function summarize(dir: string): DirSummary {
  const s: DirSummary = { fileCount: 0, size: 0, mtime: 0, hasScripts: false };
  walk(dir, (rel, st) => {
    if (st.isDirectory()) {
      if (rel === 'scripts') s.hasScripts = true;
      return;
    }
    s.fileCount++;
    s.size += st.size;
    if (st.mtimeMs > s.mtime) s.mtime = st.mtimeMs;
  });
  return s;
}

/** Exact tree fingerprint: no summary budgets, skipped directories or size shortcuts. */
export function fingerprint(p: string): string {
  let st: fs.Stats;
  try { st = fs.lstatSync(p); } catch (e: any) { if (e.code === 'ENOENT') return 'absent'; throw e; }
  if (st.isSymbolicLink()) return 'link:' + fs.readlinkSync(p);
  const h = createHash('sha256');
  if (st.isFile()) {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      let size: number;
      while ((size = fs.readSync(fd, buf, 0, buf.length, null))) h.update(buf.subarray(0, size));
    } finally { fs.closeSync(fd); }
    return 'file:' + (st.mode & 0o777) + ':' + h.digest('hex');
  }
  if (!st.isDirectory()) throw new Error(`不支持的文件类型：${p}`);
  for (const name of fs.readdirSync(p).sort()) h.update(JSON.stringify([name, fingerprint(path.join(p, name))]));
  return 'dir:' + (st.mode & 0o777) + ':' + h.digest('hex');
}

/** Detect changes in an ancestor symlink even when the leaf has identical bytes. */
export function pathIdentity(p: string): string {
  const rows: string[] = [];
  for (let at = path.resolve(p); ; at = path.dirname(at)) {
    const st = lstatSafe(at);
    rows.push(JSON.stringify([at, st?.isSymbolicLink() ? fs.readlinkSync(at) : st ? [st.dev, st.ino] : null]));
    if (path.dirname(at) === at) break;
  }
  return rows.join('\n');
}

/** Locates an executable without running it. */
export function findBinary(ctx: Ctx, names: string[]): string | null {
  const win = ctx.platform === 'win32';
  const sep = win ? ';' : ':';
  const dirs = (ctx.env.PATH || ctx.env.Path || '').split(sep).filter(Boolean);
  const h = ctx.home;
  const extra = win
    ? [path.join(ctx.env.APPDATA || path.join(h, 'AppData', 'Roaming'), 'npm'), path.join(h, '.local', 'bin'), path.join(h, 'scoop', 'shims')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(h, '.local', 'bin'), path.join(h, '.npm-global', 'bin'), path.join(h, '.bun', 'bin'), path.join(h, 'bin'), path.join(h, '.cargo', 'bin')];
  const exts = win ? (ctx.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const d of [...dirs, ...extra]) {
    for (const n of names) {
      for (const e of exts) {
        const p = path.join(d, n + e.toLowerCase());
        const st = statSafe(p);
        if (st && st.isFile()) return p;
      }
    }
  }
  return null;
}

export function movePath(from: string, to: string): void {
  if (lstatSafe(to)) throw new Error(`目标已存在：${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e;
    try { fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }); }
    catch (copyError) { fs.rmSync(to, { recursive: true, force: true }); throw copyError; }
    try { fs.rmSync(from, { recursive: true, force: true }); }
    catch (removeError) {
      const error = new Error(`跨卷复制已完成但源移除失败；目标副本已保留：${to}；${String(removeError)}`);
      Object.assign(error, { recoveryRequired: true });
      throw error;
    }
  }
}

export function linkDir(target: string, at: string, platform: NodeJS.Platform): void {
  fs.symlinkSync(target, at, platform === 'win32' ? 'junction' : 'dir');
}

export function writeAtomic(p: string, content: string): void {
  const tmp = p + '.' + newId('tmp');
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', statSafe(p)?.mode ?? 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, p);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

/** Resolve existing ancestors even when a destination directory has not been created. */
export function realFuture(p: string): string {
  const real = realSafe(p);
  if (real) return real;
  const parent = path.dirname(p);
  return parent === p ? path.resolve(p) : path.join(realFuture(parent), path.basename(p));
}

import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, Confidence, Ctx, Detection, DiscoveryIssue, DocRef, Evidence, RootSpec, Scope } from '../types';
import type { ValidationRules } from '../frontmatter';
import { findBinary, hashId, statSafe, tilde } from '../util';

export interface ScanProject {
  path: string;
  /** Search subdirectories for nested skill roots. */
  nested: boolean;
}

export interface Probe {
  name: string;
  entryPath: string;
  skillMd: string;
  realSkillMd: string;
  root: RootSpec;
}

export interface FileEdit {
  path: string;
  content: string;
}

export interface ToggleResult {
  edits: FileEdit[];
  blockers: string[];
}

export interface Adapter {
  id: AgentId;
  name: string;
  vendor: string;
  docs: DocRef[];
  collision: 'priority' | 'duplicate' | 'undocumented';
  rules: ValidationRules;
  /** Agent walks into subfolders of a root. */
  recursive?: boolean;
  maxDepth?: number;
  /** Flat Markdown exists in this agent; directory-only operations must not silently hide it. */
  flatMarkdown?: boolean;
  /** Skill identity comes from the folder name instead of frontmatter. */
  idFromPath?: boolean;
  toggleRule: string;
  detect(ctx: Ctx): { detection: Detection; evidence: Evidence[] };
  roots(ctx: Ctx, projects: ScanProject[]): RootSpec[];
  /** Additional sources fail independently and return provenance plus diagnostics. */
  discover?(ctx: Ctx, projects: ScanProject[]): DiscoveryResult;
  /** Returns a checker that reports official disable switches. */
  disableState?(ctx: Ctx): (p: Probe) => Evidence | null;
  toggle?(ctx: Ctx, p: Probe, enable: boolean): ToggleResult;
  tags?(skillDir: string, frontmatter: Record<string, unknown> | null): string[];
}

export function detectBy(ctx: Ctx, opt: { bins?: string[]; dirs?: string[]; apps?: string[] }): { detection: Detection; evidence: Evidence[] } {
  const evidence: Evidence[] = [];
  let detection: Detection = 'absent';
  const bin = opt.bins?.length ? findBinary(ctx, opt.bins) : null;
  if (bin) {
    detection = 'installed';
    evidence.push({ ok: true, text: '可执行文件', path: bin });
  }
  for (const a of opt.apps || []) {
    if (statSafe(a)) {
      detection = 'installed';
      evidence.push({ ok: true, text: '应用程序', path: a });
    }
  }
  for (const d of opt.dirs || []) {
    if (statSafe(d)) {
      if (detection === 'absent') detection = 'traces';
      evidence.push({ ok: true, text: '配置目录', path: d });
    }
  }
  if (detection === 'absent') evidence.push({ ok: false, text: '未找到可执行文件、应用或配置目录' });
  return { detection, evidence };
}

export function appPaths(ctx: Ctx, mac: string[], win: string[], linux: string[] = []): string[] {
  if (ctx.platform === 'darwin') return mac.flatMap((n) => [`/Applications/${n}.app`, path.join(ctx.home, 'Applications', `${n}.app`)]);
  if (ctx.platform === 'win32') {
    const local = ctx.env.LOCALAPPDATA || path.join(ctx.home, 'AppData', 'Local');
    return win.map((n) => path.join(local, 'Programs', n));
  }
  return linux;
}

export interface DiscoveryResult {
  roots: RootSpec[];
  issues: DiscoveryIssue[];
}

export interface RootInit extends Pick<RootSpec, 'singleSkill' | 'discoveryId' | 'sourceKind' | 'evidence' | 'loadState'> {
  scope: Scope;
  dir: string;
  rule: string;
  source: DocRef;
  confidence?: Confidence;
  priority: number;
  project?: string;
  readOnly?: boolean;
  namespace?: string;
  lazy?: boolean;
  ignore?: string[];
  pluginId?: string;
}

export function root(agent: AgentId, r: RootInit): RootSpec {
  return { confidence: 'documented', ...r, id: hashId(agent, path.normalize(r.dir), ...(r.discoveryId ? [r.discoveryId] : [])), agent, dir: path.normalize(r.dir) };
}

export function rel(ctx: Ctx, p: string): string {
  return tilde(p, ctx.home);
}

const NESTED_SKIP = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'out', 'Library', 'venv', '__pycache__']);
const nestedCache = new Map<string, { at: number; dirs: string[] }>();

/** Subdirectories (excluding the project root itself) that hold `<marker>/skills`. */
export function clearNestedCache(): void { nestedCache.clear(); }

export function nestedRoots(project: string, markers: string[]): string[] {
  const key = project + '|' + markers.join(',');
  const hit = nestedCache.get(key);
  if (hit && Date.now() - hit.at < 1500) return hit.dirs;
  const found: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: project, depth: 0 }];
  let budget = 3000;
  while (queue.length && budget > 0) {
    const { dir, depth } = queue.shift()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      budget--;
      const full = path.join(dir, e.name);
      if (markers.includes(e.name)) {
        if (depth > 0 && statSafe(path.join(full, 'skills'))?.isDirectory()) found.push(path.join(full, 'skills'));
        continue;
      }
      if (e.name.startsWith('.') || NESTED_SKIP.has(e.name) || depth >= 4) continue;
      queue.push({ dir: full, depth: depth + 1 });
    }
  }
  nestedCache.set(key, { at: Date.now(), dirs: found });
  return found;
}

export function editJson(file: string, mutate: (obj: any) => void): { content: string } | { error: string } {
  let obj: any = {};
  let indent: string | number = 2;
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    try {
      obj = text.trim() ? JSON.parse(text) : {};
    } catch {
      return { error: `无法解析 ${file}（非严格 JSON），已停止修改` };
    }
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return { error: `${file} 顶层不是对象` };
    const m = /^([ \t]+)"/m.exec(text);
    if (m) indent = m[1];
  }
  mutate(obj);
  return { content: JSON.stringify(obj, null, indent) + '\n' };
}

/** Known launch directories plus ancestors through the nearest Git root; never walk above it. */
export function projectChain(projects: ScanProject[]): ScanProject[] {
  const out = new Map<string, ScanProject>();
  for (const project of projects) {
    let at = path.resolve(project.path);
    const chain = [at];
    while (!statSafe(path.join(at, '.git')) && path.dirname(at) !== at) {
      at = path.dirname(at);
      chain.push(at);
    }
    // Outside a Git repository there is no established repository boundary.
    const dirs = statSafe(path.join(at, '.git')) ? chain : [project.path];
    for (const dir of dirs) out.set(dir, { path: dir, nested: dir === project.path && project.nested });
  }
  return [...out.values()];
}

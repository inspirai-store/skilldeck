import path from 'node:path';
import type { Ctx } from '../types';
import { root, type DiscoveryResult, type ScanProject } from '../adapters/base';
import { lstatSafe, pathKey } from '../util';
import { jsonObject, problem } from './shared';

export const OPENCODE_SOURCES_DOC = { title: 'OpenCode · Skill sources', url: 'https://opencode.ai/docs/skills/' };
const CONFIG_DOC = { title: 'OpenCode · Config locations', url: 'https://opencode.ai/docs/config/' };

export function opencodeSystemDirectory(ctx: Ctx): string {
  if (ctx.platform === 'darwin') return '/Library/Application Support/opencode';
  if (ctx.platform === 'win32') return path.join(ctx.env.ProgramData || 'C:\\ProgramData', 'opencode');
  return '/etc/opencode';
}

/** Config locations extend to filesystem root. Skill paths resolve from each known launch directory. */
export function discoverOpenCodeSources(ctx: Ctx, projects: ScanProject[], systemDir = opencodeSystemDirectory(ctx)): DiscoveryResult {
  const result: DiscoveryResult = { roots: [], issues: [] };
  const globalDir = path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config'), 'opencode');
  const filesAt = (dir: string) => ['opencode.json', 'opencode.jsonc'].map((n) => path.join(dir, n));
  const cache = new Map<string, Record<string, any> | null>();
  const load = (file: string) => {
    if (cache.has(file)) return cache.get(file);
    if (!lstatSafe(file)) { cache.set(file, null); return null; }
    try { const config = jsonObject(file, file.endsWith('.jsonc')); cache.set(file, config); return config; }
    catch { problem(result.issues, 'opencode', 'opencode-config-invalid', '配置无法解析，已跳过此文件；未使用容错解析出的部分配置', file, CONFIG_DOC); cache.set(file, null); return null; }
  };
  const seen = new Set<string>();
  const launchDirectories = [...new Set(projects.map((p) => p.path))];
  if (launchDirectories.length > 256) problem(result.issues, 'opencode', 'opencode-context-budget', '启动目录超过 256，只检查前 256 个上下文', globalDir, CONFIG_DOC);
  const contexts: (string | undefined)[] = [undefined, ...launchDirectories.slice(0, 256)];
  contexts: for (const cwd of contexts) {
    const ancestors: string[] = [];
    if (cwd) {
      for (let at = path.resolve(cwd); ; at = path.dirname(at)) {
        ancestors.unshift(at);
        if (path.dirname(at) === at) break;
      }
    }
    // Every discovered file contributes skill entries. Do not pick one JSON/JSONC file silently.
    const files = [...filesAt(globalDir), ...ancestors.flatMap(filesAt), ...ancestors.flatMap((p) => filesAt(path.join(p, '.opencode'))), ...filesAt(systemDir)];
    let order = 0;
    for (const file of [...new Set(files)]) {
      const cfg = load(file);
      if (!cfg || cfg.skills == null) continue;
      if (!Array.isArray(cfg.skills)) {
        const key = file + '|shape';
        if (!seen.has(key)) problem(result.issues, 'opencode', 'opencode-skills-shape', '当前规范要求 skills 为数组；未猜测其他版本的 paths/urls 对象格式', file, OPENCODE_SOURCES_DOC);
        seen.add(key); continue;
      }
      if (cfg.skills.length > 1024) {
        const key = file + '|budget';
        if (!seen.has(key)) problem(result.issues, 'opencode', 'opencode-source-budget', 'skills 来源超过 1024，只检查前 1024 项', file, OPENCODE_SOURCES_DOC);
        seen.add(key);
      }
      for (const [index, entry] of cfg.skills.slice(0, 1024).entries()) {
        order++;
        const base = `${file}:${index}`;
        const diagnostic = (code: string, text: string) => {
          const key = `${base}|${code}`;
          if (!seen.has(key)) problem(result.issues, 'opencode', code, text, file, OPENCODE_SOURCES_DOC);
          seen.add(key);
        };
        if (typeof entry !== 'string' || !entry.trim() || entry.includes('\0')) { diagnostic('opencode-source-invalid', 'Skill 来源必须为非空路径字符串'); continue; }
        if (/^https?:\/\//i.test(entry)) { diagnostic('remote-catalog-not-fetched', '发现远程 Skill catalog；仅读取本地配置，不联网下载或执行'); continue; }
        if (entry.includes('{env:') || entry.includes('{file:') || entry.startsWith('~') && !entry.startsWith('~/')) { diagnostic('opencode-source-unresolved', '来源含未解析变量、文件替换或不支持的 home 表达式，未猜测路径'); continue; }
        const absolute = path.isAbsolute(entry) || entry.startsWith('~/');
        if (!absolute && !cwd) {
          // A global/system relative path requires a launch context; no assumed home CWD.
          if (!projects.length) diagnostic('opencode-cwd-required', '相对 Skill 路径需要已登记的启动目录，当前无法解析');
          continue;
        }
        // Project-config absolute paths also belong to that project. Global absolute paths are shared.
        const shared = filesAt(globalDir).includes(file) || filesAt(systemDir).includes(file);
        if (absolute && shared && cwd) continue;
        if (!cwd && !shared) continue;
        const dir = entry.startsWith('~/') ? path.resolve(ctx.home, entry.slice(2)) : path.resolve(cwd || ctx.home, entry);
        const project = absolute && shared ? undefined : cwd;
        const key = `${base}|${project || ''}|${pathKey(dir)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (result.roots.length >= 4096) { problem(result.issues, 'opencode', 'opencode-root-budget', '额外扫描根超过 4096，发现已截断', file, OPENCODE_SOURCES_DOC); break contexts; }
        result.roots.push(root('opencode', { scope: project ? 'project' : 'user', project, dir, priority: 1000 + order,
          readOnly: true, source: OPENCODE_SOURCES_DOC, sourceKind: 'agent-config', discoveryId: key,
          loadState: 'unknown', rule: 'OpenCode 配置 skills[] 的本地目录；相对路径从已知启动目录解析，非配置所在目录',
          evidence: [{ ok: null, text: `skills[${index}] 本地来源声明；尚未核实运行时配置版本、权限及最终注册顺序`, path: file, url: CONFIG_DOC.url },
            ...(cwd ? [{ ok: null, text: '用于解析相对路径的已登记启动目录', path: cwd }] : [])] }));
      }
    }
  }
  result.roots.push(root('opencode', { scope: 'admin', dir: path.join(systemDir, 'skills'), priority: 500,
    readOnly: true, source: CONFIG_DOC, rule: 'OpenCode 系统配置目录中的 skills，托管来源只读', sourceKind: 'agent-config',
    discoveryId: 'system-skills', loadState: 'unknown' }));
  return result;
}

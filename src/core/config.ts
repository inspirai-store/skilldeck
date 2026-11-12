import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AppConfig, Ctx, ProjectInfo } from './types';
import { claudeConfigDir } from './adapters/claude';
import { codexHome } from './adapters/codex';
import { lstatSafe, pathKey, readJson, readText, statSafe, writeAtomic } from './util';

const file = (ctx: Ctx) => path.join(ctx.dataDir, 'config.json');

export function loadConfig(ctx: Ctx): AppConfig {
  const loaded = readJson(file(ctx));
  if (lstatSafe(file(ctx)) && (!loaded || typeof loaded !== 'object' || Array.isArray(loaded))) throw new Error('SkillDeck config.json 损坏，禁止覆盖');
  const c = loaded || {};
  for (const key of ['projects', 'hiddenProjects']) if (c[key] !== undefined && (!Array.isArray(c[key]) || c[key].some((p: unknown) => typeof p !== 'string'))) throw new Error(`配置字段无效：${key}`);
  if (c.scanDirectories !== undefined && (!Array.isArray(c.scanDirectories) || c.scanDirectories.length > 256 || c.scanDirectories.some((r: any) => !r || typeof r.id !== 'string' || !r.id || typeof r.agent !== 'string' || !r.agent || typeof r.path !== 'string' || !path.isAbsolute(r.path) || r.path.includes('\0') || typeof r.readOnly !== 'boolean' || (r.layout !== undefined && !['collection', 'skill'].includes(r.layout))))) throw new Error('配置字段无效：scanDirectories');
  if (new Set((c.scanDirectories || []).map((r: any) => r.id)).size !== (c.scanDirectories || []).length) throw new Error('scanDirectories 包含重复 id');
  return { ...c, projects: Array.isArray(c.projects) ? c.projects : [], hiddenProjects: Array.isArray(c.hiddenProjects) ? c.hiddenProjects : [], scanDirectories: c.scanDirectories || [] };
}

export function saveConfig(ctx: Ctx, c: AppConfig): void {
  if (lstatSafe(file(ctx))?.isSymbolicLink()) throw new Error('config.json 本身为符号链接，禁止静默替换');
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  if (lstatSafe(file(ctx))) {
    const dir = path.join(ctx.dataDir, 'config-backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(file(ctx), path.join(dir, `config-${Date.now()}-${Math.random().toString(36).slice(2)}.json`), fs.constants.COPYFILE_EXCL);
  }
  writeAtomic(file(ctx), JSON.stringify(c, null, 2) + '\n');
}

/** Manual projects plus project paths the agents themselves have recorded. Only path keys are read. */
export function listProjects(ctx: Ctx, cfg: AppConfig): ProjectInfo[] {
  const seen = new Set<string>([pathKey(ctx.home)]);
  const hidden = new Set(cfg.hiddenProjects.map((p) => pathKey(p)));
  const out: ProjectInfo[] = [];
  const add = (p: unknown, origin: ProjectInfo['origin']) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return;
    const k = pathKey(p);
    if (seen.has(k) || (origin !== 'manual' && hidden.has(k))) return;
    seen.add(k);
    out.push({ path: path.normalize(p), origin, exists: !!statSafe(p)?.isDirectory() });
  };
  cfg.projects.forEach((p) => add(p, 'manual'));
  const cj = readJson(path.join(ctx.env.CLAUDE_CONFIG_DIR || ctx.home, '.claude.json')) || readJson(path.join(claudeConfigDir(ctx), '.claude.json'));
  Object.keys(cj?.projects || {}).forEach((p) => add(p, 'claude'));
  const toml = readText(path.join(codexHome(ctx), 'config.toml'));
  if (toml) {
    try {
      Object.keys((parseToml(toml) as any)?.projects || {}).forEach((p) => add(p, 'codex'));
    } catch {}
  }
  return out;
}

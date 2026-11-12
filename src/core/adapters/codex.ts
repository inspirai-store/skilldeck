import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import YAML from 'yaml';
import { discoverCodexPlugins } from '../discovery/codex-plugins';
import type { Ctx, Evidence, RootSpec } from '../types';
import { SPEC_FIELDS } from '../frontmatter';
import { pathKey, readText, realSafe } from '../util';
import { type Adapter, type Probe, appPaths, detectBy, rel, root, projectChain } from './base';

const DOC = { title: 'Codex · Agent Skills', url: 'https://developers.openai.com/codex/skills' };
const DOC_CFG = { title: 'Codex · Config reference', url: 'https://developers.openai.com/codex/config-reference' };

export function codexHome(ctx: Ctx): string {
  return ctx.env.CODEX_HOME || path.join(ctx.home, '.codex');
}

interface SkillRule {
  path?: string;
  name?: string;
  enabled?: boolean;
}

function readRules(file: string): { rules: SkillRule[]; error?: string } {
  const text = readText(file);
  if (text == null) return { rules: [] };
  try {
    const cfg: any = parseToml(text);
    const list = cfg?.skills?.config;
    if (list != null && (!Array.isArray(list) || list.some((r: any) => !r || typeof r !== 'object' || (typeof r.path === 'string') === (typeof r.name === 'string') || typeof r.enabled !== 'boolean'))) return { rules: [], error: 'skills.config 条目必须包含一个 path 或 name 选择器及 enabled 布尔值' };
    return { rules: Array.isArray(list) ? list : [] };
  } catch (e: any) {
    return { rules: [], error: String(e.message || e).split('\n')[0] };
  }
}

function matches(r: SkillRule, p: Probe): boolean {
  if (typeof r.name === 'string') return r.name === p.name;
  if (typeof r.path !== 'string') return false;
  const want = new Set([pathKey(p.skillMd), pathKey(p.realSkillMd), ]);
  return want.has(pathKey(r.path)) || want.has(pathKey(realSafe(r.path) || r.path));
}

function lastMatch(rules: SkillRule[], p: Probe): SkillRule | undefined {
  return [...rules].reverse().find((r) => matches(r, p));
}

/** Identify real TOML headers, ignoring examples inside multiline strings. */
function headerLines(lines: string[]): Set<number> {
  const headers = new Set<number>();
  let multiline: string | null = null;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (!multiline && /^\s*\[/.test(line)) headers.add(row);
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (multiline === '"""' && line[i] === '\\') { i++; continue; }
        if (line.slice(i, i + 3) === multiline) { multiline = null; i += 2; }
        continue;
      }
      if (quote) {
        if (quote === '"' && line[i] === '\\') { i++; continue; }
        if (line[i] === quote) quote = null;
        continue;
      }
      if (line[i] === '#') break;
      if (line[i] === '"' || line[i] === "'") {
        if (line.slice(i, i + 3) === line[i].repeat(3)) { multiline = line.slice(i, i + 3); i += 2; }
        else quote = line[i];
      }
    }
  }
  return headers;
}

/** Removes `[[skills.config]]` blocks that disable the probed skill, keeping every other byte. */
export function removeDisableBlocks(text: string, p: Probe): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const headers = headerLines(lines);
  let i = 0;
  while (i < lines.length) {
    if (headers.has(i) && /^\s*\[\[\s*skills\.config\s*\]\]\s*(#.*)?$/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !headers.has(j)) j++;
      const block = lines.slice(i, j).join('\n');
      let rule: SkillRule | undefined;
      try {
        rule = (parseToml(block) as any)?.skills?.config?.[0];
      } catch {}
      if (rule && rule.enabled === false && matches(rule, p)) {
        while (out.length && out[out.length - 1].trim() === '' && (out.length < 2 || out[out.length - 2].trim() === '')) out.pop();
        i = j;
        continue;
      }
    }
    out.push(lines[i++]);
  }
  return out.join('\n');
}

export const codex: Adapter = {
  id: 'codex',
  name: 'Codex',
  vendor: 'OpenAI',
  docs: [DOC, DOC_CFG],
  collision: 'duplicate',
  recursive: true,
  rules: { requires: ['name', 'description'], strictLimits: true, yamlErrorFatal: true, knownFields: SPEC_FIELDS },
  discover: discoverCodexPlugins,
  toggleRule: 'config.toml · [[skills.config]] path = "…/SKILL.md", enabled = false',

  detect(ctx) {
    return detectBy(ctx, { bins: ['codex'], dirs: [codexHome(ctx)], apps: appPaths(ctx, ['Codex'], ['codex']) });
  },

  roots(ctx, projects) {
    const home = codexHome(ctx);
    const out: RootSpec[] = [
      root('codex', {
        scope: 'user',
        dir: path.join(ctx.home, '.agents', 'skills'),
        rule: 'USER 范围 $HOME/.agents/skills',
        source: DOC,
        priority: 300,
      }),
      root('codex', {
        scope: 'user',
        dir: path.join(home, 'skills'),
        rule: `$CODEX_HOME/skills（${rel(ctx, path.join(home, 'skills'))}），Codex 内置 skill-installer 的安装位置，公开文档未列出`,
        source: DOC,
        confidence: 'vendor',
        priority: 290,
        ignore: ['.system'],
      }),
      root('codex', {
        scope: 'system',
        dir: path.join(home, 'skills', '.system'),
        rule: 'SYSTEM 范围：随 Codex 分发的内置 Skills',
        source: DOC,
        priority: 100,
        readOnly: true,
      }),
    ];
    if (ctx.platform !== 'win32') {
      out.push(root('codex', { scope: 'admin', dir: '/etc/codex/skills', rule: 'ADMIN 范围 /etc/codex/skills', source: DOC, priority: 200, readOnly: true }));
    }
    for (const p of projectChain(projects)) {
      out.push(
        root('codex', {
          scope: 'project',
          project: p.path,
          dir: path.join(p.path, '.agents', 'skills'),
          rule: 'REPO 范围 .agents/skills（从启动目录向上到仓库根逐级扫描）',
          source: DOC,
          priority: 400,
        }),
        root('codex', {
          scope: 'project',
          project: p.path,
          dir: path.join(p.path, '.codex', 'skills'),
          rule: '项目 .codex/skills，公开文档未列出',
          source: DOC,
          confidence: 'observed',
          priority: 390,
        }),
      );
    }
    return out;
  },

  disableState(ctx) {
    const file = path.join(codexHome(ctx), 'config.toml');
    const { rules, error } = readRules(file);
    return (p: Probe): Evidence | null => {
      if (error) return { ok: null, text: `config.toml 无法解析：${error}`, path: file };
      const hit = lastMatch(rules, p);
      if (hit && hit.enabled === false) {
        return { ok: false, text: `[[skills.config]] ${hit.name ? `name = "${hit.name}"` : `path = "${hit.path}"`}, enabled = false`, path: file };
      }
      return null;
    };
  },

  toggle(ctx, p, enable) {
    const file = path.join(codexHome(ctx), 'config.toml');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const checked = readRules(file);
    if (checked.error) return { edits: [], blockers: [`无法解析 ${file}：${checked.error}`] };
    let cfg: any;
    try {
      cfg = parseToml(text);
    } catch (e: any) {
      return { edits: [], blockers: [`无法解析 ${file}：${String(e.message || e).split('\n')[0]}`] };
    }
    if (cfg?.skills?.config != null && !Array.isArray(cfg.skills.config)) return { edits: [], blockers: [`${file} 中 skills.config 不是表数组`] };
    const currentlyDisabled = lastMatch(checked.rules, p)?.enabled === false;
    if (currentlyDisabled !== enable) return { edits: [], blockers: [] };
    // Last matching selector wins. Append a path-specific override rather than
    // deleting name-wide rules or rewriting unrelated TOML/comments.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const block = ['[[skills.config]]', `path = ${JSON.stringify(p.realSkillMd)}`, `enabled = ${enable}`].join(eol);
    const next = (text.trimEnd() ? text.trimEnd() + eol + eol : '') + block + eol;
    try {
      const hit = lastMatch(readRulesFromText(next), p);
      const disabled = !!hit && hit.enabled === false;
      if (disabled === enable) {
        return { edits: [], blockers: [enable ? `${file} 中仍有规则禁用该 Skill（可能为内联表或按名称匹配的多条规则），请手动处理` : '写入后规则未生效'] };
      }
    } catch (e: any) {
      return { edits: [], blockers: [`修改后的 config.toml 无法通过解析校验：${String(e.message || e).split('\n')[0]}`] };
    }
    return { edits: next === text ? [] : [{ path: file, content: next }], blockers: [] };
  },

  tags(dir) {
    const y = readText(path.join(dir, 'agents', 'openai.yaml'), 256 * 1024);
    if (!y) return [];
    try {
      const d = YAML.parse(y);
      return d?.policy?.allow_implicit_invocation === false ? ['仅显式调用'] : [];
    } catch {
      return [];
    }
  },
};

function readRulesFromText(text: string): SkillRule[] {
  const list = (parseToml(text) as any)?.skills?.config;
  return Array.isArray(list) ? list : [];
}

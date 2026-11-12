import path from 'node:path';
import { discoverGeminiExtensions } from '../discovery/gemini-extensions';
import { discoverOpenCodeSources } from '../discovery/opencode-sources';
import type { Ctx, DocRef, Evidence, RootSpec } from '../types';
import { SPEC_FIELDS } from '../frontmatter';
import { lstatSafe, readJson } from '../util';
import { type Adapter, type FileEdit, type Probe, type RootInit, type ScanProject, appPaths, detectBy, editJson, nestedRoots, root, projectChain } from './base';

type Layout = (Omit<RootInit, 'dir' | 'source' | 'project' | 'scope'> & { at: string })[];

/** Expands user and per-project directory lists into root specs. */
function layout(agent: string, ctx: Ctx, projects: ScanProject[], source: DocRef, user: Layout, project: Layout): RootSpec[] {
  const out: RootSpec[] = [];
  for (const { at, ...r } of user) out.push(root(agent, { ...r, scope: 'user', source, dir: path.isAbsolute(at) ? at : path.join(ctx.home, at) }));
  for (const p of projectChain(projects)) {
    for (const { at, ...r } of project) out.push(root(agent, { ...r, scope: 'project', project: p.path, source, dir: path.join(p.path, at) }));
  }
  return out;
}

const spec = { requires: ['name', 'description'] as ('name' | 'description')[], strictLimits: false, yamlErrorFatal: true, knownFields: SPEC_FIELDS };
const MARKER_RULE = '无官方开关 · 将 SKILL.md 重命名为 SKILL.md.disabled';

const GEMINI_DOC = { title: 'Gemini CLI · Agent Skills', url: 'https://geminicli.com/docs/cli/skills/' };

function geminiSettings(ctx: Ctx, project?: string): string {
  return path.join(project || ctx.home, '.gemini', 'settings.json');
}

export const gemini: Adapter = {
  discover: discoverGeminiExtensions,
  id: 'gemini',
  name: 'Gemini CLI',
  vendor: 'Google',
  docs: [GEMINI_DOC],
  collision: 'priority',
  rules: spec,
  toggleRule: 'settings.json · skills.disabled（/skills disable <name> 写入）',
  detect: (ctx) => detectBy(ctx, { bins: ['gemini'], dirs: [path.join(ctx.home, '.gemini', 'settings.json')] }),
  roots: (ctx, projects) =>
    layout(
      'gemini',
      ctx,
      projects,
      GEMINI_DOC,
      [
        { at: '.gemini/skills', rule: '用户级 ~/.gemini/skills', priority: 200 },
        { at: '.agents/skills', rule: '用户级别名 ~/.agents/skills，同层优先于 .gemini/skills', priority: 210 },
      ],
      [
        { at: '.gemini/skills', rule: '工作区 .gemini/skills，优先于用户级', priority: 300 },
        { at: '.agents/skills', rule: '工作区别名 .agents/skills，同层优先于 .gemini/skills', priority: 310 },
      ],
    ),
  disableState(ctx) {
    return (p: Probe): Evidence | null => {
      const files = [...new Set([geminiSettings(ctx), geminiSettings(ctx, p.root.project)])];
      let enabled: boolean | undefined;
      for (const f of files) {
        const cfg = readJson(f);
        if (lstatSafe(f) && cfg == null) return { ok: null, text: '配置无法解析，无法判断开关', path: f };
        if (typeof cfg?.skills?.enabled === 'boolean') enabled = cfg.skills.enabled;
      }
      if (enabled === false) return { ok: false, text: 'skills.enabled = false，全局 Skills 功能关闭' };
      for (const f of files) {
        const cfg = readJson(f);
        if (lstatSafe(f) && cfg == null) return { ok: null, text: '配置无法解析，无法判断开关', path: f };
        const list = cfg?.skills?.disabled;
        if (Array.isArray(list) && list.includes(p.name)) return { ok: false, text: `skills.disabled 包含 "${p.name}"`, path: f };
      }
      return null;
    };
  },
  toggle(ctx, p, enable) {
    const edits: FileEdit[] = [];
    const blockers: string[] = [];
    const files = enable ? [...new Set([geminiSettings(ctx, p.root.project), geminiSettings(ctx)])] : [geminiSettings(ctx, p.root.project)];
    for (const f of files) {
      const cfg = readJson(f);
      if (lstatSafe(f) && cfg == null) { blockers.push(`无法解析 ${f}`); continue; }
      if (cfg?.skills != null && (typeof cfg.skills !== 'object' || Array.isArray(cfg.skills))) { blockers.push(`skills 配置不是对象：${f}`); continue; }
      if (enable && cfg?.skills?.enabled === false) { blockers.push(`Skills 功能关闭，需单独处理：${f}`); continue; }
      const cur = cfg?.skills?.disabled;
      if (cur != null && !Array.isArray(cur)) { blockers.push(`skills.disabled 不是数组：${f}`); continue; }
      if (enable && !(Array.isArray(cur) && cur.includes(p.name))) continue;
      const r = editJson(f, (o) => {
        const list: string[] = Array.isArray(o.skills?.disabled) ? o.skills.disabled : [];
        o.skills = { ...(o.skills || {}), disabled: enable ? list.filter((n) => n !== p.name) : [...new Set([...list, p.name])] };
      });
      if ('error' in r) blockers.push(r.error);
      else edits.push({ path: f, content: r.content });
    }
    return { edits, blockers };
  },
};

const OPENCODE_DOC = { title: 'OpenCode · Agent Skills', url: 'https://opencode.ai/docs/skills/' };

export const opencode: Adapter = {
  recursive: true,
  maxDepth: 6,
  flatMarkdown: true,
  discover: discoverOpenCodeSources,
  id: 'opencode',
  name: 'OpenCode',
  vendor: 'SST',
  docs: [OPENCODE_DOC],
  collision: 'priority',
  idFromPath: true,
  rules: { ...spec, requires: [], knownFields: [...SPEC_FIELDS, 'disable-model-invocation'] },
  toggleRule: MARKER_RULE,
  detect: (ctx) => detectBy(ctx, { bins: ['opencode'], dirs: [path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config'), 'opencode')] }),
  roots: (ctx, projects) =>
    layout(
      'opencode',
      ctx,
      projects,
      OPENCODE_DOC,
      [
        { at: '.claude/skills', rule: '兼容目录 ~/.claude/skills，优先级最低', priority: 100 },
        { at: '.agents/skills', rule: '兼容目录 ~/.agents/skills', priority: 200 },
        { at: path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, '.config'), 'opencode', 'skills'), rule: '全局 ~/.config/opencode/skills，优先于兼容目录', priority: 300 },
      ],
      [
        { at: '.claude/skills', rule: '项目兼容目录 .claude/skills', priority: 110 },
        { at: '.agents/skills', rule: '项目兼容目录 .agents/skills', priority: 210 },
        { at: '.opencode/skills', rule: '项目 .opencode/skills，后注册者覆盖同 ID', priority: 400 },
      ],
    ),
  tags: (_d, fm) => (fm?.['disable-model-invocation'] === true || (fm?.metadata as any)?.['opencode/autoinvoke'] === false ? ['仅手动调用'] : []),
};

const CURSOR_DOC = { title: 'Cursor · Agent Skills', url: 'https://cursor.com/docs/context/skills' };

export const cursor: Adapter = {
  recursive: true,
  idFromPath: true,
  id: 'cursor',
  name: 'Cursor',
  vendor: 'Anysphere',
  docs: [CURSOR_DOC],
  collision: 'undocumented',
  rules: { ...spec, knownFields: ['name', 'description', 'paths', 'globs', 'disable-model-invocation', 'icon', 'color', 'metadata', 'license', 'compatibility'] },
  toggleRule: MARKER_RULE,
  detect: (ctx) => detectBy(ctx, { bins: ['cursor', 'cursor-agent'], dirs: [path.join(ctx.home, '.cursor')], apps: appPaths(ctx, ['Cursor'], ['cursor'], ['/opt/Cursor', '/usr/share/cursor']) }),
  roots(ctx, projects) {
    const out = layout(
      'cursor',
      ctx,
      projects,
      CURSOR_DOC,
      [
        { at: '.agents/skills', rule: '用户级 ~/.agents/skills', priority: 200 },
        { at: '.cursor/skills', rule: '用户级 ~/.cursor/skills', priority: 200 },
        { at: '.claude/skills', rule: '兼容目录 ~/.claude/skills', priority: 200 },
        { at: '.codex/skills', rule: '兼容目录 ~/.codex/skills', priority: 200, ignore: ['.system'] },
        { at: '.cursor/skills-cursor', rule: 'Cursor 托管的内置 Skills（含 .sync-manifest.json），公开文档未列出', priority: 100, confidence: 'observed', readOnly: true },
      ],
      [
        { at: '.agents/skills', rule: '项目级 .agents/skills', priority: 300 },
        { at: '.cursor/skills', rule: '项目级 .cursor/skills', priority: 300 },
        { at: '.claude/skills', rule: '项目兼容目录 .claude/skills', priority: 300 },
        { at: '.codex/skills', rule: '项目兼容目录 .codex/skills', priority: 300 },
      ],
    );
    for (const r of out) if (r.dir.endsWith('skills-cursor')) r.scope = 'system';
    for (const p of projects) {
      if (!p.nested) continue;
      for (const d of nestedRoots(p.path, ['.cursor', '.agents'])) {
        out.push(root('cursor', { scope: 'project', project: path.dirname(path.dirname(d)), dir: d, rule: '仓库内嵌套的 .cursor/skills 或 .agents/skills 也会被发现', source: CURSOR_DOC, priority: 300 }));
      }
    }
    return out;
  },
  tags: (_d, fm) => (fm?.['disable-model-invocation'] === true ? ['仅手动调用'] : []),
};

const COPILOT_DOC = { title: 'GitHub Copilot · Agent Skills', url: 'https://docs.github.com/en/copilot/concepts/agents/about-agent-skills' };

export const copilot: Adapter = {
  id: 'copilot',
  name: 'GitHub Copilot',
  vendor: 'GitHub',
  docs: [COPILOT_DOC],
  collision: 'undocumented',
  rules: spec,
  toggleRule: MARKER_RULE,
  detect: (ctx) => detectBy(ctx, { bins: ['copilot'], dirs: [path.join(ctx.home, '.copilot')] }),
  roots: (ctx, projects) =>
    layout(
      'copilot',
      ctx,
      projects,
      COPILOT_DOC,
      [
        { at: '.copilot/skills', rule: '个人级 ~/.copilot/skills', priority: 200 },
        { at: '.agents/skills', rule: '个人级 ~/.agents/skills', priority: 200 },
      ],
      [
        { at: '.github/skills', rule: '项目级 .github/skills', priority: 300 },
        { at: '.claude/skills', rule: '项目级 .claude/skills', priority: 300 },
        { at: '.agents/skills', rule: '项目级 .agents/skills', priority: 300 },
      ],
    ),
};

const KIRO_DOC = { title: 'Kiro · Agent Skills', url: 'https://kiro.dev/docs/skills/' };

export const kiro: Adapter = {
  id: 'kiro',
  name: 'Kiro',
  vendor: 'AWS',
  docs: [KIRO_DOC],
  collision: 'priority',
  rules: spec,
  toggleRule: MARKER_RULE,
  detect: (ctx) => detectBy(ctx, { bins: ['kiro', 'kiro-cli'], dirs: [path.join(ctx.home, '.kiro')], apps: appPaths(ctx, ['Kiro'], ['Kiro']) }),
  roots: (ctx, projects) =>
    layout('kiro', ctx, projects, KIRO_DOC, [{ at: '.kiro/skills', rule: '全局 ~/.kiro/skills', priority: 200 }], [{ at: '.kiro/skills', rule: '工作区 .kiro/skills，同名时覆盖全局', priority: 300 }]),
};

export const codebuddy: Adapter = {
  recursive: true,
  id: 'codebuddy',
  name: 'CodeBuddy',
  vendor: 'Tencent',
  docs: [{ title: 'CodeBuddy Code · Skills', url: 'https://www.codebuddy.ai/docs/cli/skills' }],
  collision: 'priority',
  rules: { ...spec, knownFields: [...SPEC_FIELDS, 'disable-model-invocation', 'user-invocable', 'context', 'agent', 'model'] },
  toggleRule: MARKER_RULE,
  detect: (ctx) => detectBy(ctx, { bins: ['codebuddy', 'cbc'], dirs: [path.join(ctx.home, '.codebuddy')], apps: appPaths(ctx, ['CodeBuddy'], ['CodeBuddy']) }),
  roots: (ctx, projects) =>
    layout(
      'codebuddy',
      ctx,
      projects,
      { title: 'CodeBuddy Skills', url: 'https://www.codebuddy.ai/docs/cli/skills' },
      [{ at: '.codebuddy/skills', rule: '用户 ~/.codebuddy/skills', priority: 200 }],
      [{ at: '.codebuddy/skills', rule: '项目 .codebuddy/skills，优先于用户', priority: 300 }],
    ),
};

const ANTIGRAVITY_DOC = { title: 'Antigravity Skills', url: 'https://antigravity.google/docs/skills' };

export const antigravity: Adapter = {
  id: 'antigravity',
  name: 'Antigravity',
  vendor: 'Google',
  docs: [ANTIGRAVITY_DOC, { title: 'Customization discovery', url: 'https://antigravity.google/docs/customization-discovery' }],
  // The CLI and App have different precedence; keep collisions uncertain across surfaces.
  collision: 'undocumented',
  rules: spec,
  toggleRule: MARKER_RULE,
  detect: (ctx) => detectBy(ctx, { bins: ['agy', 'antigravity'], dirs: [path.join(ctx.home, '.gemini', 'config'), path.join(ctx.home, '.gemini', 'antigravity-cli')], apps: appPaths(ctx, ['Antigravity'], ['Antigravity']) }),
  roots(ctx, projects) {
    const out = layout('antigravity', ctx, projects, ANTIGRAVITY_DOC,
      [
        { at: '.gemini/config/skills', rule: 'Antigravity App、CLI、IDE 共用全局目录', priority: 200 },
        { at: '.gemini/antigravity-cli/skills', rule: '仅 CLI 全局目录，App 不读取', priority: 400 },
        { at: '.gemini/skills', rule: '仅 CLI 兼容目录，App 不读取', priority: 400 },
        { at: '.gemini/antigravity/skills', rule: '仅独立 IDE 的旧版兼容目录', priority: 200 },
        { at: '.gemini/antigravity-cli/builtin/skills', rule: '本机内置路径，未核实跨版本规范', priority: 100, confidence: 'observed', readOnly: true },
      ],
      [{ at: '.agents/skills', rule: '工作区及仓库祖先 .agents/skills', priority: 300 }]);
    for (const r of out) if (r.readOnly) r.scope = 'system';
    return out;
  },
};

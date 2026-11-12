import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, Evidence, RootSpec } from '../types';
import { SPEC_FIELDS } from '../frontmatter';
import { readJson, statSafe } from '../util';
import { type Adapter, type FileEdit, type Probe, appPaths, detectBy, editJson, nestedRoots, rel, root, projectChain } from './base';

const DOC = { title: 'Claude Code · Skills', url: 'https://code.claude.com/docs/en/skills' };
const DOC_PLUGINS = { title: 'Claude Code · Plugins', url: 'https://code.claude.com/docs/en/plugins-reference' };

export function claudeConfigDir(ctx: Ctx): string {
  return ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, '.claude');
}

export function claudeManagedDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

function settingsFiles(ctx: Ctx, project?: string): string[] {
  const files = [path.join(claudeConfigDir(ctx), 'settings.json')];
  if (project) files.push(path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json'));
  return files;
}

function denies(rule: unknown, name: string): boolean {
  if (typeof rule !== 'string') return false;
  return rule === 'Skill' || rule === `Skill(${name})` || rule === `Skill(${name} *)` || rule === `Skill(${name}:*)`;
}

export const claude: Adapter = {
  id: 'claude',
  name: 'Claude Code',
  vendor: 'Anthropic',
  docs: [DOC, DOC_PLUGINS],
  collision: 'priority',
  rules: {
    requires: [],
    strictLimits: false,
    yamlErrorFatal: false,
    knownFields: [...SPEC_FIELDS, 'when_to_use', 'argument-hint', 'arguments', 'disable-model-invocation', 'user-invocable', 'disallowed-tools', 'model', 'effort', 'context', 'agent', 'background', 'hooks', 'paths', 'shell', 'version'],
  },
  toggleRule: 'settings.json · skillOverrides["<name>"] = "off"',

  detect(ctx) {
    return detectBy(ctx, { bins: ['claude'], dirs: [claudeConfigDir(ctx)], apps: appPaths(ctx, ['Claude'], ['claude']) });
  },

  roots(ctx, projects) {
    const cfg = claudeConfigDir(ctx);
    const out: RootSpec[] = [];
    out.push(
      root('claude', {
        scope: 'admin',
        dir: path.join(claudeManagedDir(ctx.platform), '.claude', 'skills'),
        rule: '企业托管目录中的 .claude/skills/<name>/SKILL.md，优先级最高',
        source: DOC,
        priority: 400,
        readOnly: true,
      }),
      root('claude', {
        scope: 'user',
        dir: path.join(cfg, 'skills'),
        rule: `个人级 ${rel(ctx, path.join(cfg, 'skills'))}/<name>/SKILL.md，优先于项目级`,
        source: DOC,
        priority: 300,
        ignore: ['synced'],
      }),
    );
    const synced = path.join(cfg, 'skills', 'synced');
    try {
      for (const b of fs.readdirSync(synced)) {
        if (b.startsWith('.') || !statSafe(path.join(synced, b))?.isDirectory()) continue;
        out.push(
          root('claude', {
            scope: 'system',
            dir: path.join(synced, b),
            rule: 'claude.ai 账户同步的 Skills，以 /anthropic-skills:<name> 调用',
            source: DOC,
            confidence: 'vendor',
            priority: 50,
            readOnly: true,
            namespace: 'anthropic-skills',
          }),
        );
      }
    } catch {}
    const installed = readJson(path.join(cfg, 'plugins', 'installed_plugins.json'));
    for (const [id, list] of Object.entries<any>(installed?.plugins || {})) {
      for (const inst of Array.isArray(list) ? list : [list]) {
        if (!inst?.installPath) continue;
        out.push(
          root('claude', {
            scope: 'plugin',
            dir: path.join(inst.installPath, 'skills'),
            rule: `插件 ${id} 的 skills/<name>/SKILL.md，以 /${id.split('@')[0]}:<name> 调用`,
            source: DOC_PLUGINS,
            priority: 60,
            readOnly: true,
            namespace: id.split('@')[0],
            pluginId: id,
          }),
        );
      }
    }
    for (const p of projectChain(projects)) {
      out.push(
        root('claude', {
          scope: 'project',
          project: p.path,
          dir: path.join(p.path, '.claude', 'skills'),
          rule: '项目级 .claude/skills/<name>/SKILL.md（启动目录及其上级直到仓库根）',
          source: DOC,
          priority: 200,
        }),
      );
      if (!p.nested) continue;
      for (const d of nestedRoots(p.path, ['.claude'])) {
        out.push(
          root('claude', {
            scope: 'project',
            project: path.dirname(path.dirname(d)),
            dir: d,
            rule: '嵌套 <subdir>/.claude/skills，首次读写该子目录文件时才加载',
            source: DOC,
            priority: 100,
            lazy: true,
            namespace: path.relative(p.path, path.dirname(path.dirname(d))).split(path.sep).join('/'),

          }),
        );
      }
    }
    return out;
  },

  disableState(ctx) {
    const cache = new Map<string, any>();
    const load = (f: string) => {
      if (!cache.has(f)) cache.set(f, readJson(f));
      return cache.get(f);
    };
    return (p: Probe): Evidence | null => {
      const files = settingsFiles(ctx, p.root.project);
      for (const f of files) if (fs.existsSync(f) && load(f) == null) return { ok: null, text: '配置无法解析，无法判断开关', path: f };
      if (p.root.pluginId) {
        for (const f of [...files].reverse()) {
          const v = load(f)?.enabledPlugins?.[p.root.pluginId];
          if (v === false) return { ok: false, text: `enabledPlugins["${p.root.pluginId}"] = false`, path: f };
          if (v === true) break;
        }
      }
      for (const f of files) {
        const deny = load(f)?.permissions?.deny;
        const hit = Array.isArray(deny) ? deny.find((r) => denies(r, p.name)) : undefined;
        if (hit) return { ok: null, text: `permissions.deny 限制 Skill 工具：${hit}；不等于完全禁用手动调用`, path: f };
      }
      if (p.root.pluginId) return null;
      for (const f of [...files].reverse()) {
        const v = load(f)?.skillOverrides?.[p.name];
        if (v === 'off') return { ok: false, text: `skillOverrides["${p.name}"] = "off"`, path: f };
        if (v != null) break;
      }
      return null;
    };
  },

  toggle(ctx, p, enable) {
    const edits: FileEdit[] = [];
    const blockers: string[] = [];
    if (p.root.pluginId || p.root.namespace) return { edits, blockers: ['插件与同步 Skills 不受 skillOverrides 控制'] };
    const files = settingsFiles(ctx, p.root.project);
    for (const f of files) if (fs.existsSync(f) && readJson(f) == null) blockers.push(`无法解析 ${f}`);
    for (const f of files) {
      const cur = readJson(f);
      if (cur?.skillOverrides != null && (typeof cur.skillOverrides !== 'object' || Array.isArray(cur.skillOverrides))) blockers.push(`skillOverrides 不是对象：${f}`);
    }
    if (blockers.length) return { edits, blockers };
    if (!enable) {
      const file = files[files.length - 1];
      const r = editJson(file, (o) => {
        o.skillOverrides = { ...(o.skillOverrides || {}), [p.name]: 'off' };
      });
      if ('error' in r) blockers.push(r.error);
      else edits.push({ path: file, content: r.content });
      return { edits, blockers };
    }
    for (const f of files) {
      const cur = readJson(f);
      if (!cur) continue;
      const deny: unknown[] = Array.isArray(cur.permissions?.deny) ? cur.permissions.deny : [];
      if (deny.includes('Skill')) blockers.push(`${f} 的 permissions.deny 含全局 Skill 规则`);
      if (deny.some((r) => denies(r, p.name))) blockers.push(`${f} 的权限限制需要由用户单独处理`);
      if (cur.skillOverrides?.[p.name] !== 'off') continue;
      const r = editJson(f, (o) => {
        delete o.skillOverrides[p.name];
        if (!Object.keys(o.skillOverrides).length) delete o.skillOverrides;
      });
      if ('error' in r) blockers.push(r.error);
      else edits.push({ path: f, content: r.content });
    }
    return { edits, blockers };
  },

  tags(_dir, fm) {
    const t: string[] = [];
    if (fm?.['disable-model-invocation'] === true) t.push('仅手动调用');
    if (fm?.['user-invocable'] === false) t.push('仅模型调用');
    if (fm?.context === 'fork') t.push('子代理');
    return t;
  },
};

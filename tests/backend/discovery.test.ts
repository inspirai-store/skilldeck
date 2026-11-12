import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCodexPlugins } from '../../src/core/discovery/codex-plugins';
import { discoverGeminiExtensions } from '../../src/core/discovery/gemini-extensions';
import { discoverOpenCodeSources } from '../../src/core/discovery/opencode-sources';
import { codex } from '../../src/core/adapters/codex';
import { gemini, opencode, cursor } from '../../src/core/adapters/others';
import { root, type Adapter } from '../../src/core/adapters/base';
import { Engine } from '../../src/core/engine';
import { dispatch } from '../../src/core/api';
import { buildSkillMd } from '../../src/core/frontmatter';
import { fingerprint } from '../../src/core/util';
import type { Ctx, Inventory, Op } from '../../src/core/types';

let home: string, ctx: Ctx;
const put = (p: string, data: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const json = (p: string, data: unknown) => put(p, JSON.stringify(data));
const skill = (dir: string) => put(path.join(dir, 'SKILL.md'), buildSkillMd(path.basename(dir), 'Fixture description', '# Body'));
const scoped = (ad: Adapter): Adapter => ({ ...ad, detect: () => ({ detection: 'absent', evidence: [] }), roots: (c, p) => ad.roots(c, p).filter((r) => r.dir.startsWith(home + path.sep)) });
const apply = (engine: Engine, op: Op) => {
  const p = engine.plan(op); expect(p.blockers).toEqual([]); expect(p.conflict).toBeUndefined(); return engine.apply(p.id);
};
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'skilldeck-discovery-')); ctx = { home, dataDir: path.join(home, 'data'), env: {}, platform: process.platform }; });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function plugin(version: string, portable = false) {
  const dir = path.join(home, '.codex/plugins/cache/store/demo', version);
  json(path.join(dir, portable ? 'plugin.json' : '.codex-plugin/plugin.json'), portable ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'demo', version } : { name: 'demo', version, skills: './workflows/' });
  skill(path.join(dir, portable ? 'skills/hello' : 'workflows/hello'));
  return dir;
}

describe('Codex cached plugin evidence', () => {
  it('finds compatibility and portable manifests without selecting a version or claiming activation', () => {
    plugin('1.0.0'); plugin('2.0.0', true);
    put(path.join(home, '.codex/config.toml'), '[plugins."demo@store"]\nenabled = false\n');
    const engine = new Engine(ctx, [scoped(codex)]), inv = engine.scan();
    const roots = inv.roots.filter((r) => r.sourceKind === 'plugin-cache');
    expect(roots).toHaveLength(2); expect(roots.every((r) => r.readOnly && r.confidence === 'observed')).toBe(true);
    const bindings = inv.skills.flatMap((r) => r.bindings);
    expect(bindings).toHaveLength(2); expect(bindings.every((b) => b.status === 'unknown' && b.readOnly && b.toggle === 'none')).toBe(true);
    expect(bindings[0].invocableName).toBe('demo:hello');
    expect(bindings[0].evidence.some((e) => e.path?.endsWith('config.toml') && e.text.includes('false'))).toBe(true);
    expect(engine.plan({ kind: 'delete', bindingId: bindings[0].id }).blockers.join()).toContain('只读');
  });
  it('rejects escaping manifest paths and continues past corrupt packages', () => {
    const bad = plugin('bad'), good = plugin('good');
    json(path.join(bad, '.codex-plugin/plugin.json'), { name: 'demo', skills: './../escape' });
    const result = discoverCodexPlugins(ctx);
    expect(result.roots).toHaveLength(1); expect(result.roots[0].dir).toBe(path.join(good, 'workflows'));
    expect(result.issues.some((i) => i.code === 'plugin-manifest-invalid')).toBe(true);
  });
  it('rejects package path symlinks escaping the package and unknown portable schemas', () => {
    const dir = plugin('linked'); fs.rmSync(path.join(dir, 'workflows'), { recursive: true });
    const outside = path.join(home, 'external'); skill(path.join(outside, 'hello')); fs.symlinkSync(outside, path.join(dir, 'workflows'));
    const other = plugin('schema', true); json(path.join(other, 'plugin.json'), { name: 'demo', $schema: 'https://untrusted.test/other.json' });
    const result = discoverCodexPlugins(ctx); expect(result.roots).toEqual([]); expect(result.issues).toHaveLength(2);
  });
  it('ignores undeclared compatibility skills and respects CODEX_HOME', () => {
    const dir = plugin('undeclared'); json(path.join(dir, '.codex-plugin/plugin.json'), { name: 'demo' });
    expect(discoverCodexPlugins(ctx).roots).toEqual([]);
    ctx.env.CODEX_HOME = path.join(home, 'different-codex'); expect(discoverCodexPlugins(ctx).roots).toEqual([]);
  });
  it('reports malformed plugin settings without losing valid cached candidates', () => {
    plugin('valid'); put(path.join(home, '.codex/config.toml'), '[bad');
    const result = discoverCodexPlugins(ctx); expect(result.roots).toHaveLength(1);
    expect(result.issues.some((i) => i.code === 'plugin-config-unreadable')).toBe(true);
  });
});

describe('Gemini extension packages', () => {
  it('discovers bundled skills with original skill names and read-only unknown activation', () => {
    const dir = path.join(home, '.gemini/extensions/review');
    json(path.join(dir, 'gemini-extension.json'), { name: 'review', version: '1.0.0', mcpServers: { neverRun: { command: 'false' } } });
    skill(path.join(dir, 'skills/hello'));
    const inv = new Engine(ctx, [scoped(gemini)]).scan();
    const b = inv.skills[0].bindings[0];
    expect(b.invocableName).toBe('hello'); expect(b.scope).toBe('plugin'); expect(b.readOnly).toBe(true); expect(b.status).toBe('unknown');
    expect(b.evidence.some((e) => e.path?.endsWith('gemini-extension.json'))).toBe(true);
  });
  it('follows official linked-directory packages and installed link metadata without modifying sources', () => {
    const source = path.join(home, 'source'); json(path.join(source, 'gemini-extension.json'), { name: 'linked', version: 'v1' }); skill(path.join(source, 'skills/hello'));
    const extensions = path.join(home, '.gemini/extensions'); fs.mkdirSync(extensions, { recursive: true });
    fs.symlinkSync(source, path.join(extensions, 'symlink'));
    json(path.join(extensions, 'metadata/.gemini-extension-install.json'), { type: 'link', source });
    const before = fingerprint(source), result = discoverGeminiExtensions(ctx);
    expect(result.roots).toHaveLength(2); expect(fingerprint(source)).toBe(before);
    expect(result.roots.some((r) => r.evidence?.some((e) => e.path?.endsWith('.gemini-extension-install.json')))).toBe(true);
  });
  it('diagnoses malformed and relative linked sources independently', () => {
    const ext = path.join(home, '.gemini/extensions');
    json(path.join(ext, 'bad/.gemini-extension-install.json'), { type: 'link', source: '../relative' });
    put(path.join(ext, 'broken/gemini-extension.json'), '{broken');
    json(path.join(ext, 'valid/gemini-extension.json'), { name: 'valid', version: '1' }); skill(path.join(ext, 'valid/skills/hello'));
    const result = discoverGeminiExtensions(ctx); expect(result.roots).toHaveLength(1); expect(result.issues).toHaveLength(2);
  });
});

describe('OpenCode configured local sources', () => {
  const discover = (projects: string[]) => discoverOpenCodeSources(ctx, projects.map((p) => ({ path: p, nested: false })), path.join(home, 'system'));
  it('parses JSONC and resolves relative paths from launch directory, not config directory', () => {
    const project = path.join(home, 'repo'), cwd = path.join(project, 'packages/app'); fs.mkdirSync(cwd, { recursive: true });
    put(path.join(project, 'opencode.jsonc'), '{ // comment\n"skills": ["./team-skills",],\n}');
    skill(path.join(cwd, 'team-skills/hello'));
    const result = discover([cwd]), sources = result.roots.filter((r) => r.sourceKind === 'agent-config' && r.scope !== 'admin');
    expect(sources).toHaveLength(1); expect(sources[0].dir).toBe(path.join(cwd, 'team-skills')); expect(sources[0].project).toBe(cwd);
    expect(sources[0].readOnly).toBe(true); expect(sources[0].evidence?.[0].path).toBe(path.join(project, 'opencode.jsonc'));
  });
  it('combines global, direct, .opencode and system declarations in distinct launch contexts', () => {
    const a = path.join(home, 'a'), b = path.join(home, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
    json(path.join(home, '.config/opencode/opencode.json'), { skills: ['~/shared', './relative'] });
    json(path.join(a, 'opencode.json'), { skills: ['./direct'] });
    json(path.join(a, '.opencode/opencode.json'), { skills: ['./overlay'] });
    json(path.join(home, 'system/opencode.json'), { skills: ['./managed'] });
    const roots = discover([a, b]).roots;
    expect(roots.filter((r) => r.dir === path.join(home, 'shared'))).toHaveLength(1);
    expect(roots.some((r) => r.dir === path.join(a, 'relative'))).toBe(true);
    expect(roots.some((r) => r.dir === path.join(b, 'relative'))).toBe(true);
    expect(roots.some((r) => r.dir === path.join(a, 'direct'))).toBe(true);
    expect(roots.some((r) => r.dir === path.join(a, 'overlay'))).toBe(true);
    expect(roots.some((r) => r.dir === path.join(b, 'managed') && r.readOnly)).toBe(true);
  });
  it('does not assume CWD, fetch catalogs, expand secrets or accept partial malformed config', () => {
    put(path.join(home, '.config/opencode/opencode.jsonc'), '{"skills":["./requires-cwd", "https://example.test/catalog/?token=private", "{file:~/.secrets}", 123]}');
    const result = discover([]);
    expect(result.roots.filter((r) => r.scope !== 'admin')).toEqual([]);
    expect(new Set(result.issues.map((i) => i.code))).toEqual(new Set(['opencode-cwd-required', 'remote-catalog-not-fetched', 'opencode-source-unresolved', 'opencode-source-invalid']));
    expect(JSON.stringify(result.issues)).not.toContain('token=private');
    put(path.join(home, '.config/opencode/opencode.jsonc'), '{"skills":["~/valid"], broken}');
    const invalid = discover([]); expect(invalid.roots.filter((r) => r.scope !== 'admin')).toEqual([]); expect(invalid.issues[0].code).toBe('opencode-config-invalid');
  });
  it('retains both source declarations when the same path is also a native root', () => {
    const p = path.join(home, 'project'); skill(path.join(p, '.opencode/skills/hello')); json(path.join(p, 'opencode.json'), { skills: ['./.opencode/skills'] });
    const ad = scoped(opencode); ad.discover = (c, projects) => discoverOpenCodeSources(c, projects, path.join(home, 'system'));
    const engine = new Engine(ctx, [ad]); const inv = engine.addProject(p);
    const skillRecord = inv.skills.find((s) => s.dirName === 'hello')!;
    expect(skillRecord.bindings).toHaveLength(2); expect(new Set(skillRecord.bindings.map((b) => b.id)).size).toBe(2);
    expect(skillRecord.bindings.some((b) => b.status === 'unknown')).toBe(true);
    expect(engine.plan({ kind: 'edit', bindingId: skillRecord.bindings[0].id, content: 'change' }).blockers.join()).toContain('只读');
  });
});

describe('user registered scan directories', () => {
  it('persists registrations, defaults to read-only unknown, and removes registration without touching files', () => {
    const dir = path.join(home, 'external'); skill(path.join(dir, 'hello'));
    const engine = new Engine(ctx, [scoped(codex)]);
    const inv = dispatch(engine, 'addScanDirectory', { agent: 'codex', path: dir }) as Inventory;
    const b = inv.skills[0].bindings[0]; expect(b.status).toBe('unknown'); expect(b.readOnly).toBe(true);
    const before = fingerprint(dir), registered = engine.listScanDirectories();
    expect(registered).toHaveLength(1);
    const restarted = new Engine(ctx, [scoped(codex)]); expect(restarted.listScanDirectories()).toEqual(registered);
    expect(dispatch(restarted, 'listScanDirectories')).toEqual(registered);
    dispatch(restarted, 'removeScanDirectory', { id: registered[0].id });
    expect(restarted.listScanDirectories()).toEqual([]); expect(fingerprint(dir)).toBe(before);
    expect(fs.readdirSync(path.join(ctx.dataDir, 'config-backups')).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(home, '.codex/config.toml'))).toBe(false);
  });
  it('does not silently replace permissions, deduplicates aliases and preserves unknown config fields', () => {
    const dir = path.join(home, 'external'); skill(path.join(dir, 'hello'));
    const alias = path.join(home, 'alias'); fs.symlinkSync(dir, alias);
    json(path.join(ctx.dataDir, 'config.json'), { projects: [], hiddenProjects: [], future: { retain: true } });
    const engine = new Engine(ctx, [scoped(codex)]);
    engine.addScanDirectory('codex', dir); engine.addScanDirectory('codex', alias);
    expect(engine.listScanDirectories()).toHaveLength(1);
    expect(() => engine.addScanDirectory('codex', dir, false)).toThrow('不静默覆盖');
    expect(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'config.json'), 'utf8')).future).toEqual({ retain: true });
  });
  it('supports explicitly writable staging directories using markers, never fake official config switches', () => {
    const dir = path.join(home, 'staging'); skill(path.join(dir, 'hello'));
    const engine = new Engine(ctx, [scoped(codex)]);
    let inv = engine.addScanDirectory('codex', dir, false);
    const root = inv.roots.find((r) => r.sourceKind === 'custom')!;
    let b = inv.skills[0].bindings[0]; expect(b.toggle).toBe('marker');
    apply(engine, { kind: 'toggle', bindingId: b.id, enable: false });
    b = engine.scan().skills[0].bindings[0]; expect(b.status).toBe('disabled');
    apply(engine, { kind: 'toggle', bindingId: b.id, enable: true });
    expect(engine.scan().skills[0].bindings[0].status).toBe('unknown');
    expect(fs.existsSync(path.join(home, '.codex/config.toml'))).toBe(false);
    apply(engine, { kind: 'create', rootId: root.id, name: 'new', description: 'new', body: '' });
    expect(fs.existsSync(path.join(dir, 'new/SKILL.md'))).toBe(true);
  });
  it('supports individual skill registration and archive/restore without treating its children as skills', () => {
    const dir = path.join(home, 'single'); skill(dir); put(path.join(dir, 'references/guide.md'), 'reference');
    const engine = new Engine(ctx, [scoped(codex)]);
    const inv = engine.addScanDirectory('codex', dir, false);
    expect(engine.listScanDirectories()[0].layout).toBe('skill'); expect(inv.skills).toHaveLength(1);
    const b = inv.skills[0].bindings[0]; expect(b.entryPath).toBe(dir);
    expect(engine.plan({ kind: 'create', rootId: b.rootId, name: 'child', description: 'x', body: '' }).blockers.join()).toContain('单个 Skill');
    apply(engine, { kind: 'archive', bindingId: b.id });
    const archived = engine.scan().skills[0].bindings[0]; expect(archived.status).toBe('archived');
    apply(engine, { kind: 'restore', archiveId: archived.archiveId! });
    expect(fs.readFileSync(path.join(dir, 'references/guide.md'), 'utf8')).toBe('reference');
  });
  it('cannot bypass a managed plugin through another agent or a symlink alias', () => {
    const pkg = plugin('protected'), dir = path.join(pkg, 'workflows');
    const alias = path.join(home, 'alias'); fs.symlinkSync(dir, alias);
    const engine = new Engine(ctx, [scoped(codex), scoped(cursor)]);
    const inv = engine.addScanDirectory('cursor', alias, false);
    const custom = inv.roots.find((r) => r.sourceKind === 'custom')!; expect(custom.readOnly).toBe(true);
    const b = inv.skills[0].bindings.find((b) => b.agent === 'cursor')!; expect(b.readOnly).toBe(true);
    expect(engine.plan({ kind: 'create', rootId: custom.id, name: 'sneak', description: 'x', body: '' }).blockers.join()).toContain('只读');
    expect(engine.plan({ kind: 'delete', bindingId: b.id }).blockers.join()).toContain('只读');
  });
  it('rechecks newly added read-only protection at apply time', () => {
    const dir = path.join(home, 'staging'); skill(path.join(dir, 'hello'));
    const engine = new Engine(ctx, [scoped(codex), scoped(cursor)]);
    const inv = engine.addScanDirectory('codex', dir, false);
    const b = inv.skills[0].bindings[0];
    const p = engine.plan({ kind: 'edit', bindingId: b.id, content: buildSkillMd('hello', 'changed', 'new') });
    engine.addScanDirectory('cursor', dir, true);
    expect(() => engine.apply(p.id)).toThrow('只读');
    expect(fs.readFileSync(path.join(dir, 'hello/SKILL.md'), 'utf8')).not.toContain('changed');
  });
  it('rejects invalid registrations and respects pending recovery for configuration writes', () => {
    const dir = path.join(home, 'staging'); fs.mkdirSync(dir);
    const engine = new Engine(ctx, [scoped(codex)]);
    for (const p of ['relative', home, path.parse(home).root, ctx.dataDir]) expect(() => engine.addScanDirectory('codex', p)).toThrow();
    expect(() => engine.addScanDirectory('missing-agent', dir)).toThrow('未知智能体');
    expect(() => dispatch(engine, 'addScanDirectory', { agent: 'codex', path: dir, readOnly: 'false' })).toThrow('布尔值');
    expect(() => dispatch(engine, 'addScanDirectory', { agent: 'codex', path: dir, layout: 'other' })).toThrow();
    put(path.join(ctx.dataDir, 'pending.json'), '{}'); expect(() => engine.addScanDirectory('codex', dir)).toThrow('未完成');
  });
  it('reports registrations whose adapter is unavailable, without inventing loading rules', () => {
    const dir = path.join(home, 'external'); skill(path.join(dir, 'hello'));
    new Engine(ctx, [scoped(codex)]).addScanDirectory('codex', dir);
    const inv = new Engine(ctx, []).scan(); expect(inv.skills).toEqual([]);
    expect(inv.discoveryIssues?.[0].code).toBe('custom-agent-unknown');
  });
  it('allows removing an unprotected symlink entry pointing into a read-only package', () => {
    const pkg = plugin('protected'), linked = path.join(home, '.agents/skills/alias');
    fs.mkdirSync(path.dirname(linked), { recursive: true }); fs.symlinkSync(path.join(pkg, 'workflows/hello'), linked);
    const engine = new Engine(ctx, [scoped(codex)]);
    const inv = engine.scan(), b = inv.skills[0].bindings.find((b) => b.entryPath === linked)!;
    const before = fingerprint(pkg);
    apply(engine, { kind: 'delete', bindingId: b.id });
    expect(fs.existsSync(linked)).toBe(false); expect(fingerprint(pkg)).toBe(before);
  });
});

it('does not turn JSONC __proto__ properties into an inherited skills declaration', () => {
  put(path.join(home, '.config/opencode/opencode.jsonc'), '{"__proto__":{"skills":["~/not-a-source"]}}');
  const result = discoverOpenCodeSources(ctx, [], path.join(home, 'system'));
  expect(result.roots.some((r) => r.dir === path.join(home, 'not-a-source'))).toBe(false);
});

it('reports extra-source discovery exceptions without suppressing native or custom roots', () => {
  const dir = path.join(home, 'external'); skill(path.join(dir, 'hello'));
  const ad = scoped(codex); ad.discover = () => { throw new Error('provider failure'); };
  const inv = new Engine(ctx, [ad]).addScanDirectory('codex', dir);
  expect(inv.skills).toHaveLength(1); expect(inv.discoveryIssues?.some((i) => i.code === 'additional-discovery-failed')).toBe(true);
});

it('preserves Gemini enablement evidence without interpreting it as runtime activation', () => {
  const dir = path.join(home, '.gemini/extensions/review');
  json(path.join(dir, 'gemini-extension.json'), { name: 'review', version: '1' }); skill(path.join(dir, 'skills/hello'));
  json(path.join(home, '.gemini/extensions/extension-enablement.json'), { review: { overrides: ['!*', home] } });
  const inv = new Engine(ctx, [scoped(gemini)]).scan();
  expect(inv.skills[0].bindings[0].status).toBe('unknown');
  expect(inv.skills[0].bindings[0].evidence.some((e) => e.path?.endsWith('extension-enablement.json'))).toBe(true);
});

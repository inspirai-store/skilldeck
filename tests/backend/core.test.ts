import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../../src/core/engine';
import { dispatch } from '../../src/core/api';
import { root, type Adapter } from '../../src/core/adapters/base';
import { claude } from '../../src/core/adapters/claude';
import { codex } from '../../src/core/adapters/codex';
import { gemini, cursor, opencode, codebuddy } from '../../src/core/adapters/others';
import { buildSkillMd, parseSkillMd } from '../../src/core/frontmatter';
import { fingerprint } from '../../src/core/util';
import type { Ctx, Op } from '../../src/core/types';

let dir: string, ctx: Ctx, engine: Engine, adapters: Adapter[];
const put = (p: string, content = 'data') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
const skill = (p: string, name = path.basename(p)) => put(path.join(p, 'SKILL.md'), buildSkillMd(name, 'A test skill', '# Body\n'));
const source = () => path.join(dir, 'a', 'hello');
const bindings = () => engine.scan().skills.flatMap((s) => s.bindings);
const binding = () => bindings().find((b) => b.entryPath === source())!;
const rootId = (agent = 'a') => engine.scan().roots.find((r) => r.agent === agent)!.id;
const apply = (op: Op) => {
  const p = engine.plan(op);
  expect(p.blockers).toEqual([]); expect(p.conflict).toBeUndefined();
  return engine.apply(p.id);
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilldeck-test-'));
  ctx = { home: dir, platform: process.platform, env: { PATH: '' }, dataDir: path.join(dir, 'data') };
  adapters = ['a', 'b'].map((id) => ({ id, name: id, vendor: 'test', docs: [], collision: 'priority', rules: codex.rules, toggleRule: 'marker', detect: () => ({ detection: 'installed', evidence: [] }), roots: () => [root(id, { dir: path.join(dir, id), scope: 'user', priority: 1, rule: 'fixture', source: { title: 'fixture', url: '' } })] }));
  engine = new Engine(ctx, adapters);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('lifecycle and conflict protection', () => {
  it('creates, reads, edits and rolls back after restart', () => {
    apply({ kind: 'create', rootId: rootId(), name: 'hello', description: 'Hi', body: '# Hi' });
    const rec = engine.scan().skills[0];
    expect(engine.readSkill(rec.id).content).toContain('# Hi');
    const original = fs.readFileSync(path.join(source(), 'SKILL.md'), 'utf8');
    const edited = apply({ kind: 'edit', bindingId: binding().id, content: buildSkillMd('hello', 'Changed', 'body') });
    engine = new Engine(ctx, adapters);
    apply({ kind: 'rollback', entryId: edited.id });
    expect(fs.readFileSync(path.join(source(), 'SKILL.md'), 'utf8')).toBe(original);
    expect(engine.history().find((e) => e.id === edited.id)?.status).toBe('rolledBack');
  });
  it('does not overwrite an existing directory or malformed config', () => {
    skill(source());
    expect(engine.plan({ kind: 'create', rootId: rootId(), name: 'hello', description: 'a', body: '' }).blockers.length).toBeGreaterThan(0);
    put(path.join(ctx.dataDir, 'config.json'), '{oops');
    expect(() => engine.addProject(dir)).toThrow('损坏');
  });
  it('rejects drift including large files, hidden dependencies and changed symlink targets', () => {
    skill(source()); put(path.join(source(), 'node_modules/x'), 'before');
    const p = engine.plan({ kind: 'delete', bindingId: binding().id });
    put(path.join(source(), 'node_modules/x'), 'after');
    expect(() => engine.apply(p.id)).toThrow('变化');
    const a = fingerprint(source());
    fs.symlinkSync('../one', path.join(source(), 'link'));
    const b = fingerprint(source());
    fs.unlinkSync(path.join(source(), 'link')); fs.symlinkSync('../two', path.join(source(), 'link'));
    expect(fingerprint(source())).not.toBe(b); expect(a).not.toBe(b);
  });
  it('rejects ancestor redirection even when content is identical', () => {
    skill(source()); fs.cpSync(path.join(dir, 'a'), path.join(dir, 'other'), { recursive: true });
    const p = engine.plan({ kind: 'delete', bindingId: binding().id });
    fs.renameSync(path.join(dir, 'a'), path.join(dir, 'old')); fs.symlinkSync(path.join(dir, 'other'), path.join(dir, 'a'));
    expect(() => engine.apply(p.id)).toThrow('变化');
    expect(fs.existsSync(path.join(dir, 'other/hello/SKILL.md'))).toBe(true);
  });
  it('toggles marker and protects simultaneous active and disabled files', () => {
    skill(source()); apply({ kind: 'toggle', bindingId: binding().id, enable: false });
    expect(binding().status).toBe('disabled');
    apply({ kind: 'toggle', bindingId: binding().id, enable: true });
    expect(binding().status).toBe('unverified');
    put(path.join(source(), 'SKILL.md.disabled'), 'existing');
    const p = engine.plan({ kind: 'toggle', bindingId: binding().id, enable: false });
    expect(p.blockers.join()).toContain('覆盖');
  });
  it('archives, restores, purges and rolls purge back', () => {
    skill(source()); apply({ kind: 'archive', bindingId: binding().id });
    const archived = bindings().find((b) => b.status === 'archived')!;
    expect(fs.existsSync(source())).toBe(false);
    const purge = apply({ kind: 'purge', archiveId: archived.archiveId! });
    expect(bindings()).toEqual([]);
    apply({ kind: 'rollback', entryId: purge.id });
    apply({ kind: 'restore', archiveId: archived.archiveId! });
    expect(fs.existsSync(path.join(source(), 'SKILL.md'))).toBe(true);
  });
  it('requires rename to restore into an occupied location', () => {
    skill(source()); apply({ kind: 'archive', bindingId: binding().id });
    const id = bindings().find((b) => b.status === 'archived')!.archiveId!;
    skill(source(), 'new');
    expect(engine.plan({ kind: 'restore', archiveId: id }).conflict).toBeDefined();
    apply({ kind: 'restore', archiveId: id, choice: 'rename', newName: 'restored' });
    expect(fs.existsSync(path.join(dir, 'a/restored/SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(source(), 'SKILL.md'), 'utf8')).toContain('name: new');
  });
  it('deletes into backup and requires explicit force for changed copies on rollback', () => {
    skill(source()); const entry = apply({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'copy' });
    put(path.join(dir, 'b/hello/SKILL.md'), 'new');
    expect(engine.plan({ kind: 'rollback', entryId: entry.id }).conflict).toBeDefined();
    const reverted = apply({ kind: 'rollback', entryId: entry.id, force: true });
    const trashed = reverted.steps.find((s) => s.type === 'trash');
    expect(trashed?.type === 'trash' && fs.readFileSync(path.join(trashed.backup!, 'SKILL.md'), 'utf8')).toBe('new');
  });
});

describe('migration and links', () => {
  it.each(['copy', 'move', 'link'] as const)('transfers with %s and rolls back', (mode) => {
    skill(source()); put(path.join(source(), 'assets/a'), 'asset');
    const entry = apply({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode });
    expect(fs.readFileSync(path.join(dir, 'b/hello/assets/a'), 'utf8')).toBe('asset');
    expect(fs.existsSync(source())).toBe(mode !== 'move');
    apply({ kind: 'rollback', entryId: entry.id });
    expect(fs.existsSync(source())).toBe(true); expect(fs.existsSync(path.join(dir, 'b/hello'))).toBe(false);
  });
  it('replaces only by explicit choice and restores replaced data on rollback', () => {
    skill(source()); skill(path.join(dir, 'b/hello'), 'old');
    const op = { kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'copy' } as const;
    expect(engine.plan(op).conflict).toBeDefined();
    const entry = apply({ ...op, choice: 'replace' });
    expect(fs.readFileSync(path.join(dir, 'b/hello/SKILL.md'), 'utf8')).toContain('name: hello');
    apply({ kind: 'rollback', entryId: entry.id });
    expect(fs.readFileSync(path.join(dir, 'b/hello/SKILL.md'), 'utf8')).toContain('name: old');
  });
  it('renames YAML metadata without rewriting body or losing extension fields', () => {
    skill(source()); put(path.join(source(), 'SKILL.md'), '---\nname: hello\ndescription: desc\ncontext: fork\nmetadata:\n  nested: yes\n---\nname: body-name\n');
    apply({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'copy', choice: 'rename', newName: 'next' });
    const text = fs.readFileSync(path.join(dir, 'b/next/SKILL.md'), 'utf8');
    expect(parseSkillMd(text).data).toMatchObject({ name: 'next', context: 'fork', metadata: { nested: 'yes' } });
    expect(parseSkillMd(text).body).toBe('name: body-name\n');
  });
  it('imports a local directory without changing the original', () => {
    const external = path.join(dir, 'external'); skill(external); put(path.join(external, '.env'), 'private');
    const before = fingerprint(external);
    apply({ kind: 'import', sourcePath: external, rootId: rootId(), newName: 'imported' });
    expect(fingerprint(external)).toBe(before);
    expect(fs.readFileSync(path.join(dir, 'a/imported/.env'), 'utf8')).toBe('private');
    expect(engine.plan({ kind: 'import', sourcePath: external, rootId: rootId(), newName: 'imported' }).blockers.length).toBeGreaterThan(0);
  });
  it('archives and restores a relative symlink without altering its target', () => {
    const target = path.join(dir, 'target'); skill(target, 'hello'); fs.mkdirSync(path.join(dir, 'a'));
    fs.symlinkSync('../target', source());
    const before = fingerprint(target);
    apply({ kind: 'archive', bindingId: binding().id });
    const archived = bindings().find((b) => b.status === 'archived')!;
    apply({ kind: 'restore', archiveId: archived.archiveId! });
    expect(fs.readlinkSync(source())).toBe('../target'); expect(fingerprint(target)).toBe(before);
  });
  it('deletes a symlink only, and migrates its target into an independent copy', () => {
    const target = path.join(dir, 'target'); skill(target, 'hello'); fs.mkdirSync(path.join(dir, 'a')); fs.symlinkSync(target, source());
    apply({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'move' });
    expect(fs.existsSync(target)).toBe(true); expect(fs.existsSync(source())).toBe(false);
    expect(fs.lstatSync(path.join(dir, 'b/hello')).isSymbolicLink()).toBe(false);
  });
  it('rejects a transfer inside its source directory', () => {
    skill(source()); adapters[1].roots = () => [root('b', { dir: path.join(source(), 'nested'), scope: 'user', priority: 1, source: { title: '', url: '' }, rule: '' })];
    expect(engine.plan({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'copy' }).blockers.join()).toContain('源目录内');
  });
  it('preserves occupied move origin on forced rollback', () => {
    skill(source()); const entry = apply({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'move' });
    skill(source(), 'new');
    const rollback = apply({ kind: 'rollback', entryId: entry.id, force: true });
    expect(fs.readFileSync(path.join(source(), 'SKILL.md'), 'utf8')).toContain('name: hello');
    const backup = rollback.steps.find((s) => s.type === 'trash');
    expect(backup?.type === 'trash' && fs.readFileSync(path.join(backup.backup!, 'SKILL.md'), 'utf8')).toContain('name: new');
  });
});

describe('scanner and shared entities', () => {
  it('never claims runtime activation based on executable detection', () => {
    skill(source()); expect(binding().status).toBe('unverified');
    expect(binding().evidence.some((e) => e.text.includes('当前会话'))).toBe(true);
  });
  it('scans roots even when the agent executable is absent', () => {
    adapters[0].detect = () => ({ detection: 'absent', evidence: [] }); skill(source());
    expect(binding().status).toBe('unverified');
  });
  it('deduplicates entities but retains separate bindings and shared-change warnings', () => {
    skill(source()); fs.mkdirSync(path.join(dir, 'b')); fs.symlinkSync(source(), path.join(dir, 'b/hello'));
    expect(engine.scan().skills).toHaveLength(1);
    expect(engine.scan().skills[0].bindings).toHaveLength(2);
    expect(engine.plan({ kind: 'edit', bindingId: binding().id, content: 'changed' }).warnings.some((w) => w.code === 'shared')).toBe(true);
  });
  it('protects read-only shared content through another binding', () => {
    skill(source()); adapters[1].roots = () => [root('b', { dir: path.join(dir, 'a'), scope: 'system', readOnly: true, priority: 1, rule: '', source: { title: '', url: '' } })];
    for (const op of [{ kind: 'edit', bindingId: binding().id, content: 'changed' }, { kind: 'toggle', bindingId: binding().id, enable: false }, { kind: 'delete', bindingId: binding().id }] as Op[]) expect(engine.plan(op).blockers.join()).toContain('只读');
  });
  it('reports malformed YAML, missing Skill file and broken links', () => {
    put(path.join(source(), 'SKILL.md'), '---\nname: [\n---\nbody');
    fs.mkdirSync(path.join(dir, 'a/empty')); fs.symlinkSync('missing', path.join(dir, 'a/broken'));
    expect(bindings().filter((b) => b.status === 'invalid')).toHaveLength(3);
  });
  it('handles cyclic symlink directories without recursion failure', () => {
    fs.mkdirSync(path.join(dir, 'a'), { recursive: true }); fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'a/cycle'));
    expect(() => engine.scan()).not.toThrow();
  });
  it('marks undocumented nested loading as unknown and supports recursive adapters', () => {
    skill(path.join(dir, 'a/group/hello')); expect(bindings()[0].status).toBe('unknown');
    adapters[0].recursive = true; expect(bindings()[0].status).toBe('unverified');
  });
});

describe('official settings', () => {
  function vendor(ad: Adapter, folder: string) {
    skill(path.join(dir, folder, 'hello'));
    const scoped = { ...ad, detect: adapters[0].detect, roots: (c: Ctx) => ad.roots(c, []).filter((r) => r.dir.startsWith(dir + path.sep)) };
    engine = new Engine(ctx, [scoped]);
    return () => bindings().find((b) => b.entryPath === path.join(dir, folder, 'hello'))!;
  }
  it('toggles Codex by absolute SKILL.md path and preserves unrelated TOML', () => {
    const b = vendor(codex, '.agents/skills');
    const cfg = path.join(dir, '.codex/config.toml'); put(cfg, '# keep\nmodel = "fixture"\n');
    apply({ kind: 'toggle', bindingId: b().id, enable: false }); expect(b().status).toBe('disabled');
    expect(fs.readFileSync(cfg, 'utf8')).toContain('# keep');
    apply({ kind: 'toggle', bindingId: b().id, enable: true }); expect(b().status).toBe('unverified');
    expect(fs.readFileSync(cfg, 'utf8')).toContain('model = "fixture"');
  });
  it('does not claim enabled when Codex settings cannot parse', () => {
    const b = vendor(codex, '.agents/skills'); put(path.join(dir, '.codex/config.toml'), '[broken');
    expect(b().status).toBe('unverified'); expect(b().evidence.some((e) => e.text.includes('无法解析'))).toBe(true);
    expect(engine.plan({ kind: 'toggle', bindingId: b().id, enable: false }).blockers.length).toBeGreaterThan(0);
  });
  it('honors the last matching Codex selector and refuses unsupported inline enabling', () => {
    const b = vendor(codex, '.agents/skills'); put(path.join(dir, '.codex/config.toml'), 'skills.config = [{name="hello", enabled=false}]\n');
    expect(b().status).toBe('disabled'); expect(engine.plan({ kind: 'toggle', bindingId: b().id, enable: true }).blockers.length).toBeGreaterThan(0);
  });
  it('toggles Claude visibility without modifying permissions or frontmatter', () => {
    const b = vendor(claude, '.claude/skills'); const cfg = path.join(dir, '.claude/settings.json');
    put(cfg, JSON.stringify({ permissions: { allow: ['Read'] }, unrelated: true }));
    const before = fingerprint(path.join(dir, '.claude/skills/hello'));
    apply({ kind: 'toggle', bindingId: b().id, enable: false }); expect(b().status).toBe('disabled');
    apply({ kind: 'toggle', bindingId: b().id, enable: true });
    expect(fingerprint(path.join(dir, '.claude/skills/hello'))).toBe(before);
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8'))).toEqual({ permissions: { allow: ['Read'] }, unrelated: true });
  });
  it('does not erase Claude permission deny rules while enabling', () => {
    const b = vendor(claude, '.claude/skills'); const cfg = path.join(dir, '.claude/settings.json');
    put(cfg, JSON.stringify({ permissions: { deny: ['Skill(hello)'] }, skillOverrides: { hello: 'off' } }));
    const before = fingerprint(cfg);
    expect(engine.plan({ kind: 'toggle', bindingId: b().id, enable: true }).blockers.length).toBeGreaterThan(0);
    expect(fingerprint(cfg)).toBe(before);
  });
  it('toggles Gemini disabled list without dropping unrelated configuration', () => {
    const b = vendor(gemini, '.gemini/skills'); const cfg = path.join(dir, '.gemini/settings.json'); put(cfg, '{"skills":{"disabled":["other"]},"theme":"x"}');
    apply({ kind: 'toggle', bindingId: b().id, enable: false }); expect(b().status).toBe('disabled');
    apply({ kind: 'toggle', bindingId: b().id, enable: true });
    expect(JSON.parse(fs.readFileSync(cfg, 'utf8'))).toEqual({ skills: { disabled: ['other'] }, theme: 'x' });
  });
  it.each([claude, gemini])('fails closed on malformed $id JSON', (ad) => {
    const folder = ad.id === 'claude' ? '.claude' : '.gemini'; const b = vendor(ad, `${folder}/skills`);
    put(path.join(dir, folder, 'settings.json'), '{broken');
    expect(b().status).toBe('unverified');
    expect(engine.plan({ kind: 'toggle', bindingId: b().id, enable: true }).blockers.length).toBeGreaterThan(0);
  });
  it('uses folder identity for Cursor and OpenCode and documents CodeBuddy roots', () => {
    expect(cursor.idFromPath).toBe(true); expect(opencode.idFromPath).toBe(true); expect(opencode.recursive).toBe(true);
    expect(codebuddy.roots(ctx, [])[0].confidence).toBe('documented');
  });
});

describe('failure and API boundaries', () => {
  it('rejects malformed operation values instead of coercing them', () => {
    for (const op of [{ kind: 'anything' }, { kind: 'toggle', bindingId: 'x', enable: 'false' }, { kind: 'transfer', bindingId: 'x', targetRootId: 'y', mode: 'erase' }, { kind: 'edit', bindingId: 'x', content: null }]) expect(() => dispatch(engine, 'plan', { op })).toThrow();
    expect(() => dispatch(engine, 'readFile', { skillId: null, rel: '..' })).toThrow();
  });
  it('blocks path traversal and external symlink reads', () => {
    skill(source()); put(path.join(dir, 'secret'), 'secret'); fs.symlinkSync(path.join(dir, 'secret'), path.join(source(), 'outside'));
    const rec = engine.scan().skills[0];
    expect(() => engine.readFile(rec.id, '../../secret')).toThrow('越界');
    expect(() => engine.readFile(rec.id, 'outside')).toThrow('越界');
  });
  it('rolls back completed steps if a later copy fails, retaining the replaced destination', () => {
    skill(source()); skill(path.join(dir, 'b/hello'), 'old');
    const p = engine.plan({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'copy', choice: 'replace' });
    vi.spyOn(fs, 'cpSync').mockImplementation(() => { put(path.join(dir, 'b/hello/partial')); throw new Error('copy failure'); });
    expect(() => engine.apply(p.id)).toThrow('copy failure');
    expect(fs.readFileSync(path.join(dir, 'b/hello/SKILL.md'), 'utf8')).toContain('name: old');
    expect(fs.existsSync(path.join(ctx.dataDir, 'pending.json'))).toBe(false);
    expect(engine.history()).toEqual([]);
  });
  it('does not mutate with a corrupted journal or unfinished operation', () => {
    skill(source()); const p = engine.plan({ kind: 'delete', bindingId: binding().id });
    put(path.join(ctx.dataDir, 'journal.json'), '{}'); expect(() => engine.apply(p.id)).toThrow('损坏');
    fs.unlinkSync(path.join(ctx.dataDir, 'journal.json'));
    const next = engine.plan({ kind: 'delete', bindingId: binding().id }); put(path.join(ctx.dataDir, 'pending.json'), '{}');
    expect(() => engine.apply(next.id)).toThrow('未完成'); expect(fs.existsSync(source())).toBe(true);
  });
  it('blocks concurrent writers and refuses rollback when its backup changed', () => {
    skill(source()); const p = engine.plan({ kind: 'delete', bindingId: binding().id });
    fs.mkdirSync(path.join(ctx.dataDir, 'mutation.lock'), { recursive: true });
    expect(() => engine.apply(p.id)).toThrow('其他写操作'); fs.rmdirSync(path.join(ctx.dataDir, 'mutation.lock'));
    const entry = engine.apply(p.id); const step = entry.steps.find((s) => s.type === 'trash')!;
    if (step.type !== 'trash') throw new Error('expected trash');
    put(path.join(step.backup!, 'SKILL.md'), 'tampered');
    expect(engine.plan({ kind: 'rollback', entryId: entry.id, force: true }).blockers.join()).toContain('备份');
  });
});

describe('additional regressions', () => {
  it('discovers repository ancestors and stops at the Git root', () => {
    const repo = path.join(dir, 'repo'), nested = path.join(repo, 'packages/app');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true }); fs.mkdirSync(nested, { recursive: true });
    const roots = codex.roots(ctx, [{ path: nested, nested: true }]);
    expect(roots.some((r) => r.dir === path.join(repo, '.agents/skills'))).toBe(true);
    expect(roots.some((r) => r.dir === path.join(dir, '.agents/skills') && r.scope === 'project')).toBe(false);
  });
  it('isolates adapter discovery failure from other agents', () => {
    adapters[0].roots = () => { throw new Error('discovery failure'); }; skill(path.join(dir, 'b/hello'));
    expect(engine.scan().skills).toHaveLength(1);
    expect(engine.scan().agents[0].detectionEvidence.some((e) => e.text.includes('discovery failure'))).toBe(true);
  });
  it('detects same-size changes in large files with preserved timestamps', () => {
    const file = path.join(dir, 'large'); put(file, 'a'.repeat(2 * 1024 * 1024)); const st = fs.statSync(file);
    const before = fingerprint(dir); put(file, 'b'.repeat(2 * 1024 * 1024)); fs.utimesSync(file, st.atime, st.mtime);
    expect(fingerprint(dir)).not.toBe(before);
  });
  it('restores data when journal persistence fails after filesystem mutation', () => {
    skill(source()); const p = engine.plan({ kind: 'delete', bindingId: binding().id });
    const original = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(ctx.dataDir, 'journal.json')) throw new Error('journal disk failure');
      return original(from, to);
    });
    expect(() => engine.apply(p.id)).toThrow('操作日志保存失败');
    expect(fs.existsSync(path.join(source(), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(ctx.dataDir, 'pending.json'))).toBe(false);
  });
  it('retains pending evidence when automatic restoration fails', () => {
    skill(source()); skill(path.join(dir, 'b/hello'), 'old');
    const p = engine.plan({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'copy', choice: 'replace' });
    vi.spyOn(fs, 'cpSync').mockImplementation(() => { throw new Error('copy failed'); });
    const original = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('/backups/')) throw new Error('restore failed');
      return original(from, to);
    });
    expect(() => engine.apply(p.id)).toThrow('自动恢复失败');
    expect(fs.existsSync(path.join(ctx.dataDir, 'pending.json'))).toBe(true);
    expect(() => engine.apply(engine.plan({ kind: 'delete', bindingId: binding().id }).id)).toThrow('未完成');
  });
  it('force from RPC requires the explicit conflict choice', () => {
    skill(source()); const entry = apply({ kind: 'transfer', bindingId: binding().id, targetRootId: rootId('b'), mode: 'copy' });
    put(path.join(dir, 'b/hello/SKILL.md'), 'changed');
    const p = dispatch(engine, 'plan', { op: { kind: 'rollback', entryId: entry.id, force: true } }) as import('../../src/core/types').Plan;
    expect(p.conflict).toBeDefined();
  });
});

describe('documented status and transaction regressions', () => {
  it('reports priority shadowing only where scopes overlap', () => {
    skill(source()); skill(path.join(dir, 'extra/hello'));
    const first = adapters[0].roots(ctx, []);
    adapters[0].roots = () => [...first, root('a', { dir: path.join(dir, 'extra'), scope: 'user', priority: 10, rule: 'higher priority', source: { title: '', url: '' } })];
    const list = bindings();
    expect(list.find((b) => b.entryPath === source())?.status).toBe('conflict');
    expect(list.find((b) => b.entryPath.includes('extra'))?.status).toBe('unverified');
  });
  it('does not merge same-name Codex-style duplicates into one active winner', () => {
    skill(source()); skill(path.join(dir, 'extra/hello'));
    adapters[0].collision = 'duplicate';
    const first = adapters[0].roots(ctx, []);
    adapters[0].roots = () => [...first, root('a', { dir: path.join(dir, 'extra'), scope: 'user', priority: 10, rule: '', source: { title: '', url: '' } })];
    expect(bindings().every((b) => b.status === 'conflict')).toBe(true);
    expect(engine.scan().skills).toHaveLength(2);
  });
  it('keeps project-only skills with the same name separate across unrelated projects', () => {
    skill(source()); skill(path.join(dir, 'extra/hello'));
    adapters[0].roots = () => ['a', 'extra'].map((folder) => root('a', { dir: path.join(dir, folder), scope: 'project', project: path.join(dir, folder), priority: 1, rule: '', source: { title: '', url: '' } }));
    expect(bindings().every((b) => b.status === 'unverified')).toBe(true);
  });
  it('refuses invalid Codex selectors and Gemini global disable', () => {
    put(path.join(dir, '.codex/config.toml'), 'skills.config = [1]\n');
    const probe = { name: 'hello', entryPath: source(), skillMd: path.join(source(), 'SKILL.md'), realSkillMd: path.join(source(), 'SKILL.md'), root: adapters[0].roots(ctx, [])[0] };
    expect(codex.disableState!(ctx)(probe)?.ok).toBe(null);
    expect(codex.toggle!(ctx, probe, false).blockers.length).toBeGreaterThan(0);
    put(path.join(dir, '.gemini/settings.json'), '{"skills":{"enabled":false}}');
    expect(gemini.disableState!(ctx)(probe)?.ok).toBe(false);
    expect(gemini.toggle!(ctx, probe, true).blockers.length).toBeGreaterThan(0);
  });
  it('blocks project configuration writes during incomplete recovery', () => {
    put(path.join(ctx.dataDir, 'pending.json'), '{"id":"unfinished"}');
    expect(dispatch(engine, 'recoveryStatus')).toMatchObject({ pending: { id: 'unfinished' }, locked: false });
    expect(() => engine.addProject(dir)).toThrow('未完成');
    expect(() => engine.removeProject(dir)).toThrow('未完成');
  });
  it('handles cross-device copies and retains complete destination if source removal fails', () => {
    skill(source());
    const p = engine.plan({ kind: 'delete', bindingId: binding().id });
    const rename = fs.renameSync, rm = fs.rmSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === source()) throw Object.assign(new Error('different volume'), { code: 'EXDEV' });
      return rename(from, to);
    });
    vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === source()) throw new Error('source removal failure');
      return rm(target, options);
    });
    expect(() => engine.apply(p.id)).toThrow('跨卷复制已完成');
    const recovery = engine.recoveryStatus().pending as any;
    expect(fs.existsSync(path.join(recovery.next.backup, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(source())).toBe(true);
  });
});

it('enables one Codex path without enabling every same-name skill', () => {
  const file = path.join(dir, '.codex/config.toml');
  put(file, '# preserve\n[[skills.config]]\nname = "hello"\nenabled = false\n');
  const r = adapters[0].roots(ctx, [])[0];
  const probe = (md: string) => ({ name: 'hello', entryPath: path.dirname(md), skillMd: md, realSkillMd: md, root: r });
  const first = probe(path.join(dir, 'one/SKILL.md')), second = probe(path.join(dir, 'two/SKILL.md'));
  const edit = codex.toggle!(ctx, first, true);
  expect(edit.blockers).toEqual([]); put(file, edit.edits[0].content);
  expect(codex.disableState!(ctx)(first)).toBeNull();
  expect(codex.disableState!(ctx)(second)?.ok).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toContain('# preserve\n[[skills.config]]\nname = "hello"\nenabled = false');
});

it('reports unsupported OpenCode flat files explicitly alongside directory inventory', () => {
  const folder = path.join(dir, '.config/opencode/skills'); put(path.join(folder, 'flat.md'), '# Flat'); skill(path.join(folder, 'hello'));
  engine = new Engine(ctx, [{ ...opencode, roots: () => opencode.roots(ctx, []).filter((r) => r.dir.startsWith(dir + path.sep)) }]);
  const inventory = engine.scan();
  expect(inventory.roots.find((r) => r.dir === folder)?.error).toContain('flat.md');
  expect(inventory.skills.some((s) => s.dirName === 'hello')).toBe(true);
});

it('preserves qualified Claude nested names and marks their loading as unverified', () => {
  const repo = path.join(dir, 'repo'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  skill(path.join(repo, 'apps/web/.claude/skills/hello'));
  const spec = claude.roots(ctx, [{ path: repo, nested: true }]).find((r) => r.lazy)!;
  expect(spec.namespace).toBe('apps/web'); expect(spec.project).toBe(path.join(repo, 'apps/web'));
});

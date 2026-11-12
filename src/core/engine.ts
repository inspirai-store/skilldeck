import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { ArchiveMeta, Binding, Change, Ctx, Inventory, Issue, JournalEntry, Op, Plan, RootSpec, ScanDirectory, SkillRecord, Step } from './types';
import { ADAPTERS, type Adapter } from './adapters';
import type { Probe } from './adapters/base';
import { loadConfig, saveConfig } from './config';
import { SPEC_NAME, buildSkillMd, parseSkillMd, validateSkill, renameSkillMd } from './frontmatter';
import { MARKER_FILE, SKILL_FILE, type ScanResult, archiveDir, listArchives, scan } from './scanner';
import { fingerprint, hashId, linkDir, lstatSafe, movePath, newId, pathKey, readJson, readText, realSafe, statSafe, walk, writeAtomic, pathIdentity, realFuture } from './util';

type PlanStep = Step & { basis?: string; detail?: string };

interface Draft {
  kind: string;
  title: string;
  steps: PlanStep[];
  warnings: Issue[];
  blockers: string[];
  conflict?: Plan['conflict'];
  rollbackOf?: string;
}

interface Stored {
  plan: Plan;
  draft: Draft;
  pre: Record<string, string>;
  identities: Record<string, string>;
}

const SENSITIVE = [/^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|keystore)$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/i, /credential/i, /secret/i, /^\.npmrc$/i, /^auth\.json$/i, /token/i];

const warn = (text: string, code = 'warn'): Issue => ({ level: 'warn', code, text });
const info = (text: string, code = 'info'): Issue => ({ level: 'info', code, text });

function diffText(file: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(file, file, before, after, '', '', { context: 3 });
  return patch.split('\n').slice(4).join('\n').trimEnd();
}

function stepPaths(s: Step): string[] {
  switch (s.type) {
    case 'move':
    case 'copy':
      return [s.from, s.to];
    case 'link':
      return [s.path, s.target];
    default:
      return [s.path];
  }
}

/** Removing/moving a symlink mutates the link entry, not the protected target. */
function protectedWrites(steps: Step[], directories: string[]): string[] {
  const blocked: string[] = [];
  for (const step of steps) {
    const writes = step.type === 'copy' ? [step.to] : step.type === 'link' ? [step.path] : step.type === 'move' ? [step.from, step.to] : [step.path];
    for (const p of writes) {
      const linkEntry = (step.type === 'trash' || step.type === 'move') && lstatSafe(p)?.isSymbolicLink();
      const at = linkEntry ? path.join(realFuture(path.dirname(p)), path.basename(p)) : realFuture(p);
      if (directories.some((dir) => at === dir || at.startsWith(dir + path.sep) || ((step.type === 'trash' || step.type === 'move') && dir.startsWith(at + path.sep)))) blocked.push(p);
    }
  }
  return blocked;
}

export class Engine {
  private last: ScanResult | null = null;
  private plans = new Map<string, Stored>();

  constructor(
    readonly ctx: Ctx,
    private adapters: Adapter[] = ADAPTERS,
  ) {}

  scan(): Inventory {
    this.last = scan(this.ctx, loadConfig(this.ctx), this.adapters);
    return this.last.inventory;
  }

  private get inv(): Inventory {
    return (this.last || (this.scan(), this.last!)).inventory;
  }

  private adapter(id: string): Adapter {
    const a = this.adapters.find((x) => x.id === id);
    if (!a) throw new Error(`未知智能体：${id}`);
    return a;
  }

  private root(id: string): RootSpec {
    const r = this.last?.rootsById.get(id);
    if (!r) throw new Error('目标目录不在扫描范围内');
    return r;
  }

  private find(bindingId: string): { rec: SkillRecord; b: Binding } {
    for (const rec of this.inv.skills) {
      const b = rec.bindings.find((x) => x.id === bindingId);
      if (b) return { rec, b };
    }
    throw new Error('该 Skill 已不存在，请重新扫描');
  }

  private probe(rec: SkillRecord, b: Binding): Probe {
    const root = this.root(b.rootId);
    const name = root.namespace ? b.invocableName.slice(root.namespace.length + 1) : b.invocableName;
    return { name, entryPath: b.entryPath, skillMd: path.join(b.entryPath, SKILL_FILE), realSkillMd: path.join(rec.realPath, SKILL_FILE), root };
  }

  private agentName(id: string): string {
    return this.adapters.find((a) => a.id === id)?.name || id;
  }

  /** Other places that resolve to the same folder and will feel a change made through `b`. */
  private sharers(rec: SkillRecord, b: Binding): Binding[] {
    return rec.bindings.filter((x) => x.id !== b.id && x.status !== 'archived');
  }

  private dependents(rec: SkillRecord, b: Binding): Issue[] {
    if (b.isSymlink) return [];
    const out: Issue[] = [];
    const same = this.sharers(rec, b).filter((x) => pathKey(x.entryPath) === pathKey(b.entryPath));
    const links = [...new Set(this.sharers(rec, b).filter((x) => pathKey(x.entryPath) !== pathKey(b.entryPath)).map((x) => x.entryPath))];
    if (same.length) out.push(warn(`该目录同时被 ${[...new Set(same.map((x) => this.agentName(x.agent)))].join('、')} 读取，将一并受影响`, 'shared'));
    if (links.length) out.push(warn(`${links.length} 个符号链接指向此目录，操作后将失效：${links.join('、')}`, 'dangling'));
    return out;
  }

  // ---- planning -----------------------------------------------------------

  plan(op: Op): Plan {
    fs.mkdirSync(this.ctx.dataDir, { recursive: true, mode: 0o700 });
    this.scan();
    const draft = this.build(op);
    for (const step of draft.steps) for (const p of stepPaths(step)) {
      const at = realFuture(p), data = realFuture(this.ctx.dataDir);
      if (at === data && step.type !== 'mkdir') draft.blockers.push('操作目标不能是应用数据目录');
      if ((data + path.sep).startsWith(at + path.sep) && step.type !== 'mkdir') draft.blockers.push('操作涉及应用数据目录的祖先，禁止执行');
    }
    const protectedDirs = [...this.last!.rootsById.values()].filter((r) => r.readOnly).map((r) => realFuture(r.dir));
    for (const p of protectedWrites(draft.steps, protectedDirs)) draft.blockers.push(`操作涉及已知只读来源：${p}`);
    // Content edits and marker toggles affect every binding of a shared entity.
    if (op.kind === 'delete' || op.kind === 'archive' || (op.kind === 'transfer' && op.mode === 'move')) {
      const { rec, b } = this.find(op.bindingId);
      if (!b.isSymlink && rec.bindings.some((x) => x.readOnly)) draft.blockers.push('实体含只读绑定，禁止移动或删除');
    }
    if (op.kind === 'edit' || op.kind === 'toggle') {
      const { rec, b } = this.find(op.bindingId);
      if ((op.kind === 'edit' || b.toggle !== 'official') && rec.bindings.some((x) => x.readOnly)) draft.blockers.push('同一实体包含只读绑定，禁止通过其他绑定修改');
    }
    const pre: Record<string, string> = {};
    const changes: Change[] = [];
    const present = new Map<string, boolean>();
    const exists = (p: string) => present.get(pathKey(p)) ?? !!lstatSafe(p);
    const set = (p: string, v: boolean) => present.set(pathKey(p), v);

    for (const s of draft.steps) {
      for (const p of stepPaths(s)) if (!(p in pre)) pre[p] = fingerprint(p);
      switch (s.type) {
        case 'write': {
          if (lstatSafe(s.path)?.isSymbolicLink()) draft.blockers.push(`文件本身是符号链接，禁止静默替换：${s.path}`);
          const had = exists(s.path);
          const before = had ? (readText(s.path) ?? readText(s.basis || '') ?? '') : s.basis ? (readText(s.basis) ?? '') : '';
          changes.push({ action: had || s.basis ? 'modify' : 'create', path: s.path, diff: diffText(path.basename(s.path), before, s.content), detail: s.detail });
          set(s.path, true);
          break;
        }
        case 'move':
        case 'copy':
          if (!exists(s.from)) draft.blockers.push(`源不存在：${s.from}`);
          if (exists(s.to)) draft.blockers.push(`目标已存在，不会覆盖：${s.to}`);
          changes.push({ action: s.type, path: s.from, to: s.to, detail: s.detail });
          if (s.type === 'move') set(s.from, false);
          set(s.to, true);
          break;
        case 'link':
          if (exists(s.path)) draft.blockers.push(`目标已存在，不会覆盖：${s.path}`);
          changes.push({ action: 'link', path: s.path, to: s.target, detail: s.detail });
          set(s.path, true);
          break;
        case 'trash':
          if (!exists(s.path)) draft.blockers.push(`路径不存在：${s.path}`);
          changes.push({ action: 'delete', path: s.path, detail: s.detail || '移入备份' });
          set(s.path, false);
          break;
        case 'mkdir':
          if (!exists(s.path)) changes.push({ action: 'create', path: s.path, detail: '目录' });
          set(s.path, true);
          break;
        case 'rmdir':
          break;
      }
    }
    if (!draft.steps.length && !draft.blockers.length && !draft.conflict) draft.blockers.push('没有需要修改的内容');
    const plan: Plan = {
      id: newId('plan'),
      kind: draft.kind,
      title: draft.title,
      changes,
      warnings: draft.warnings,
      blockers: [...new Set(draft.blockers)],
      conflict: draft.conflict,
      backup: draft.steps.some((s) => s.type === 'trash' || s.type === 'write'),
    };
    // Bind all inputs and outputs to the same ancestor objects observed at preview.
    const identities = Object.fromEntries(Object.keys(pre).map((p) => [p, pathIdentity(p)]));
    this.plans.set(plan.id, { plan, draft, pre, identities });
    if (this.plans.size > 40) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }

  private build(op: Op): Draft {
    const d: Draft = { kind: op.kind, title: '', steps: [], warnings: [], blockers: [] };
    switch (op.kind) {
      case 'import':
        return this.buildImport(op, d);
      case 'create':
        return this.buildCreate(op, d);
      case 'edit':
        return this.buildEdit(op, d);
      case 'delete': {
        const { rec, b } = this.find(op.bindingId);
        d.title = `删除 ${rec.name}`;
        if (b.status === 'archived') return this.build({ kind: 'purge', archiveId: b.archiveId! });
        if (b.readOnly) d.blockers.push('该位置由智能体或管理员托管，只读');
        d.steps.push({ type: 'trash', path: b.entryPath, detail: b.isSymlink ? '仅移除符号链接，目标保留' : '整个目录移入备份，可回滚' });
        d.warnings.push(...this.dependents(rec, b));
        return d;
      }
      case 'toggle':
        return this.buildToggle(op, d);
      case 'archive': {
        const { rec, b } = this.find(op.bindingId);
        d.title = `归档 ${rec.name}`;
        if (b.readOnly) d.blockers.push('该位置由智能体或管理员托管，只读');
        if (b.status === 'archived') { d.blockers.push('已经归档'); return d; }
        const root = this.root(b.rootId);
        const id = newId('arc');
        const meta: ArchiveMeta = {
          id,
          time: Date.now(),
          agent: b.agent,
          rootId: b.rootId,
          rootDir: root.singleSkill ? path.dirname(b.entryPath) : root.dir,
          scope: b.scope,
          project: b.project,
          originPath: b.entryPath,
          dirName: path.basename(b.entryPath),
          wasSymlink: b.isSymlink,
          linkTarget: b.isSymlink ? rec.realPath : undefined,
        };
        const dir = path.join(archiveDir(this.ctx), id);
        d.steps.push({ type: 'write', path: path.join(dir, 'meta.json'), content: JSON.stringify(meta, null, 2) + '\n', detail: '归档记录' });
        d.steps.push({ type: 'move', from: b.entryPath, to: path.join(dir, 'payload'), detail: b.isSymlink ? '仅移动符号链接，目标保留' : undefined });
        d.warnings.push(...this.dependents(rec, b));
        return d;
      }
      case 'restore':
        return this.buildRestore(op, d);
      case 'purge': {
        const meta = listArchives(this.ctx).find((m) => m.id === op.archiveId);
        if (!meta) throw new Error('归档不存在');
        d.title = `删除归档 ${meta.dirName}`;
        d.steps.push({ type: 'trash', path: path.join(archiveDir(this.ctx), meta.id), detail: '移入备份，可回滚' });
        return d;
      }
      case 'transfer':
        return this.buildTransfer(op, d);
      case 'rollback':
        return this.buildRollback(op, d);
    }
  }

  private buildImport(op: Extract<Op, { kind: 'import' }>, d: Draft): Draft {
    const target = this.root(op.rootId);
    const source = realSafe(op.sourcePath);
    d.title = '导入本地 Skill';
    if (target.singleSkill) d.blockers.push('该登记代表单个 Skill，不能作为集合安装目标');
    if (target.readOnly) d.blockers.push('目标目录只读');
    if (!path.isAbsolute(op.sourcePath) || !source || !statSafe(source)?.isDirectory()) {
      d.blockers.push('来源必须为存在的绝对目录'); return d;
    }
    const name = op.newName || path.basename(source);
    if (!SPEC_NAME.test(name) || name.length > 64) d.blockers.push('目录名需为 1–64 位小写字母、数字与单连字符');
    const text = readText(path.join(source, SKILL_FILE));
    if (text == null) { d.blockers.push('来源缺少可读的 SKILL.md'); return d; }
    d.blockers.push(...validateSkill(parseSkillMd(text), name, this.adapter(target.agent).rules).filter((i) => i.level === 'error').map((i) => i.text));
    const parent = realFuture(target.dir);
    if (parent === source || (parent + path.sep).startsWith(source + path.sep)) d.blockers.push('目标位于来源目录内');
    const dest = path.join(target.dir, name);
    if (lstatSafe(dest)) d.blockers.push('目标已存在，不会覆盖');
    if (d.blockers.length) return d;
    d.steps.push({ type: 'mkdir', path: target.dir }, { type: 'copy', from: source, to: dest });
    if (op.newName && typeof parseSkillMd(text).data?.name === 'string') d.steps.push({ type: 'write', path: path.join(dest, SKILL_FILE), content: renameSkillMd(text, name), basis: path.join(source, SKILL_FILE) });
    d.warnings.push(warn('完整复制目录（包括隐藏文件与符号链接）；导入前请核对脚本、凭据和外部链接', 'import-review'));
    d.warnings.push(...this.nameClash(this.adapter(target.agent), target, name, null));
    return d;
  }

  private buildCreate(op: Extract<Op, { kind: 'create' }>, d: Draft): Draft {
    const root = this.root(op.rootId);
    const ad = this.adapter(root.agent);
    const name = op.name.trim();
    d.title = `新建 ${name || 'Skill'}`;
    if (root.singleSkill) d.blockers.push('该登记代表单个 Skill，不能新建子 Skill');
    if (root.readOnly) d.blockers.push('该目录只读');
    if (!SPEC_NAME.test(name) || name.length > 64) d.blockers.push('名称需为 1–64 位小写字母、数字与单连字符');
    if (!op.description.trim()) d.blockers.push('描述不能为空');
    if (op.description.length > 1024) d.blockers.push('描述超过 1024 字符');
    if (d.blockers.length) return d;
    const dest = path.join(root.dir, name);
    if (lstatSafe(dest)) {
      d.blockers.push(`已存在同名目录：${dest}`);
      return d;
    }
    d.steps.push({ type: 'mkdir', path: dest }, { type: 'write', path: path.join(dest, SKILL_FILE), content: buildSkillMd(name, op.description.trim(), op.body || `# ${name}\n`) });
    d.warnings.push(...this.nameClash(ad, root, name, null));
    return d;
  }

  private nameClash(ad: Adapter, root: RootSpec, name: string, skipReal: string | null): Issue[] {
    const hits: string[] = [];
    for (const rec of this.inv.skills) {
      if (skipReal && pathKey(rec.realPath) === pathKey(skipReal)) continue;
      for (const b of rec.bindings) {
        if (b.agent !== ad.id || b.status === 'archived' || b.status === 'invalid' || b.status === 'unknown') continue;
        if (b.invocableName.toLowerCase() !== name.toLowerCase()) continue;
        if (b.project && root.project && b.project !== root.project) continue;
        hits.push(b.entryPath);
      }
    }
    if (!hits.length) return [];
    const how = ad.collision === 'priority' ? '按优先级只有一个生效' : ad.collision === 'duplicate' ? '两者会并存且重复出现' : '取舍规则未文档化';
    return [warn(`${ad.name} 中已有同名 Skill（${hits.join('、')}），${how}`, 'name-clash')];
  }

  private buildEdit(op: Extract<Op, { kind: 'edit' }>, d: Draft): Draft {
    const { rec, b } = this.find(op.bindingId);
    d.title = `编辑 ${rec.name}`;
    if (b.readOnly) d.blockers.push('该位置由智能体或管理员托管，只读');
    if (b.status === 'archived') d.blockers.push('请先恢复归档');
    const file = path.join(rec.realPath, rec.markerDisabled ? MARKER_FILE : SKILL_FILE);
    if (!rec.hasSkillMd && !rec.markerDisabled) d.blockers.push('源目录没有可编辑的 Skill 文件');
    if (lstatSafe(file)?.isSymbolicLink()) d.blockers.push('SKILL.md 自身为符号链接，禁止替换链接');
    const cur = readText(file);
    if (cur == null && rec.hasSkillMd) d.blockers.push('SKILL.md 无法读取');
    if (cur === op.content) return d;
    d.steps.push({ type: 'write', path: file, content: op.content });
    const parsed = parseSkillMd(op.content);
    const seen = new Set<string>();
    for (const x of rec.bindings) {
      if (x.status === 'archived') continue;
      for (const i of validateSkill(parsed, rec.dirName, this.adapter(x.agent).rules)) {
        if (i.level === 'info') continue;
        const text = i.level === 'error' ? `${this.agentName(x.agent)} 将无法加载：${i.text}` : i.text;
        if (!seen.has(text)) d.warnings.push({ ...i, level: 'warn', text });
        seen.add(text);
      }
    }
    const others = this.sharers(rec, b);
    if (others.length) d.warnings.push(info(`同一文件还被 ${[...new Set(others.map((x) => this.agentName(x.agent)))].join('、')} 读取（共 ${others.length} 个位置）`, 'shared'));
    return d;
  }

  private buildToggle(op: Extract<Op, { kind: 'toggle' }>, d: Draft): Draft {
    const { rec, b } = this.find(op.bindingId);
    d.title = `${op.enable ? '启用' : '禁用'} ${rec.name} · ${this.agentName(b.agent)}`;
    if (b.readOnly) {
      d.blockers.push('该位置由智能体或管理员托管，只读');
      return d;
    }
    const others = this.sharers(rec, b);
    const shared = others.length ? [warn(`通过文件标记切换，同一目录的其余 ${others.length} 个位置（${[...new Set(others.map((x) => this.agentName(x.agent)))].join('、')}）同时受影响`, 'shared')] : [];
    if (b.status === 'archived') { d.blockers.push('请先恢复归档'); return d; }
    if (rec.markerDisabled) {
      if (!op.enable) return d;
      d.steps.push({ type: 'move', from: path.join(rec.realPath, MARKER_FILE), to: path.join(rec.realPath, SKILL_FILE), detail: '恢复 SKILL.md' });
      d.warnings.push(...shared);
      if (this.adapter(b.agent).toggle && this.root(b.rootId).sourceKind !== 'custom' && !this.root(b.rootId).namespace) {
        const result = this.adapter(b.agent).toggle!(this.ctx, this.probe(rec, b), true);
        d.blockers.push(...result.blockers);
        for (const e of result.edits) d.steps.push({ type: 'write', path: e.path, content: e.content });
      }
      return d;
    }
    if (b.toggle === 'official') {
      const ad = this.adapter(b.agent);
      d.warnings.push(info('修改的是持久配置；请按智能体规则重启、重新加载或开启新会话后核实', 'reload-required'));
      d.warnings.push(warn('名称开关或用户级配置可能影响同一智能体中的其他同名绑定与项目', 'config-scope'));
      const r = ad.toggle!(this.ctx, this.probe(rec, b), op.enable);
      d.blockers.push(...r.blockers);
      for (const e of r.edits) d.steps.push({ type: 'write', path: e.path, content: e.content, detail: ad.toggleRule });
      return d;
    }
    if (b.toggle === 'marker' && !op.enable) {
      d.steps.push({ type: 'move', from: path.join(rec.realPath, SKILL_FILE), to: path.join(rec.realPath, MARKER_FILE), detail: `${this.agentName(b.agent)} 无官方开关，改用文件标记` });
      d.warnings.push(...shared);
      return d;
    }
    if (b.toggle === 'none') d.blockers.push('此位置不支持启用或禁用，可改用归档');
    return d;
  }

  private buildRestore(op: Extract<Op, { kind: 'restore' }>, d: Draft): Draft {
    const meta = listArchives(this.ctx).find((m) => m.id === op.archiveId);
    if (!meta) throw new Error('归档不存在');
    d.title = `恢复 ${meta.dirName}`;
    if (this.last?.rootsById.get(meta.rootId)?.readOnly || ['system', 'admin', 'plugin'].includes(meta.scope)) {
      d.blockers.push('原位置现在是只读或托管范围，禁止恢复写入'); return d;
    }
    let dest = meta.originPath;
    if (op.choice === 'rename') {
      const n = (op.newName || '').trim();
      if (!SPEC_NAME.test(n) || n.length > 64) {
        d.blockers.push('新名称需为 1–64 位小写字母、数字与单连字符');
        return d;
      }
      dest = path.join(path.dirname(meta.originPath), n);
    }
    if (lstatSafe(dest)) {
      d.conflict = { text: `原位置已被占用：${dest}`, choices: [{ id: 'rename', label: '改名恢复' }] };
      return d;
    }
    const dir = path.join(archiveDir(this.ctx), meta.id);
    d.steps.push({ type: 'move', from: path.join(dir, 'payload'), to: dest }, { type: 'trash', path: path.join(dir, 'meta.json'), detail: '归档记录' }, { type: 'rmdir', path: dir });
    if (meta.wasSymlink && meta.linkTarget && !statSafe(meta.linkTarget)) d.warnings.push(warn(`符号链接目标已不存在：${meta.linkTarget}`, 'dangling'));
    return d;
  }

  private buildTransfer(op: Extract<Op, { kind: 'transfer' }>, d: Draft): Draft {
    const { rec, b } = this.find(op.bindingId);
    const target = this.root(op.targetRootId);
    const ad = this.adapter(target.agent);
    const verb = op.mode === 'copy' ? '复制' : op.mode === 'move' ? '迁移' : '链接';
    d.title = `${verb} ${rec.name} → ${ad.name}`;
    if (target.singleSkill) d.blockers.push('该登记代表单个 Skill，不能作为集合安装目标');
    if (target.readOnly) d.blockers.push('目标目录只读');
    if (b.status === 'archived') d.blockers.push('请先恢复归档');
    if (!rec.hasSkillMd && !rec.markerDisabled) d.blockers.push('源目录没有 SKILL.md');
    if (op.mode === 'move' && b.readOnly) d.blockers.push('源位置只读，只能复制');
    let name = path.basename(b.entryPath);
    const renamed = op.choice === 'rename';
    if (renamed) {
      name = (op.newName || '').trim();
      if (!SPEC_NAME.test(name) || name.length > 64) d.blockers.push('新名称需为 1–64 位小写字母、数字与单连字符');
    }
    if (d.blockers.length) return d;
    const dest = path.join(target.dir, name);
    const resolvedParent = realFuture(target.dir);
    if ((resolvedParent + path.sep).startsWith(rec.realPath + path.sep) || resolvedParent === rec.realPath) {
      d.blockers.push('目标位于源目录内'); return d;
    }
    if (op.mode === 'link' && b.readOnly) { d.blockers.push('只读来源只能复制，链接会暴露可写绑定'); return d; }
    if ((rec.realPath + path.sep).startsWith(realFuture(dest) + path.sep)) { d.blockers.push('目标包含源目录，禁止替换其祖先'); return d; }
    if (pathKey(dest) === pathKey(b.entryPath) || pathKey(realSafe(dest) || dest) === pathKey(rec.realPath)) {
      d.blockers.push('目标位置已是该 Skill');
      return d;
    }
    if (lstatSafe(dest)) {
      if (op.choice !== 'replace') {
        d.conflict = {
          text: `目标已存在同名条目：${dest}`,
          choices: [
            { id: 'rename', label: '改名' },
            { id: 'replace', label: '替换并备份现有内容' },
          ],
        };
        return d;
      }
      d.steps.push({ type: 'trash', path: dest, detail: '被替换的现有内容移入备份' });
    }

    if (op.mode === 'link') {
      d.steps.push({ type: 'mkdir', path: target.dir }, { type: 'link', target: rec.realPath, path: dest });
    } else if (op.mode === 'move' && !b.isSymlink) {
      d.steps.push({ type: 'mkdir', path: target.dir }, { type: 'move', from: b.entryPath, to: dest });
      d.warnings.push(...this.dependents(rec, b));
    } else {
      d.steps.push({ type: 'mkdir', path: target.dir }, { type: 'copy', from: rec.realPath, to: dest });
      if (op.mode === 'move') d.steps.push({ type: 'trash', path: b.entryPath, detail: '移除源符号链接，目标保留' });
    }

    const mdName = rec.markerDisabled ? MARKER_FILE : SKILL_FILE;
    const srcMd = path.join(rec.realPath, mdName);
    let text = readText(srcMd) ?? '';
    if (renamed && op.mode !== 'link' && typeof rec.frontmatter?.name === 'string') {
      const next = renameSkillMd(text, name);
      if (next !== text) {
        d.steps.push({ type: 'write', path: path.join(dest, mdName), content: next, basis: srcMd, detail: 'name 与新目录名保持一致' });
        text = next;
      }
    }
    if (renamed && op.mode === 'link') d.warnings.push(warn('链接模式下 name 仍为原名，与新目录名不一致', 'name-dir'));

    // ---- compatibility ----
    const parsed = parseSkillMd(text);
    for (const i of validateSkill(parsed, name, ad.rules)) {
      if (i.level === 'error') d.warnings.push(warn(`${ad.name} 将无法加载：${i.text}`, i.code));
      else if (i.code === 'unknown-fields') d.warnings.push(info(`${ad.name} 的当前适配器未核实这些字段：${i.text.replace('未识别字段：', '')}`, i.code));
      else d.warnings.push({ ...i, level: 'warn' });
    }
    if (b.agent !== ad.id) {
      if (ad.id !== 'claude') {
        const feats: string[] = [];
        if (/\$ARGUMENTS|\$\{?CLAUDE_[A-Z_]+\}?/.test(parsed.body)) feats.push('$ARGUMENTS / ${CLAUDE_*} 变量');
        if (/!`[^`]+`/.test(parsed.body)) feats.push('!`命令` 动态注入');
        if (parsed.data?.hooks) feats.push('hooks');
        if (parsed.data?.context === 'fork') feats.push('context: fork');
        if (feats.length) d.warnings.push(warn(`包含 Claude Code 专有特性，${ad.name} 中不会生效：${feats.join('、')}`, 'claude-only'));
      }
      if (ad.id !== 'codex' && statSafe(path.join(rec.realPath, 'agents', 'openai.yaml'))) d.warnings.push(info('agents/openai.yaml 为 Codex 专有元数据', 'codex-only'));
      const srcRoot = path.dirname(b.entryPath);
      const tildeRoot = srcRoot.startsWith(this.ctx.home) ? '~' + srcRoot.slice(this.ctx.home.length) : srcRoot;
      if (op.mode !== 'link' && (parsed.body.includes(srcRoot) || parsed.body.includes(tildeRoot.split(path.sep).join('/')))) {
        d.warnings.push(warn(`正文引用了源目录路径 ${tildeRoot}，复制后不会自动改写`, 'abs-path'));
      }
    }
    if (target.confidence === 'observed') d.warnings.push(info('目标目录的发现规则未经官方文档核实', 'unverified-root'));
    if (target.lazy) d.warnings.push(info('目标目录为按需加载', 'lazy'));
    const already = rec.bindings.find((x) => x.agent === ad.id && x.status !== 'archived' && x.id !== b.id);
    if (already && op.mode !== 'move') d.warnings.push(info(`${ad.name} 已能通过 ${already.entryPath} 读取该 Skill`, 'already-visible'));
    d.warnings.push(...this.nameClash(ad, target, name, op.mode === 'copy' ? null : rec.realPath).filter(() => !(op.choice === 'replace')));
    if (op.mode !== 'link') {
      const hits: string[] = [];
      walk(rec.realPath, (rel, st) => {
        if (!st.isDirectory() && SENSITIVE.some((re) => re.test(path.basename(rel)))) hits.push(rel);
      });
      if (hits.length) d.warnings.push(warn(`包含疑似敏感文件，将一并复制：${hits.slice(0, 6).join('、')}${hits.length > 6 ? ' 等' : ''}`, 'sensitive'));
    }
    if (rec.hasScripts) d.warnings.push(info('包含 scripts/ 目录，脚本的运行环境需在目标智能体中自行确认', 'scripts'));
    return d;
  }

  private buildRollback(op: Extract<Op, { kind: 'rollback' }>, d: Draft): Draft {
    const entry = this.history().find((e) => e.id === op.entryId);
    if (!entry) throw new Error('操作记录不存在');
    d.title = `回滚：${entry.title}`;
    d.rollbackOf = entry.id;
    if (entry.status !== 'applied' || entry.rollbackOf) {
      d.blockers.push('该记录不可回滚');
      return d;
    }
    for (const s of entry.steps) {
      if ((s.type === 'write' || s.type === 'trash') && s.backup && (!lstatSafe(s.backup) || (entry.post[s.backup] && fingerprint(s.backup) !== entry.post[s.backup]))) d.blockers.push(`备份缺失或已变化：${s.backup}`);
    }
    const drift = Object.entries(entry.post).filter(([p, fp]) => fingerprint(p) !== fp).map(([p]) => p);
    if (drift.length && !op.force) {
      d.conflict = { text: `以下内容在操作后又被修改，回滚会丢弃这些修改（修改会先备份）：${drift.join('、')}`, choices: [{ id: 'force', label: '仍然回滚' }] };
      return d;
    }
    for (const s of [...entry.steps].reverse()) {
      switch (s.type) {
        case 'mkdir':
          d.steps.push({ type: 'rmdir', path: s.path });
          break;
        case 'rmdir':
          d.steps.push({ type: 'mkdir', path: s.path });
          break;
        case 'write':
          if (s.existed && s.backup) d.steps.push({ type: 'write', path: s.path, content: fs.readFileSync(s.backup, 'utf8') });
          else d.steps.push({ type: 'trash', path: s.path, detail: '移除新建的文件' });
          break;
        case 'move':
          if (op.force && lstatSafe(s.from)) d.steps.push({ type: 'trash', path: s.from, detail: '回滚前备份现有内容' });
          d.steps.push({ type: 'move', from: s.to, to: s.from });
          break;
        case 'copy':
          d.steps.push({ type: 'trash', path: s.to, detail: '移除复制出的副本' });
          break;
        case 'link':
          d.steps.push({ type: 'trash', path: s.path, detail: '移除符号链接' });
          break;
        case 'trash':
          if (s.backup) d.steps.push({ type: 'move', from: s.backup, to: s.path, detail: '从备份还原' });
          break;
      }
    }
    return d;
  }

  // ---- applying -----------------------------------------------------------

  private withMutation<T>(action: () => T): T {
    fs.mkdirSync(this.ctx.dataDir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.ctx.dataDir, 'mutation.lock');
    try { fs.mkdirSync(lock); } catch { throw new Error('有其他写操作或上次操作未正常退出，请检查 mutation.lock 和 pending.json'); }
    try {
      if (lstatSafe(path.join(this.ctx.dataDir, 'pending.json'))) throw new Error('存在未完成操作，请检查 pending.json 与备份后恢复');
      return action();
    } finally { fs.rmdirSync(lock); }
  }

  apply(planId: string): JournalEntry {
    return this.withMutation(() => this.applyLocked(planId));
  }

  private applyLocked(planId: string): JournalEntry {
    const st = this.plans.get(planId);
    if (!st) throw new Error('预览已过期，请重新生成');
    this.plans.delete(planId);
    if (st.plan.blockers.length || st.plan.conflict) throw new Error('计划存在未解决的冲突');
    for (const [p, fp] of Object.entries(st.pre)) {
      if (fingerprint(p) !== fp || pathIdentity(p) !== st.identities[p]) throw new Error(`预览后文件已变化，已取消：${p}`);
    }
    this.scan();
    const protectedDirs = [...this.last!.rootsById.values()].filter((r) => r.readOnly).map((r) => realFuture(r.dir));
    if (protectedWrites(st.draft.steps, protectedDirs).length) throw new Error('当前扫描来源包含只读保护，请重新预览');
    this.history();
    const id = newId('op');
    const backupDir = path.join(this.ctx.dataDir, 'backups', id);
    const done: Step[] = [];
    let n = 0;
    const slot = (p: string) => path.join(backupDir, String(n++), path.basename(p));
    const pending = path.join(this.ctx.dataDir, 'pending.json');
    const persist = (next?: PlanStep) => writeAtomic(pending, JSON.stringify({ id, backupDir, done, next }, null, 2));
    try {
      for (const raw of st.draft.steps) {
        persist(raw);
        const { basis: _b, detail: _d, ...s } = raw as PlanStep & Record<string, unknown>;
        const step = s as Step;
        switch (step.type) {
          case 'mkdir': {
            // Remember the topmost directory we create so rollback can remove exactly that.
            let top = step.path;
            while (!lstatSafe(path.dirname(top)) && path.dirname(top) !== top) top = path.dirname(top);
            const created = !lstatSafe(step.path);
            fs.mkdirSync(step.path, { recursive: true });
            if (created) done.push({ type: 'mkdir', path: top });
            break;
          }
          case 'rmdir':
            this.rmEmpty(step.path);
            done.push(step);
            break;
          case 'write': {
            const existed = !!lstatSafe(step.path);
            let backup: string | undefined;
            if (existed) {
              backup = slot(step.path);
              fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
              fs.copyFileSync(step.path, backup);
              persist({ ...step, existed, backup });
            }
            fs.mkdirSync(path.dirname(step.path), { recursive: true });
            writeAtomic(step.path, step.content);
            done.push({ ...step, existed, backup });
            break;
          }
          case 'move':
            if (lstatSafe(step.to)) throw new Error(`目标已存在：${step.to}`);
            movePath(step.from, step.to);
            done.push(step);
            break;
          case 'copy':
            if (lstatSafe(step.to)) throw new Error(`目标已存在：${step.to}`);
            done.push(step);
            fs.cpSync(step.from, step.to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
            break;
          case 'link':
            if (lstatSafe(step.path)) throw new Error(`目标已存在：${step.path}`);
            linkDir(step.target, step.path, this.ctx.platform);
            done.push(step);
            break;
          case 'trash': {
            const backup = slot(step.path);
            persist({ ...step, backup });
            movePath(step.path, backup);
            done.push({ ...step, backup });
            break;
          }
        }
      }
      persist();
    } catch (e) {
      if ((e as any)?.recoveryRequired) throw e;
      const failures = this.undo(done);
      if (!failures.length) fs.rmSync(pending, { force: true });
      throw new Error(`${String(e)}${failures.length ? '; 自动恢复失败：' + failures.join('; ') : ''}`);
    }
    try {
      const post: Record<string, string> = {};
      for (const s of done) {
        for (const p of s.type === 'link' ? [s.path] : stepPaths(s)) post[p] = fingerprint(p);
        if ((s.type === 'write' || s.type === 'trash') && s.backup) post[s.backup] = fingerprint(s.backup);
      }
      const entry: JournalEntry = { id, time: Date.now(), kind: st.draft.kind, title: st.draft.title, steps: done, post, status: 'applied', rollbackOf: st.draft.rollbackOf };
      const all = this.history();
      if (entry.rollbackOf) {
        const orig = all.find((e) => e.id === entry.rollbackOf);
        if (orig) orig.status = 'rolledBack';
      }
      all.unshift(entry);
      this.saveHistory(all);
      fs.rmSync(pending, { force: true });
      return entry;
    } catch (e) {
      // If the journal committed, leave pending evidence and do not undo a committed operation.
      if (this.history().some((x) => x.id === id)) throw e;
      const failures = this.undo(done);
      if (!failures.length) fs.rmSync(pending, { force: true });
      throw new Error(`操作日志保存失败：${String(e)}；恢复错误：${failures.join('; ')}`);
    } finally { this.last = null; }
  }

  private rmEmpty(dir: string): void {
    try {
      const names = fs.readdirSync(dir);
      for (const n of names) {
        const p = path.join(dir, n);
        if (lstatSafe(p)?.isDirectory()) this.rmEmpty(p);
      }
      fs.rmdirSync(dir);
    } catch {}
  }

  /** Best-effort reversal of a partially applied plan. */
  private undo(done: Step[]): string[] {
    const errors: string[] = [];
    for (const s of [...done].reverse()) {
      try {
        if (s.type === 'mkdir') this.rmEmpty(s.path);
        else if (s.type === 'write') s.existed && s.backup ? fs.copyFileSync(s.backup, s.path) : fs.rmSync(s.path, { force: true });
        else if (s.type === 'move') movePath(s.to, s.from);
        else if (s.type === 'copy') fs.rmSync(s.to, { recursive: true, force: true });
        else if (s.type === 'link') fs.unlinkSync(s.path);
        else if (s.type === 'trash' && s.backup) movePath(s.backup, s.path);
      } catch (e) { errors.push(String(e)); }
    }
    return errors;
  }

  // ---- journal, reading, config -------------------------------------------

  private journalFile(): string {
    return path.join(this.ctx.dataDir, 'journal.json');
  }

  recoveryStatus(): { pending: unknown; locked: boolean } {
    const file = path.join(this.ctx.dataDir, 'pending.json');
    return { pending: lstatSafe(file) ? readJson(file) ?? { error: 'pending.json 无法解析，请保留原文件' } : null, locked: !!lstatSafe(path.join(this.ctx.dataDir, 'mutation.lock')) };
  }

  history(): JournalEntry[] {
    if (!lstatSafe(this.journalFile())) return [];
    const j = readJson(this.journalFile());
    if (!Array.isArray(j) || j.some((e) => !e || typeof e.id !== 'string' || typeof e.title !== 'string' || typeof e.kind !== 'string' || !Number.isFinite(e.time) || !['applied', 'rolledBack'].includes(e.status) || !Array.isArray(e.steps) || !e.post || typeof e.post !== 'object' || Object.values(e.post).some((fp) => typeof fp !== 'string') || e.steps.some((s: any) => !s || !['mkdir', 'rmdir', 'write', 'move', 'copy', 'link', 'trash'].includes(s.type) || stepPaths(s).some((p) => typeof p !== 'string' || !path.isAbsolute(p))))) throw new Error('操作日志损坏，禁止覆盖 journal.json');
    return j;
  }

  private saveHistory(all: JournalEntry[]): void {
    fs.mkdirSync(this.ctx.dataDir, { recursive: true, mode: 0o700 });
    writeAtomic(this.journalFile(), JSON.stringify(all, null, 1));
  }

  private record(skillId: string): SkillRecord {
    const r = this.inv.skills.find((s) => s.id === skillId);
    if (!r) throw new Error('该 Skill 已不存在，请重新扫描');
    return r;
  }

  readSkill(skillId: string): { content: string | null; files: { rel: string; size: number; dir: boolean }[] } {
    const rec = this.record(skillId);
    const files: { rel: string; size: number; dir: boolean }[] = [];
    walk(rec.realPath, (rel, st) => files.push({ rel, size: st.size, dir: st.isDirectory() }), 800);
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    return { content: readText(path.join(rec.realPath, rec.markerDisabled ? MARKER_FILE : SKILL_FILE)), files };
  }

  /** Returns file text for display only; nothing inside a skill is ever executed. */
  readFile(skillId: string, rel: string): { text: string | null } {
    const rec = this.record(skillId);
    const full = realSafe(path.join(rec.realPath, rel));
    if (!full || !(full + path.sep).startsWith(rec.realPath + path.sep)) throw new Error('路径越界');
    const st = statSafe(full);
    if (!st?.isFile() || st.size > 512 * 1024) return { text: null };
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8192).includes(0)) return { text: null };
    return { text: buf.toString('utf8') };
  }

  validate(bindingId: string, content: string): Issue[] {
    const { rec, b } = this.find(bindingId);
    return validateSkill(parseSkillMd(content), rec.dirName, this.adapter(b.agent).rules);
  }

  listScanDirectories(): ScanDirectory[] {
    return loadConfig(this.ctx).scanDirectories || [];
  }

  addScanDirectory(agent: string, input: string, readOnly = true, layout?: 'collection' | 'skill'): Inventory {
    return this.withMutation(() => {
      this.adapter(agent);
      if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0') || typeof readOnly !== 'boolean') throw new Error('扫描目录需为绝对路径，readOnly 需为布尔值');
      if (layout !== undefined && !['collection', 'skill'].includes(layout)) throw new Error('layout 需为 collection 或 skill');
      const dir = path.normalize(input);
      const mode = layout || (statSafe(path.join(dir, SKILL_FILE))?.isFile() || statSafe(path.join(dir, MARKER_FILE))?.isFile() ? 'skill' : 'collection');
      if (!statSafe(dir)?.isDirectory()) throw new Error('扫描目录不存在');
      const real = realFuture(dir), data = realFuture(this.ctx.dataDir);
      if (real === path.parse(real).root || real === realFuture(this.ctx.home) || real === data || data.startsWith(real + path.sep) || real.startsWith(data + path.sep)) throw new Error('不能登记 home、文件系统根或涉及应用数据的目录');
      const cfg = loadConfig(this.ctx);
      const entries = cfg.scanDirectories || [];
      const existing = entries.find((r) => r.agent === agent && pathKey(realFuture(r.path)) === pathKey(real));
      if (existing) {
        if (existing.readOnly !== readOnly || (existing.layout || 'collection') !== mode) throw new Error('已有登记的权限或布局不同；请显式移除后重新登记，不静默覆盖');
        return this.scan();
      }
      if (entries.length >= 256) throw new Error('自定义扫描目录最多 256 个');
      cfg.scanDirectories = [...entries, { id: hashId('custom-scan', agent, real), agent, path: dir, readOnly, layout: mode }];
      saveConfig(this.ctx, cfg);
      return this.scan();
    });
  }

  removeScanDirectory(id: string): Inventory {
    return this.withMutation(() => {
      const cfg = loadConfig(this.ctx);
      if (!(cfg.scanDirectories || []).some((r) => r.id === id)) throw new Error('扫描目录登记不存在');
      cfg.scanDirectories = cfg.scanDirectories!.filter((r) => r.id !== id);
      saveConfig(this.ctx, cfg);
      return this.scan();
    });
  }

  addProject(p: string): Inventory {
    return this.withMutation(() => this.addProjectLocked(p));
  }

  private addProjectLocked(p: string): Inventory {
    if (!path.isAbsolute(p.trim())) throw new Error('项目路径必须为绝对路径');
    const dir = path.resolve(p.trim());
    if (!statSafe(dir)?.isDirectory()) throw new Error(`目录不存在：${dir}`);
    const cfg = loadConfig(this.ctx);
    if (!cfg.projects.some((x) => pathKey(x) === pathKey(dir))) cfg.projects.push(dir);
    cfg.hiddenProjects = cfg.hiddenProjects.filter((x) => pathKey(x) !== pathKey(dir));
    saveConfig(this.ctx, cfg);
    return this.scan();
  }

  removeProject(p: string): Inventory {
    return this.withMutation(() => this.removeProjectLocked(p));
  }

  private removeProjectLocked(p: string): Inventory {
    const cfg = loadConfig(this.ctx);
    cfg.projects = cfg.projects.filter((x) => pathKey(x) !== pathKey(p));
    if (!cfg.hiddenProjects.some((x) => pathKey(x) === pathKey(p))) cfg.hiddenProjects.push(p);
    saveConfig(this.ctx, cfg);
    return this.scan();
  }
}

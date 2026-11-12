import fs from 'node:fs';
import path from 'node:path';
import type { AgentReport, AppConfig, ArchiveMeta, Binding, Ctx, DiscoveryIssue, Evidence, Inventory, Issue, RootReport, RootSpec, SkillRecord, Status } from './types';
import { ADAPTERS, type Adapter } from './adapters';
import { clearNestedCache, root as makeRoot, type Probe, type ScanProject } from './adapters/base';
import { listProjects } from './config';
import { parseSkillMd, validateSkill } from './frontmatter';
import { hashId, lstatSafe, pathKey, readJson, readText, realSafe, statSafe, summarize, realFuture } from './util';

export const SKILL_FILE = 'SKILL.md';
export const MARKER_FILE = 'SKILL.md.disabled';

interface Found {
  entryPath: string;
  /** Depth below the root; 1 = direct child. */
  depth: number;
  hidden: boolean;
  broken: boolean;
  empty: boolean;
}

function hasSkill(dir: string): boolean {
  return !!statSafe(path.join(dir, SKILL_FILE))?.isFile() || !!statSafe(path.join(dir, MARKER_FILE))?.isFile();
}

function listEntries(rootDir: string, ignore: string[], maxDepth = 3): Found[] {
  let budget = 20000;
  const ancestors = new Set<string>();
  const out: Found[] = [];
  const visit = (dir: string, depth: number) => {
    const real = fs.realpathSync(dir);
    if (ancestors.has(real)) return;
    ancestors.add(real);
    const names = fs.readdirSync(dir).sort();
    for (const n of names) {
      if (--budget < 0) throw new Error('扫描条目超出 20000 限额，结果不完整');
      if (depth === 1 && ignore.includes(n)) continue;
      const p = path.join(dir, n);
      const l = lstatSafe(p);
      if (!l) continue;
      const st = l.isSymbolicLink() ? statSafe(p) : l;
      if (!st) {
        if (depth === 1) out.push({ entryPath: p, depth, hidden: false, broken: true, empty: false });
        continue;
      }
      if (!st.isDirectory()) continue;
      const hidden = n.startsWith('.');
      if (hasSkill(p)) {
        out.push({ entryPath: p, depth, hidden, broken: false, empty: false });
        continue;
      }
      if (hidden || n === 'node_modules') continue;
      const before = out.length;
      if (depth < maxDepth) visit(p, depth + 1);
      if (depth === 1 && out.length === before) out.push({ entryPath: p, depth, hidden, broken: false, empty: true });
    }
    ancestors.delete(real);
  };
  visit(rootDir, 1);
  return out;
}

function loadRecord(realPath: string, dirName: string): SkillRecord {
  const mdPath = path.join(realPath, SKILL_FILE);
  const markerPath = path.join(realPath, MARKER_FILE);
  const hasSkillMd = !!statSafe(mdPath)?.isFile();
  const markerDisabled = !hasSkillMd && !!statSafe(markerPath)?.isFile();
  const text = readText(hasSkillMd ? mdPath : markerPath);
  const parsed = text != null ? parseSkillMd(text) : null;
  const fm = parsed?.data ?? null;
  const sum = statSafe(realPath)?.isDirectory() ? summarize(realPath) : { fileCount: 0, size: 0, mtime: 0, hasScripts: false };
  return {
    id: hashId('skill', pathKey(realPath)),
    realPath,
    dirName,
    name: typeof fm?.name === 'string' && fm.name ? fm.name : dirName,
    description: typeof fm?.description === 'string' ? fm.description : '',
    frontmatter: fm,
    parseError: parsed?.error,
    hasSkillMd,
    markerDisabled,
    ...sum,
    bindings: [],
  };
}

export function archiveDir(ctx: Ctx): string {
  return path.join(ctx.dataDir, 'archive');
}

export function listArchives(ctx: Ctx): ArchiveMeta[] {
  const out: ArchiveMeta[] = [];
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(archiveDir(ctx));
  } catch {}
  for (const id of ids) {
    const meta = readJson(path.join(archiveDir(ctx), id, 'meta.json'));
    if (meta?.id === id && typeof meta.originPath === 'string' && path.isAbsolute(meta.originPath)
      && typeof meta.rootDir === 'string' && path.isAbsolute(meta.rootDir)
      && meta.originPath.startsWith(meta.rootDir + path.sep)
      && meta.dirName === path.basename(meta.originPath) && Number.isFinite(meta.time)
      && typeof meta.agent === 'string' && typeof meta.rootId === 'string'
      && ['user', 'project', 'system', 'admin', 'plugin'].includes(meta.scope)
      && (!meta.wasSymlink || (typeof meta.linkTarget === 'string' && path.isAbsolute(meta.linkTarget)))
      && lstatSafe(path.join(archiveDir(ctx), id, 'payload'))) out.push(meta);
  }
  return out.sort((a, b) => b.time - a.time);
}

export interface ScanResult {
  inventory: Inventory;
  rootsById: Map<string, RootSpec>;
}

export function scan(ctx: Ctx, cfg: AppConfig, adapters: Adapter[] = ADAPTERS): ScanResult {
  const t0 = Date.now();
  clearNestedCache();
  const projects = listProjects(ctx, cfg);
  const scanProjects: ScanProject[] = projects.filter((p) => p.exists).map((p) => ({ path: p.path, nested: p.origin === 'manual' }));
  const manual = new Set(projects.filter((p) => p.origin === 'manual').map((p) => pathKey(p.path)));

  const records = new Map<string, SkillRecord>();
  const rootsById = new Map<string, RootSpec>();
  const rootOf = new Map<string, RootSpec>();
  const roots: RootReport[] = [];
  const agents: AgentReport[] = [];
  const discoveryIssues: DiscoveryIssue[] = [];
  for (const custom of cfg.scanDirectories || []) if (!adapters.some((a) => a.id === custom.agent)) discoveryIssues.push({ agent: custom.agent, level: 'warn', code: 'custom-agent-unknown', text: '自定义目录引用了当前未注册的智能体，未猜测其规则', path: custom.path });
  const byAgent = new Map<string, Binding[]>();

  const record = (entryPath: string): SkillRecord => {
    const real = realSafe(entryPath) || entryPath;
    const key = pathKey(real);
    let r = records.get(key);
    if (!r) records.set(key, (r = loadRecord(real, path.basename(real))));
    return r;
  };

  for (const ad of adapters) {
    let det: ReturnType<Adapter['detect']>;
    try { det = ad.detect(ctx); } catch (e) { det = { detection: 'absent', evidence: [{ ok: null, text: `检测失败：${String(e)}` }] }; }
    agents.push({ id: ad.id, name: ad.name, vendor: ad.vendor, detection: det.detection, detectionEvidence: det.evidence, docs: ad.docs, collision: ad.collision, toggleRule: ad.toggleRule, counts: {} });
    const list: Binding[] = [];
    byAgent.set(ad.id, list);
    let isDisabled: ReturnType<NonNullable<Adapter['disableState']>> | undefined;
    try { isDisabled = ad.disableState?.(ctx); } catch (e) { isDisabled = () => ({ ok: null, text: `配置读取失败：${String(e)}` }); }
    const seenRoots = new Set<string>();

    let specs: RootSpec[];
    try { specs = ad.roots(ctx, scanProjects); } catch (e) {
      agents[agents.length - 1].detectionEvidence.push({ ok: null, text: `目录发现失败：${String(e)}` });
      specs = [];
    }
    try {
      const extra = ad.discover?.(ctx, scanProjects);
      if (extra) { specs.push(...extra.roots); discoveryIssues.push(...extra.issues); }
    } catch (e) { discoveryIssues.push({ agent: ad.id, level: 'warn', code: 'additional-discovery-failed', text: String(e) }); }
    for (const custom of cfg.scanDirectories || []) if (custom.agent === ad.id) specs.push(makeRoot(ad.id, {
      scope: 'user', dir: custom.path, priority: 0, readOnly: custom.readOnly, confidence: 'observed',
      source: { title: '用户登记的扫描目录（不修改智能体配置）', url: '' }, rule: '仅登记到 SkillDeck；没有智能体读取此目录的证据',
      sourceKind: 'custom', singleSkill: custom.layout === 'skill', discoveryId: custom.id, loadState: 'unknown', evidence: [{ ok: null, text: '用户手动登记，不能据此认定智能体已安装或加载', path: path.join(ctx.dataDir, 'config.json') }],
    }));
    for (const root of specs) {
      if (seenRoots.has(root.id)) continue;
      seenRoots.add(root.id);
      rootsById.set(root.id, root);
      const st = statSafe(root.dir);
      const report: RootReport = { ...root, exists: !!st?.isDirectory(), count: 0 };
      // Auto-discovered projects only show up when they actually hold a skills directory.
      if (report.exists || !root.project || root.sourceKind || manual.has(pathKey(root.project))) roots.push(report);
      if (!report.exists) continue;

      let entries: Found[];
      try {
        if (ad.flatMarkdown && !root.singleSkill) {
          const flat = fs.readdirSync(root.dir).filter((n) => n.endsWith('.md') && statSafe(path.join(root.dir, n))?.isFile());
          if (flat.length) report.error = `发现尚不支持管理的独立 Markdown Skills：${flat.join('、')}；目录型 Skills 仍正常扫描`;
        }
        entries = root.singleSkill ? [{ entryPath: root.dir, depth: 1, hidden: false, broken: false, empty: !hasSkill(root.dir) }] : listEntries(root.dir, root.ignore || [], ad.maxDepth || (ad.recursive ? 6 : 3));
      }
      catch (e) { report.error = String(e); continue; }
      for (const f of entries) {
        const l = lstatSafe(f.entryPath)!;
        const isSymlink = l.isSymbolicLink();
        const rec = f.broken ? null : record(f.entryPath);
        const dirName = path.basename(f.entryPath);
        const evidence: Evidence[] = [{ ok: root.loadState ? null : true, text: root.rule, path: root.dir, url: root.source.url || undefined }, ...(root.evidence || [])];
        const issues: Issue[] = [];
        let status: Status;
        const baseName = ad.idFromPath || !rec ? dirName : rec.name;
        const probe: Probe = {
          name: baseName,
          entryPath: f.entryPath,
          skillMd: path.join(f.entryPath, SKILL_FILE),
          realSkillMd: path.join(rec?.realPath || f.entryPath, SKILL_FILE),
          root,
        };
        if (isSymlink) {
          let target = '?';
          try {
            target = fs.readlinkSync(f.entryPath);
          } catch {}
          evidence.push({ ok: f.broken ? false : null, text: f.broken ? `符号链接目标不存在 → ${target}` : `符号链接 → ${target}`, path: rec?.realPath });
        }

        if (f.broken || !rec) {
          status = 'invalid';
          issues.push({ level: 'error', code: 'broken-link', text: '符号链接已失效' });
        } else if (f.empty) {
          status = 'invalid';
          issues.push({ level: 'error', code: 'no-skill-md', text: '目录内没有 SKILL.md' });
          evidence.push({ ok: false, text: '缺少 SKILL.md', path: f.entryPath });
        } else {
          const text = readText(path.join(rec.realPath, rec.hasSkillMd ? SKILL_FILE : MARKER_FILE));
          if (text != null) issues.push(...validateSkill(parseSkillMd(text), dirName, ad.rules));
          else issues.push({ level: 'error', code: 'unreadable', text: 'SKILL.md 无法读取或过大' });
          const disabledBy = isDisabled?.(probe);
          const fatal = issues.filter((i) => i.level === 'error');
          if (f.hidden) {
            status = 'unknown';
            evidence.push({ ok: null, text: '位于隐藏目录，智能体是否加载无规则可依', path: f.entryPath });
          } else if (f.depth > 1 && !ad.recursive) {
            status = 'unknown';
            evidence.push({ ok: null, text: `位于发现目录下第 ${f.depth} 层，规则只覆盖直接子目录`, path: f.entryPath });
          } else if (rec.markerDisabled) {
            status = 'disabled';
            evidence.push({ ok: false, text: 'SKILL.md 已重命名为 SKILL.md.disabled', path: path.join(rec.realPath, MARKER_FILE) });
          } else if (fatal.length) {
            status = 'invalid';
            evidence.push({ ok: true, text: 'SKILL.md 存在', path: probe.realSkillMd });
          } else if (disabledBy) {
            status = disabledBy.ok === false ? 'disabled' : 'unverified';
            evidence.push({ ok: true, text: 'SKILL.md 存在且可解析', path: probe.realSkillMd }, disabledBy);
          } else {
            evidence.push({ ok: true, text: 'SKILL.md 存在且可解析', path: probe.realSkillMd });
            const doubts: Evidence[] = [];
            if (det.detection !== 'installed') doubts.push({ ok: null, text: `仅发现 ${ad.name} 的配置痕迹，未找到程序` });
            if (root.confidence === 'observed') doubts.push({ ok: null, text: '该目录规则未经官方文档核实' });
            if (root.lazy) doubts.push({ ok: null, text: '按需加载，启动时不生效' });
            if (f.depth > 1) doubts.push({ ok: null, text: `位于第 ${f.depth} 层子目录，递归发现未在公开文档中说明` });
            doubts.push({ ok: null, text: '静态扫描符合已知发现规则；未核实当前会话加载、信任与权限状态' });
            status = 'unverified';
            evidence.push(...doubts);
            if (!doubts.length) evidence.push({ ok: true, text: `已检测到 ${ad.name}`, path: det.evidence[0]?.path });
          }
          for (const i of fatal) evidence.push({ ok: false, text: i.text });
        }

        if (root.loadState === 'unknown' && status === 'unverified') status = 'unknown';
        const readOnly = !!root.readOnly;
        const switchable = !readOnly && (status === 'unverified' || status === 'disabled' || (status === 'unknown' && root.sourceKind === 'custom'));
        const toggle: Binding['toggle'] = !switchable ? 'none' : rec?.markerDisabled ? 'marker' : ad.toggle && !root.namespace && root.sourceKind !== 'custom' ? 'official' : isSymlink ? 'none' : 'marker';
        const b: Binding = {
          id: hashId('bind', ad.id, root.id, pathKey(f.entryPath)),
          agent: ad.id,
          rootId: root.id,
          entryPath: f.entryPath,
          isSymlink,
          scope: root.scope,
          project: root.project,
          status,
          invocableName: root.namespace ? `${root.namespace}:${baseName}` : baseName,
          evidence,
          issues,
          readOnly,
          toggle,
          tags: rec && status !== 'invalid' ? ad.tags?.(rec.realPath, rec.frontmatter) || [] : [],
        };
        report.count++;
        rootOf.set(b.id, root);
        list.push(b);
        if (rec) rec.bindings.push(b);
        else {
          const ghost = loadRecord(f.entryPath, dirName);
          ghost.bindings.push(b);
          records.set('ghost:' + b.id, ghost);
        }
      }
    }
    resolveCollisions(ad, list, rootOf, records);
  }

  // Protection is global across agents; registering an alias under another agent cannot relax it.
  const protectedDirs = [...rootsById.values()].filter((r) => r.readOnly && r.sourceKind !== 'custom').map((r) => realFuture(r.dir));
  for (const r of rootsById.values()) if (r.sourceKind === 'custom' && protectedDirs.some((p) => {
    const at = realFuture(r.dir); return at === p || at.startsWith(p + path.sep) || p.startsWith(at + path.sep);
  })) {
    r.readOnly = true;
    const report = roots.find((x) => x.id === r.id);
    if (report) report.readOnly = true;
    for (const rec of records.values()) for (const b of rec.bindings) if (b.rootId === r.id) {
      b.readOnly = true; b.toggle = 'none';
      b.evidence.push({ ok: null, text: '与其他已知只读来源重叠，禁止通过手动登记解除保护' });
    }
  }

  for (const meta of listArchives(ctx)) {
    const payload = path.join(archiveDir(ctx), meta.id, 'payload');
    const src = meta.wasSymlink && meta.linkTarget ? meta.linkTarget : payload;
    const rec = loadRecord(realSafe(src) || src, meta.dirName);
    rec.id = hashId('archive', meta.id);
    rec.bindings.push({
      id: hashId('bind', 'archive', meta.id),
      agent: meta.agent,
      rootId: meta.rootId,
      entryPath: meta.originPath,
      isSymlink: meta.wasSymlink,
      scope: meta.scope,
      project: meta.project,
      status: 'archived',
      invocableName: rec.name,
      evidence: [
        { ok: null, text: `归档于 ${new Date(meta.time).toLocaleString()}`, path: payload },
        { ok: null, text: '原位置', path: meta.originPath },
        ...(meta.wasSymlink ? [{ ok: null, text: `原为符号链接 → ${meta.linkTarget}` }] : []),
      ],
      issues: [],
      readOnly: false,
      toggle: 'none',
      tags: [],
      archiveId: meta.id,
    });
    records.set('archive:' + meta.id, rec);
    byAgent.get(meta.agent)?.push(rec.bindings[0]);
  }

  for (const a of agents) for (const b of byAgent.get(a.id) || []) a.counts[b.status] = (a.counts[b.status] || 0) + 1;
  const withRoots = new Set(roots.filter((r) => r.exists && r.project).map((r) => pathKey(r.project!)));
  const skills = [...records.values()].sort((a, b) => a.name.localeCompare(b.name) || a.realPath.localeCompare(b.realPath));

  return {
    rootsById,
    inventory: {
      scannedAt: Date.now(),
      durationMs: Date.now() - t0,
      platform: ctx.platform,
      home: ctx.home,
      dataDir: ctx.dataDir,
      agents,
      discoveryIssues,
      roots,
      skills,
      projects: projects.filter((p) => p.origin === 'manual' || withRoots.has(pathKey(p.path))),
    },
  };
}

function resolveCollisions(ad: Adapter, list: Binding[], rootOf: Map<string, RootSpec>, records: Map<string, SkillRecord>): void {
  const realOf = new Map<string, string>();
  for (const r of records.values()) for (const b of r.bindings) realOf.set(b.id, r.realPath);
  const live = list.filter((b) => b.status === 'active' || b.status === 'unverified');
  const groups = new Map<string, Binding[]>();
  for (const b of live) {
    const k = ad.idFromPath ? b.invocableName : b.invocableName.normalize('NFKC').toLowerCase();
    groups.set(k, [...(groups.get(k) || []), b]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const verdicts = new Map<string, Evidence[]>();
    for (const b of group) {
      const notes: Evidence[] = [];
      let conflict = false;
      for (const c of group) {
        if (c === b) continue;
        if (realOf.get(c.id) === realOf.get(b.id)) {
          notes.push({ ok: null, text: '同一实体经另一目录也可见', path: c.entryPath });
          continue;
        }
        const contains = (parent: string, child: string) => pathKey(parent) === pathKey(child) || pathKey(child).startsWith(pathKey(parent) + path.sep);
        if (b.project && c.project && !contains(b.project, c.project) && !contains(c.project, b.project)) continue;
        // c competes everywhere b applies only when c is not narrower than b.
        const everywhere = !c.project || (!!b.project && contains(c.project, b.project));
        const pb = rootOf.get(b.id)!.priority;
        const pc = rootOf.get(c.id)!.priority;
        if (ad.collision === 'priority' && pb !== pc) {
          if (pc > pb && everywhere) {
            conflict = true;
            notes.push({ ok: false, text: '被同名的更高优先级 Skill 覆盖', path: c.entryPath });
          } else if (pc > pb) {
            notes.push({ ok: null, text: '在该项目内被同名 Skill 覆盖', path: c.entryPath });
          } else {
            notes.push({ ok: true, text: '覆盖了同名的较低优先级 Skill', path: c.entryPath });
          }
        } else if (everywhere) {
          conflict = true;
          notes.push({
            ok: false,
            text: ad.collision === 'duplicate' ? '同名 Skill 并存，不会合并，选择器中重复出现' : ad.collision === 'priority' ? '同名且同优先级，取舍规则未文档化' : '同名 Skill，官方未说明取舍规则',
            path: c.entryPath,
          });
        } else {
          notes.push({ ok: null, text: '在该项目内存在同名 Skill', path: c.entryPath });
        }
      }
      verdicts.set(b.id, notes);
      if (conflict) b.status = 'conflict';
    }
    for (const b of group) b.evidence.push(...(verdicts.get(b.id) || []));
  }
}

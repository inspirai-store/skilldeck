import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Binding, Inventory, JournalEntry, Op, ScanDirectory, SkillRecord, Status } from '../core/types';
import { type HistoryItem, api } from './api';
import { type Action, Detail } from './Detail';
import { CreateDialog, EditorDialog, PathDialog, PlanDialog, TransferDialog } from './dialogs';
import { type Filters, SCOPE_LABEL, STATUS_LABEL, STATUS_ORDER, baseName, bindingMatches, fmtDay, headline, queryMatches, tilde } from './meta';
import { AgentChip, CopyButton, Icon, Segmented, StatusPill } from './ui';
import { HistoryView, ScopeView } from './views';

type View = 'skills' | 'scope' | 'history';
type Dialog =
  | { kind: 'create'; mode: 'create' | 'import' }
  | { kind: 'edit'; skill: SkillRecord; binding: Binding; content: string }
  | { kind: 'transfer'; skill: SkillRecord; binding: Binding }
  | { kind: 'path'; target: 'project' | 'scanDir' }
  | null;

export function App() {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<View>('skills');
  const [filters, setFilters] = useState<Filters>({ agent: null, project: null, scope: 'all', status: null, query: '' });
  const [sort, setSort] = useState<'name' | 'mtime'>('name');
  const [selected, setSelected] = useState<string | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [op, setOp] = useState<Op | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [scanDirs, setScanDirs] = useState<ScanDirectory[]>([]);
  const [recovery, setRecovery] = useState<{ pending: unknown; locked: boolean } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: string; bad?: boolean } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refreshSide = useCallback(() => {
    api.history().then(setHistory, (e) => setError(e.message));
    api.listScanDirectories().then(setScanDirs, () => {});
    api.recoveryStatus().then(setRecovery, () => {});
  }, []);

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      setInv(await api.scan());
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
    setScanning(false);
    refreshSide();
  }, [refreshSide]);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setView('skills');
        searchRef.current?.focus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        void rescan();
      } else if (e.key === 'Escape' && !document.querySelector('.modal')) {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rescan]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  const base = useMemo(() => {
    if (!inv) return [];
    return inv.skills
      .filter((s) => queryMatches(s, filters.query))
      .map((s) => ({ skill: s, hits: s.bindings.filter((b) => bindingMatches(b, filters)) }))
      .filter((x) => x.hits.length);
  }, [inv, filters.agent, filters.project, filters.scope, filters.query]);

  const statusCounts = useMemo(() => {
    const c: Partial<Record<Status, number>> = {};
    for (const x of base) for (const s of new Set(x.hits.map((b) => b.status))) c[s] = (c[s] || 0) + 1;
    return c;
  }, [base]);

  const rows = useMemo(() => {
    const list = filters.status ? base.map((x) => ({ ...x, hits: x.hits.filter((b) => b.status === filters.status) })).filter((x) => x.hits.length) : base;
    return sort === 'mtime' ? [...list].sort((a, b) => b.skill.mtime - a.skill.mtime) : list;
  }, [base, filters.status, sort]);

  const current = inv?.skills.find((s) => s.id === selected) || null;

  const onApplied = async (entry: JournalEntry) => {
    setOp(null);
    setDialog(null);
    await rescan();
    setToast({ text: entry.title, undo: entry.rollbackOf ? undefined : entry.id });
  };

  const onAction = (a: Action, skill: SkillRecord, b: Binding, content: string | null) => {
    if (a === 'edit') content != null && setDialog({ kind: 'edit', skill, binding: b, content });
    else if (a === 'transfer') setDialog({ kind: 'transfer', skill, binding: b });
    else if (a === 'toggle') setOp({ kind: 'toggle', bindingId: b.id, enable: b.status === 'disabled' });
    else if (a === 'archive') setOp({ kind: 'archive', bindingId: b.id });
    else if (a === 'delete') setOp({ kind: 'delete', bindingId: b.id });
    else if (a === 'restore' && b.archiveId) setOp({ kind: 'restore', archiveId: b.archiveId });
  };

  const mutateConfig = async (fn: () => Promise<Inventory>) => {
    try {
      setInv(await fn());
      refreshSide();
    } catch (e: any) {
      setToast({ text: e.message, bad: true });
    }
  };

  if (!inv) {
    return (
      <div className="boot">
        {error ? (
          <div className="boot-error">
            <p>{error}</p>
            <button onClick={() => void rescan()}>重试</button>
          </div>
        ) : (
          <div className="loading" />
        )}
      </div>
    );
  }

  const set = (patch: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setView('skills');
  };
  const mac = inv.platform === 'darwin';
  const blocked = !!recovery && (!!recovery.pending || recovery.locked);

  return (
    <div className={`app ${mac ? 'mac' : ''}`}>
      <nav className="sidebar">
        <div className="brand">
          <span className="logo">
            <Icon name="layers" size={15} />
          </span>
          SkillDeck
        </div>
        <div className="side-scroll">
          <h4>智能体</h4>
          <button className={`side-item ${view === 'skills' && !filters.agent ? 'on' : ''}`} data-testid="agent-all" onClick={() => set({ agent: null })}>
            <span className="all-chip">
              <Icon name="layers" size={13} />
            </span>
            <span className="grow">全部</span>
            <span className="count">{inv.skills.length}</span>
          </button>
          {inv.agents.map((a) => {
            const n = Object.values(a.counts).reduce((x, y) => x + (y || 0), 0);
            return (
              <button
                key={a.id}
                data-testid={`agent-${a.id}`}
                className={`side-item ${view === 'skills' && filters.agent === a.id ? 'on' : ''} ${a.detection === 'absent' ? 'absent' : ''}`}
                onClick={() => set({ agent: a.id })}
              >
                <AgentChip id={a.id} />
                <span className="grow">{a.name}</span>
                {a.detection !== 'installed' && <i className={`det det-${a.detection}`} title={a.detection === 'traces' ? '仅配置' : '未检测到'} />}
                <span className="count">{n}</span>
              </button>
            );
          })}

          <h4>
            项目
            <button className="icon-btn ghost" onClick={() => setDialog({ kind: 'path', target: 'project' })} aria-label="添加项目" data-testid="side-add-project">
              <Icon name="plus" size={13} />
            </button>
          </h4>
          {inv.projects.map((p) => (
            <button key={p.path} className={`side-item ${view === 'skills' && filters.project === p.path ? 'on' : ''}`} title={p.path} onClick={() => set({ project: filters.project === p.path ? null : p.path, scope: 'all' })}>
              <Icon name="folder" size={14} />
              <span className="grow ellipsis">{baseName(p.path)}</span>
            </button>
          ))}
        </div>
        <div className="side-foot">
          <button className={`side-item ${view === 'scope' ? 'on' : ''}`} data-testid="nav-scope" onClick={() => setView('scope')}>
            <Icon name="radar" size={15} />
            <span className="grow">扫描范围</span>
            {(inv.discoveryIssues?.length || 0) > 0 && <span className="count warn">{inv.discoveryIssues!.length}</span>}
          </button>
          <button className={`side-item ${view === 'history' ? 'on' : ''}`} data-testid="nav-history" onClick={() => setView('history')}>
            <Icon name="history" size={15} />
            <span className="grow">操作历史</span>
            {history.length > 0 && <span className="count">{history.length}</span>}
          </button>
        </div>
      </nav>

      <main className="main">
        <header className="toolbar">
          {view === 'skills' ? (
            <div className="search">
              <Icon name="search" size={15} />
              <input ref={searchRef} data-testid="search" value={filters.query} onChange={(e) => set({ query: e.target.value })} placeholder="搜索" spellCheck={false} />
              {filters.query ? (
                <button className="icon-btn ghost" onClick={() => set({ query: '' })} aria-label="清除">
                  <Icon name="x" size={13} />
                </button>
              ) : (
                <kbd>{mac ? '⌘K' : 'Ctrl K'}</kbd>
              )}
            </div>
          ) : (
            <h1>{view === 'scope' ? '扫描范围' : '操作历史'}</h1>
          )}
          <span className="grow drag" />
          {view === 'skills' && (
            <>
              <Segmented
                testId="scope-filter"
                value={filters.scope}
                onChange={(scope) => set({ scope })}
                options={[
                  { id: 'all', label: '全部' },
                  { id: 'user', label: SCOPE_LABEL.user },
                  { id: 'project', label: SCOPE_LABEL.project },
                  { id: 'system', label: '系统/插件' },
                ]}
              />
              <button className="icon-btn" title={sort === 'name' ? '按名称' : '按修改时间'} aria-label="排序" onClick={() => setSort(sort === 'name' ? 'mtime' : 'name')}>
                <Icon name="sort" />
              </button>
            </>
          )}
          <button className="icon-btn" data-testid="rescan" title="重新扫描" aria-label="重新扫描" onClick={() => void rescan()} disabled={scanning}>
            <span className={scanning ? 'spin' : ''}>
              <Icon name="refresh" />
            </span>
          </button>
          <button data-testid="import" onClick={() => setDialog({ kind: 'create', mode: 'import' })} disabled={blocked}>
            <Icon name="import" />
            导入
          </button>
          <button className="primary" data-testid="new" onClick={() => setDialog({ kind: 'create', mode: 'create' })} disabled={blocked}>
            <Icon name="plus" />
            新建
          </button>
        </header>

        {blocked && (
          <div className="banner bad" data-testid="recovery-banner">
            <Icon name="stop" />
            <span>存在未完成的写入，已暂停修改</span>
            <span className="mono">{inv.dataDir}</span>
            <CopyButton text={inv.dataDir} label="复制路径" />
          </div>
        )}
        {error && (
          <div className="banner bad">
            <Icon name="stop" />
            <span>{error}</span>
          </div>
        )}

        {view === 'skills' && (
          <div className="content">
            <section className="list-pane">
              <div className="status-bar" data-testid="status-bar">
                <button className={`status-tab ${!filters.status ? 'on' : ''}`} onClick={() => set({ status: null })}>
                  全部<b>{base.length}</b>
                </button>
                {STATUS_ORDER.map((s) => (
                  <button key={s} data-testid={`status-${s}`} className={`status-tab ${filters.status === s ? 'on' : ''}`} disabled={!statusCounts[s] && filters.status !== s} onClick={() => set({ status: filters.status === s ? null : s })}>
                    <i className={`dot st-${s}`} />
                    {STATUS_LABEL[s]}
                    <b>{statusCounts[s] || 0}</b>
                  </button>
                ))}
              </div>
              <div className="list" data-testid="skill-list">
                {rows.map(({ skill, hits }) => (
                  <button
                    key={skill.id}
                    className={`row ${selected === skill.id ? 'on' : ''}`}
                    data-testid="skill-row"
                    data-name={skill.name}
                    onClick={() => {
                      setSelected(skill.id);
                      setBindingId(hits[0]?.id || null);
                    }}
                  >
                    <span className="row-main">
                      <span className="row-name">
                        {skill.name}
                        {skill.hasScripts && <span className="tag">scripts</span>}
                      </span>
                      <span className="row-desc">{skill.description || tilde(skill.realPath, inv.home)}</span>
                    </span>
                    <span className="row-chips">
                      {skill.bindings.slice(0, 9).map((b) => (
                        <AgentChip key={b.id} id={b.agent} status={b.status} dim={!hits.includes(b)} title={`${inv.agents.find((a) => a.id === b.agent)?.name || b.agent} · ${STATUS_LABEL[b.status]}`} />
                      ))}
                      {skill.bindings.length > 9 && <span className="more">+{skill.bindings.length - 9}</span>}
                    </span>
                    <span className="row-status">
                      <StatusPill status={headline(hits)} />
                    </span>
                    <span className="row-time">{fmtDay(skill.mtime)}</span>
                  </button>
                ))}
                {!rows.length && <div className="empty big">无匹配项</div>}
              </div>
            </section>
            {current && (
              <Detail
                key={current.id}
                inv={inv}
                skill={current}
                filters={filters}
                bindingId={bindingId}
                onSelectBinding={setBindingId}
                onAction={onAction}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        )}
        {view === 'scope' && (
          <ScopeView
            inv={inv}
            scanDirs={scanDirs}
            onAddProject={() => setDialog({ kind: 'path', target: 'project' })}
            onRemoveProject={(p) => void mutateConfig(() => api.removeProject(p))}
            onAddScanDir={() => setDialog({ kind: 'path', target: 'scanDir' })}
            onRemoveScanDir={(id) => void mutateConfig(() => api.removeScanDirectory(id))}
          />
        )}
        {view === 'history' && <HistoryView items={history} onRollback={(entryId) => setOp({ kind: 'rollback', entryId })} />}
      </main>

      <div style={{ display: op ? 'none' : 'contents' }}>
      {dialog?.kind === 'create' && <CreateDialog inv={inv} preferAgent={filters.agent} startMode={dialog.mode} onClose={() => setDialog(null)} onPreview={setOp} />}
      {dialog?.kind === 'edit' && <EditorDialog skill={dialog.skill} binding={dialog.binding} initial={dialog.content} onClose={() => setDialog(null)} onPreview={setOp} />}
      {dialog?.kind === 'transfer' && <TransferDialog inv={inv} skill={dialog.skill} binding={dialog.binding} onClose={() => setDialog(null)} onPreview={setOp} />}
      {dialog?.kind === 'path' && (
        <PathDialog
          inv={inv}
          kind={dialog.target}
          onClose={() => setDialog(null)}
          onDone={(next) => {
            setInv(next);
            setDialog(null);
            refreshSide();
          }}
        />
      )}
      </div>
      {op && <PlanDialog key={JSON.stringify(op)} op={op} home={inv.home} onClose={() => setOp(null)} onApplied={onApplied} />}

      {toast && (
        <div className={`toast ${toast.bad ? 'bad' : ''}`} data-testid="toast">
          <Icon name={toast.bad ? 'stop' : 'check'} size={15} />
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              data-testid="toast-undo"
              onClick={() => {
                setOp({ kind: 'rollback', entryId: toast.undo! });
                setToast(null);
              }}
            >
              撤销
            </button>
          )}
        </div>
      )}
    </div>
  );
}

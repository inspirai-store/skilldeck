import { useState } from 'react';
import type { Inventory, RootReport, ScanDirectory } from '../core/types';
import type { HistoryItem } from './api';
import { CONFIDENCE_LABEL, DETECTION_LABEL, KIND_LABEL, SCOPE_LABEL, SOURCE_LABEL, baseName, fmtTime, tilde } from './meta';
import { AgentChip, CopyButton, EvidenceList, Icon, IssueList, PathText } from './ui';

function RootRow({ r, home }: { r: RootReport; home: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className={`${r.exists ? '' : 'absent'} ${open ? 'open' : ''}`} onClick={() => setOpen(!open)}>
        <td>
          <div className="c-path">
          <span className={`caret ${open ? 'down' : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
          <span className="mono" title={r.dir}>
            {tilde(r.dir, home)}
          </span>
          {r.readOnly && <Icon name="lock" size={12} />}
          {r.error && (
            <span className="err-mark">
              <Icon name="warn" size={13} />
            </span>
          )}
  </div>
        </td>
        <td>
          {SCOPE_LABEL[r.scope]}
          {r.project ? ` · ${baseName(r.project)}` : ''}
        </td>
        <td>{r.sourceKind ? SOURCE_LABEL[r.sourceKind] : CONFIDENCE_LABEL[r.confidence]}</td>
        <td className="num">{r.exists ? r.count : '—'}</td>
      </tr>
      {open && (
        <tr className="root-detail">
          <td colSpan={4}>
            {r.error && <IssueList items={[{ level: 'error', code: 'root', text: r.error }]} />}
            <EvidenceList
              home={home}
              items={[
                { ok: true, text: r.rule, url: r.source.url || undefined },
                { ok: r.exists, text: r.exists ? '目录存在' : '目录不存在', path: r.dir },
                ...(r.evidence || []),
              ]}
            />
          </td>
        </tr>
      )}
    </>
  );
}

export function ScopeView({
  inv,
  scanDirs,
  onAddProject,
  onRemoveProject,
  onAddScanDir,
  onRemoveScanDir,
}: {
  inv: Inventory;
  scanDirs: ScanDirectory[];
  onAddProject: () => void;
  onRemoveProject: (p: string) => void;
  onAddScanDir: () => void;
  onRemoveScanDir: (id: string) => void;
}) {
  const issues = inv.discoveryIssues || [];
  const agentName = (id: string) => inv.agents.find((a) => a.id === id)?.name || id;
  return (
    <div className="page" data-testid="scope-view">
      <div className="stat-row">
        <div className="stat">
          <b>{inv.agents.filter((a) => a.detection !== 'absent').length}</b>
          <span>智能体</span>
        </div>
        <div className="stat">
          <b>{inv.roots.filter((r) => r.exists).length}</b>
          <span>目录</span>
        </div>
        <div className="stat">
          <b>{inv.skills.length}</b>
          <span>Skills</span>
        </div>
        <div className="stat">
          <b>{inv.durationMs} ms</b>
          <span>{fmtTime(inv.scannedAt)}</span>
        </div>
      </div>

      {issues.length > 0 && (
        <section className="card">
          <h3>发现诊断 {issues.length}</h3>
          <ul className="diag">
            {issues.map((i, k) => (
              <li key={k} className={`lv-${i.level}`}>
                <AgentChip id={i.agent} />
                <div>
                  <div>{i.text}</div>
                  {i.path && <PathText path={i.path} home={inv.home} />}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="two-col">
        <section className="card">
          <h3>
            项目
            <button className="icon-btn" data-testid="add-project" onClick={onAddProject} aria-label="添加项目">
              <Icon name="plus" size={14} />
            </button>
          </h3>
          <ul className="plain">
            {inv.projects.map((p) => (
              <li key={p.path}>
                <Icon name="folder" size={14} />
                <span className="mono grow" title={p.path}>
                  {tilde(p.path, inv.home)}
                </span>
                <span className="tag">{p.origin === 'manual' ? '手动' : p.origin === 'claude' ? 'Claude 记录' : 'Codex 记录'}</span>
                <button className="icon-btn ghost" onClick={() => onRemoveProject(p.path)} aria-label="移除">
                  <Icon name="x" size={13} />
                </button>
              </li>
            ))}
            {!inv.projects.length && <li className="empty">无</li>}
          </ul>
        </section>
        <section className="card">
          <h3>
            手动扫描目录
            <button className="icon-btn" data-testid="add-scan-dir" onClick={onAddScanDir} aria-label="添加扫描目录">
              <Icon name="plus" size={14} />
            </button>
          </h3>
          <ul className="plain">
            {scanDirs.map((d) => (
              <li key={d.id}>
                <AgentChip id={d.agent} title={agentName(d.agent)} />
                <span className="mono grow" title={d.path}>
                  {tilde(d.path, inv.home)}
                </span>
                {d.readOnly && <Icon name="lock" size={12} />}
                <span className="tag">{d.layout === 'skill' ? '单个' : '集合'}</span>
                <button className="icon-btn ghost" onClick={() => onRemoveScanDir(d.id)} aria-label="移除">
                  <Icon name="x" size={13} />
                </button>
              </li>
            ))}
            {!scanDirs.length && <li className="empty">无</li>}
          </ul>
        </section>
      </div>

      {inv.agents.map((a) => {
        const roots = inv.roots.filter((r) => r.agent === a.id);
        return (
          <section className="card agent-card" key={a.id} data-testid={`scope-${a.id}`}>
            <h3>
              <AgentChip id={a.id} size="lg" />
              {a.name}
              <span className="muted">{a.vendor}</span>
              <span className={`pill det-${a.detection}`}>{DETECTION_LABEL[a.detection]}</span>
              <span className="grow" />
              {a.docs.map((d) => (
                <span key={d.url} className="doc" title={d.url}>
                  {d.title}
                  <CopyButton text={d.url} label="复制链接" />
                </span>
              ))}
            </h3>
            <dl className="agent-facts">
              <div>
                <dt>检测</dt>
                <dd>
                  <EvidenceList items={a.detectionEvidence} home={inv.home} />
                </dd>
              </div>
              <div>
                <dt>同名</dt>
                <dd>{a.collision === 'priority' ? '按优先级覆盖' : a.collision === 'duplicate' ? '并存不合并' : '未文档化'}</dd>
              </div>
              <div>
                <dt>开关</dt>
                <dd className="mono">{a.toggleRule}</dd>
              </div>
            </dl>
            {roots.length > 0 && (
              <table className="roots">
                <thead>
                  <tr>
                    <th>目录</th>
                    <th>范围</th>
                    <th>依据</th>
                    <th className="num">Skills</th>
                  </tr>
                </thead>
                <tbody>
                  {roots.map((r) => (
                    <RootRow key={r.id} r={r} home={inv.home} />
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function HistoryView({ items, onRollback }: { items: HistoryItem[]; onRollback: (id: string) => void }) {
  return (
    <div className="page" data-testid="history-view">
      {!items.length && <div className="empty big">暂无操作</div>}
      <ul className="history">
        {items.map((e) => (
          <li key={e.id} className={e.status === 'rolledBack' ? 'rolled' : ''} data-testid="history-item">
            <span className="h-time">{fmtTime(e.time)}</span>
            <span className="tag">{KIND_LABEL[e.rollbackOf ? 'rollback' : e.kind] || e.kind}</span>
            <span className="h-title">{e.title}</span>
            <span className="muted">{e.stepCount} 步</span>
            {e.status === 'rolledBack' ? (
              <span className="pill st-disabled">已回滚</span>
            ) : e.rollbackOf ? (
              <span />
            ) : (
              <button data-testid="history-rollback" onClick={() => onRollback(e.id)}>
                <Icon name="undo" size={14} />
                回滚
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

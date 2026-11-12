import { useEffect, useState } from 'react';
import type { Binding, Inventory, SkillRecord } from '../core/types';
import { type SkillFiles, api } from './api';
import { FileDialog } from './dialogs';
import { SCOPE_LABEL, baseName, bindingMatches, fmtSize, fmtTime, type Filters } from './meta';
import { AgentChip, EvidenceList, Icon, IssueList, PathText, Segmented, StatusPill } from './ui';

export type Action = 'edit' | 'toggle' | 'transfer' | 'archive' | 'delete' | 'restore';

function fmValue(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v);
}

export function Detail({
  inv,
  skill,
  filters,
  bindingId,
  onSelectBinding,
  onAction,
  onClose,
}: {
  inv: Inventory;
  skill: SkillRecord;
  filters: Filters;
  bindingId: string | null;
  onSelectBinding: (id: string) => void;
  onAction: (a: Action, skill: SkillRecord, b: Binding, content: string | null) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'where' | 'md' | 'files' | 'meta'>('where');
  const [data, setData] = useState<SkillFiles | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const b = skill.bindings.find((x) => x.id === bindingId) || skill.bindings.find((x) => bindingMatches(x, filters) && (!filters.status || x.status === filters.status)) || skill.bindings[0];
  const agentName = (id: string) => inv.agents.find((a) => a.id === id)?.name || id;

  useEffect(() => {
    let live = true;
    setData(null);
    api.readSkill(skill.id).then(
      (d) => live && setData(d),
      () => live && setData({ content: null, files: [] }),
    );
    return () => {
      live = false;
    };
  }, [skill.id, skill.mtime, inv.scannedAt]);

  const archived = b.status === 'archived';
  const locked = b.readOnly;
  const canToggle = b.toggle !== 'none' && !locked;
  const isOff = b.status === 'disabled';
  const hasMd = skill.hasSkillMd || skill.markerDisabled;
  const act = (a: Action) => onAction(a, skill, b, data?.content ?? null);

  return (
    <aside className="detail" data-testid="detail">
      <header className="detail-head">
        <div className="detail-title">
          <h2 title={skill.name}>{skill.name}</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        {skill.description && <p className="detail-desc">{skill.description}</p>}
        <div className="facts">
          <span>{skill.fileCount} 个文件</span>
          <span>{fmtSize(skill.size)}</span>
          <span>{fmtTime(skill.mtime)}</span>
          {skill.hasScripts && <span className="tag">scripts</span>}
        </div>
      </header>

      <div className="actions" data-testid="actions">
        {archived ? (
          <>
            <button className="primary" data-testid="act-restore" onClick={() => act('restore')}>
              <Icon name="restore" />
              恢复
            </button>
            <button className="danger" data-testid="act-delete" onClick={() => act('delete')}>
              <Icon name="trash" />
              删除
            </button>
          </>
        ) : (
          <>
            <button data-testid="act-toggle" disabled={!canToggle} onClick={() => act('toggle')}>
              <Icon name="power" />
              {isOff ? '启用' : '禁用'}
            </button>
            <button data-testid="act-edit" disabled={locked || !hasMd || !data || data.content == null} onClick={() => act('edit')}>
              <Icon name="edit" />
              编辑
            </button>
            <button data-testid="act-transfer" disabled={!hasMd} onClick={() => act('transfer')}>
              <Icon name="transfer" />
              复制/迁移
            </button>
            <button data-testid="act-archive" disabled={locked} onClick={() => act('archive')}>
              <Icon name="archive" />
              归档
            </button>
            <button className="danger" data-testid="act-delete" disabled={locked} onClick={() => act('delete')}>
              <Icon name="trash" />
              删除
            </button>
          </>
        )}
      </div>

      <div className="detail-tabs">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { id: 'where', label: `位置 ${skill.bindings.length}` },
            { id: 'md', label: 'SKILL.md' },
            { id: 'files', label: `文件 ${skill.fileCount}` },
            { id: 'meta', label: '元数据' },
          ]}
        />
      </div>

      <div className="detail-body">
        {tab === 'where' && (
          <ul className="bindings">
            {skill.bindings.map((x) => {
              const on = x.id === b.id;
              return (
                <li key={x.id} className={on ? 'on' : ''} data-testid={`binding-${x.agent}`}>
                  <button className="binding-head" onClick={() => onSelectBinding(x.id)} aria-expanded={on}>
                    <AgentChip id={x.agent} size="lg" />
                    <span className="binding-main">
                      <span className="binding-agent">
                        {agentName(x.agent)}
                        <span className="muted">
                          {SCOPE_LABEL[x.scope]}
                          {x.project ? ` · ${baseName(x.project)}` : ''}
                        </span>
                      </span>
                      <span className="binding-name">
                        {x.invocableName}
                        {x.isSymlink && <Icon name="link" size={12} />}
                        {x.readOnly && <Icon name="lock" size={12} />}
                      </span>
                    </span>
                    <StatusPill status={x.status} />
                  </button>
                  {on && (
                    <div className="binding-body">
                      <PathText path={x.entryPath} home={inv.home} />
                      {x.tags.length > 0 && (
                        <div className="tags">
                          {x.tags.map((t) => (
                            <span key={t} className="tag">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      <IssueList items={x.issues} />
                      <EvidenceList items={x.evidence} home={inv.home} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {tab === 'md' && (!data ? <div className="loading" /> : data.content == null ? <div className="empty">无 SKILL.md</div> : <pre className="code" data-testid="skill-md">{data.content}</pre>)}
        {tab === 'files' &&
          (!data ? (
            <div className="loading" />
          ) : (
            <ul className="files">
              {data.files.map((f) => {
                const depth = f.rel.split('/').length - 1;
                return (
                  <li key={f.rel} style={{ paddingLeft: 10 + depth * 16 }} className={f.dir ? 'dir' : ''} onClick={() => !f.dir && setFile(f.rel)}>
                    <Icon name={f.dir ? 'folder' : 'file'} size={14} />
                    <span className="file-name">{baseName(f.rel)}</span>
                    {!f.dir && <span className="muted">{fmtSize(f.size)}</span>}
                  </li>
                );
              })}
            </ul>
          ))}
        {tab === 'meta' && (
          <>
            {skill.parseError && <IssueList items={[{ level: 'error', code: 'yaml', text: skill.parseError }]} />}
            <dl className="meta">
              {Object.entries(skill.frontmatter || {}).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{fmValue(v)}</dd>
                </div>
              ))}
              <div>
                <dt>目录</dt>
                <dd>
                  <PathText path={skill.realPath} home={inv.home} />
                </dd>
              </div>
            </dl>
          </>
        )}
      </div>
      {file && <FileDialog skill={skill} rel={file} onClose={() => setFile(null)} />}
    </aside>
  );
}

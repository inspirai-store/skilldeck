import { useEffect, useMemo, useRef, useState } from 'react';
import type { Binding, Change, Inventory, Issue, JournalEntry, Op, Plan, SkillRecord } from '../core/types';
import { api } from './api';
import { baseName, tilde } from './meta';
import { AgentChip, Field, Icon, IssueList, Modal, Segmented, TargetPicker, writableRoots } from './ui';

const ACTION: Record<Change['action'], { icon: string; label: string }> = {
  create: { icon: 'plus', label: '新建' },
  modify: { icon: 'edit', label: '修改' },
  delete: { icon: 'trash', label: '移除' },
  move: { icon: 'transfer', label: '移动' },
  copy: { icon: 'copy', label: '复制' },
  link: { icon: 'link', label: '链接' },
};

function Diff({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <span key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
          {l || ' '}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** Every write goes through here: preview, resolve conflicts explicitly, then apply. */
export function PlanDialog({ op: initial, home, onClose, onApplied }: { op: Op; home: string; onClose: () => void; onApplied: (e: JournalEntry) => void }) {
  const [op, setOp] = useState<Op>(initial);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    let live = true;
    setPlan(null);
    setError('');
    api
      .plan(op)
      .then((p) => live && setPlan(p))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [op]);

  const choose = (id: string) => {
    if (id === 'rename') setRenaming(true);
    else setOp({ ...op, choice: id } as Op);
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      onApplied(await api.apply(plan.id));
    } catch (e: any) {
      setError(e.message);
      setPlan(null);
      setBusy(false);
    }
  };
  const ready = !!plan && !plan.blockers.length && !plan.conflict;

  return (
    <Modal
      testId="plan-dialog"
      wide
      title={plan?.title || '预览'}
      onClose={onClose}
      footer={
        <>
          {plan?.backup && ready && (
            <span className="foot-note">
              <Icon name="archive" size={14} />
              自动备份
            </span>
          )}
          <span className="grow" />
          <button onClick={onClose}>取消</button>
          {error && !plan ? (
            <button className="primary" onClick={() => setOp({ ...op })}>
              重新预览
            </button>
          ) : (
            <button className="primary" data-testid="plan-apply" disabled={!ready || busy} onClick={apply}>
              应用
            </button>
          )}
        </>
      }
    >
      {!plan && !error && <div className="loading" />}
      {error && <IssueList items={[{ level: 'block', text: error }]} />}
      {plan && (
        <>
          <IssueList items={plan.blockers.map((text) => ({ level: 'block' as const, text }))} />
          {plan.conflict && (
            <div className="conflict" data-testid="plan-conflict">
              <div className="conflict-text">
                <Icon name="warn" />
                <span>{plan.conflict.text}</span>
              </div>
              {renaming ? (
                <form
                  className="conflict-actions"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newName.trim()) {
                      setRenaming(false);
                      setOp({ ...op, choice: 'rename', newName: newName.trim() } as Op);
                    }
                  }}
                >
                  <input autoFocus data-testid="rename-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="new-name" spellCheck={false} />
                  <button type="button" onClick={() => setRenaming(false)}>
                    返回
                  </button>
                  <button className="primary" data-testid="rename-confirm" disabled={!newName.trim()}>
                    确定
                  </button>
                </form>
              ) : (
                <div className="conflict-actions">
                  {plan.conflict.choices.map((c) => (
                    <button key={c.id} data-testid={`choice-${c.id}`} className={c.id === 'replace' || c.id === 'force' ? 'danger' : ''} onClick={() => choose(c.id)}>
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <IssueList items={plan.warnings} />
          {plan.changes.length > 0 && (
            <ol className="changes" data-testid="plan-changes">
              {plan.changes.map((c, i) => (
                <li key={i} className={`ch-${c.action}`}>
                  <div className="ch-head">
                    <span className="ch-badge">
                      <Icon name={ACTION[c.action].icon} size={13} />
                      {ACTION[c.action].label}
                    </span>
                    <span className="ch-path" title={c.path}>
                      {tilde(c.path, home)}
                    </span>
                    {c.to && (
                      <>
                        <Icon name="chevron" size={13} />
                        <span className="ch-path" title={c.to}>
                          {tilde(c.to, home)}
                        </span>
                      </>
                    )}
                  </div>
                  {c.detail && <div className="ch-detail">{c.detail}</div>}
                  {c.diff && <Diff text={c.diff} />}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Modal>
  );
}

export function EditorDialog({ skill, binding, initial, onClose, onPreview }: { skill: SkillRecord; binding: Binding; initial: string; onClose: () => void; onPreview: (op: Op) => void }) {
  const [text, setText] = useState(initial);
  const [issues, setIssues] = useState<Issue[]>([]);
  const timer = useRef<number>(0);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api.validate(binding.id, text).then(setIssues, () => setIssues([]));
    }, 250);
    return () => window.clearTimeout(timer.current);
  }, [text, binding.id]);
  const dirty = text !== initial;
  return (
    <Modal
      testId="editor-dialog"
      wide
      title={
        <>
          {skill.name}
          <span className="title-sub">SKILL.md</span>
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>取消</button>
          <button className="primary" data-testid="editor-preview" disabled={!dirty} onClick={() => onPreview({ kind: 'edit', bindingId: binding.id, content: text })}>
            预览修改
          </button>
        </>
      }
    >
      <textarea className="editor" data-testid="editor-text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus />
      <IssueList items={issues} />
    </Modal>
  );
}

function firstTarget(inv: Inventory, prefer?: string | null): { agent: string; rootId: string } {
  const order = [...(prefer ? [prefer] : []), ...inv.agents.filter((a) => a.detection !== 'absent').map((a) => a.id), ...inv.agents.map((a) => a.id)];
  for (const a of order) {
    const r = writableRoots(inv.roots, a)[0];
    if (r) return { agent: a, rootId: r.id };
  }
  return { agent: '', rootId: '' };
}

export function CreateDialog({ inv, preferAgent, startMode, onClose, onPreview }: { inv: Inventory; preferAgent: string | null; startMode: 'create' | 'import'; onClose: () => void; onPreview: (op: Op) => void }) {
  const [mode, setMode] = useState(startMode);
  const [target, setTarget] = useState(() => firstTarget(inv, preferAgent));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [source, setSource] = useState('');
  const ok = !!target.rootId && (mode === 'create' ? !!name.trim() && !!description.trim() : !!source.trim());
  const submit = () => {
    if (mode === 'create') onPreview({ kind: 'create', rootId: target.rootId, name: name.trim(), description, body });
    else onPreview({ kind: 'import', rootId: target.rootId, sourcePath: source.trim(), ...(name.trim() ? { newName: name.trim() } : {}) });
  };
  return (
    <Modal
      testId="create-dialog"
      title={<Segmented value={mode} onChange={setMode} options={[{ id: 'create', label: '新建' }, { id: 'import', label: '导入目录' }]} />}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>取消</button>
          <button className="primary" data-testid="create-preview" disabled={!ok} onClick={submit}>
            预览
          </button>
        </>
      }
    >
      <TargetPicker agents={inv.agents} roots={inv.roots} home={inv.home} agent={target.agent} rootId={target.rootId} onChange={(agent, rootId) => setTarget({ agent, rootId })} />
      {mode === 'import' && (
        <Field label="来源目录">
          <input data-testid="import-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder={inv.platform === 'win32' ? 'C:\\path\\to\\skill' : '/path/to/skill'} spellCheck={false} autoFocus />
        </Field>
      )}
      <Field label={mode === 'create' ? '名称' : '重命名'}>
        <input data-testid="create-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-skill" spellCheck={false} autoFocus={mode === 'create'} maxLength={64} />
      </Field>
      {mode === 'create' && (
        <>
          <Field label="描述">
            <textarea data-testid="create-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1024} />
          </Field>
          <Field label="正文">
            <textarea data-testid="create-body" className="mono" rows={8} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} />
          </Field>
        </>
      )}
    </Modal>
  );
}

export function TransferDialog({ inv, skill, binding, onClose, onPreview }: { inv: Inventory; skill: SkillRecord; binding: Binding; onClose: () => void; onPreview: (op: Op) => void }) {
  const others = useMemo(() => inv.agents.filter((a) => a.id !== binding.agent && writableRoots(inv.roots, a.id).length), [inv, binding.agent]);
  const [target, setTarget] = useState(() => {
    const a = others.find((x) => x.detection !== 'absent' && !skill.bindings.some((b) => b.agent === x.id)) || others[0];
    return a ? { agent: a.id, rootId: writableRoots(inv.roots, a.id)[0].id } : firstTarget(inv);
  });
  const [mode, setMode] = useState<'copy' | 'move' | 'link'>('copy');
  return (
    <Modal
      testId="transfer-dialog"
      title={
        <>
          <AgentChip id={binding.agent} />
          {skill.name}
        </>
      }
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>取消</button>
          <button className="primary" data-testid="transfer-preview" disabled={!target.rootId} onClick={() => onPreview({ kind: 'transfer', bindingId: binding.id, targetRootId: target.rootId, mode })}>
            检查并预览
          </button>
        </>
      }
    >
      <Field label="方式">
        <Segmented
          testId="transfer-mode"
          value={mode}
          onChange={setMode}
          options={[
            { id: 'copy', label: '复制' },
            { id: 'move', label: '迁移', disabled: binding.readOnly },
            { id: 'link', label: '符号链接' },
          ]}
        />
      </Field>
      <TargetPicker agents={inv.agents} roots={inv.roots} home={inv.home} agent={target.agent} rootId={target.rootId} onChange={(agent, rootId) => setTarget({ agent, rootId })} />
    </Modal>
  );
}

export function PathDialog({ inv, kind, onClose, onDone }: { inv: Inventory; kind: 'project' | 'scanDir'; onClose: () => void; onDone: (inv: Inventory) => void }) {
  const [path, setPath] = useState('');
  const [agent, setAgent] = useState(inv.agents[0]?.id || '');
  const [layout, setLayout] = useState<'auto' | 'collection' | 'skill'>('auto');
  const [writable, setWritable] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const p = path.trim();
      onDone(kind === 'project' ? await api.addProject(p) : await api.addScanDirectory({ agent, path: p, readOnly: !writable, ...(layout === 'auto' ? {} : { layout }) }));
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      testId="path-dialog"
      title={kind === 'project' ? '添加项目' : '添加扫描目录'}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>取消</button>
          <button className="primary" data-testid="path-submit" disabled={!path.trim() || busy} onClick={submit}>
            添加
          </button>
        </>
      }
    >
      <Field label="目录">
        <input
          data-testid="path-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && path.trim() && void submit()}
          placeholder={inv.platform === 'win32' ? 'C:\\path\\to\\dir' : '/path/to/dir'}
          spellCheck={false}
          autoFocus
        />
      </Field>
      {kind === 'scanDir' && (
        <>
          <div className="row-2">
            <Field label="智能体">
              <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                {inv.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="结构">
              <Segmented
                value={layout}
                onChange={setLayout}
                options={[
                  { id: 'auto', label: '自动' },
                  { id: 'collection', label: '集合' },
                  { id: 'skill', label: '单个' },
                ]}
              />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={writable} onChange={(e) => setWritable(e.target.checked)} />
            允许修改
          </label>
        </>
      )}
      {error && <IssueList items={[{ level: 'block', text: error }]} />}
    </Modal>
  );
}

export function FileDialog({ skill, rel, onClose }: { skill: SkillRecord; rel: string; onClose: () => void }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    api.readFile(skill.id, rel).then(
      (r) => setText(r.text),
      () => setText(null),
    );
  }, [skill.id, rel]);
  return (
    <Modal
      wide
      title={
        <>
          {baseName(rel)}
          <span className="title-sub">{rel}</span>
        </>
      }
      onClose={onClose}
    >
      {text === undefined ? <div className="loading" /> : text === null ? <div className="empty">无法以文本显示</div> : <pre className="code">{text}</pre>}
    </Modal>
  );
}

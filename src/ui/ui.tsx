import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AgentReport, Evidence, Issue, RootReport, Status } from '../core/types';
import { SCOPE_LABEL, STATUS_LABEL, agentStyle, baseName, copyText, tilde } from './meta';

const PATHS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-3.6-3.6',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.4L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.4l1.7-1.9m0 4.5v-4.5h-4.5',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  minus: 'M6 12h12',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  archive: 'M4 5h16v4H4zM6 9v10h12V9M10 13h4',
  restore: 'M4 12a8 8 0 1 0 2.6-5.9L4 8.5M4 4v4.5h4.5M12 8v4.5l3 2',
  transfer: 'M4 8h13m0 0-3.5-3.5M17 8l-3.5 3.5M20 16H7m0 0 3.5-3.5M7 16l3.5 3.5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z',
  folder: 'M3 7h6l2 2h10v10H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  layers: 'M12 3 3 8l9 5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
  history: 'M4 12a8 8 0 1 0 2.6-5.9L4 8.5M4 4v4.5h4.5M12 8v4.5l3 2',
  radar: 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 12l7-7',
  warn: 'M12 4 2.5 20h19zM12 10v4.5M12 17.2v.3',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.3',
  stop: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 6l12 12',
  chevron: 'M9 6l6 6-6 6',
  import: 'M12 4v11m0 0-4-4m4 4 4-4M5 19h14',
  undo: 'M9 7 4 12l5 5M4 12h10a6 6 0 0 1 0 12h-2',
  power: 'M12 3v9M6.3 7a8 8 0 1 0 11.4 0',
  sort: 'M7 5v14m0 0-3-3m3 3 3-3M17 19V5m0 0-3 3m3-3 3 3',
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function AgentChip({ id, status, title, dim, size = 'md' }: { id: string; status?: Status; title?: string; dim?: boolean; size?: 'md' | 'lg' }) {
  const s = agentStyle(id);
  return (
    <span className={`agent-chip ${size} ${dim ? 'dim' : ''}`} style={{ ['--hue' as string]: s.hue }} title={title}>
      {s.code}
      {status && <i className={`dot st-${status}`} />}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`pill st-${status}`}>
      <i className={`dot st-${status}`} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-btn ghost"
      title={label || '复制'}
      aria-label={label || '复制'}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={13} />
    </button>
  );
}

export function PathText({ path, home }: { path: string; home: string }) {
  return (
    <span className="path" title={path}>
      <span className="path-text">{tilde(path, home)}</span>
      <CopyButton text={path} label="复制路径" />
    </span>
  );
}

export function EvidenceList({ items, home }: { items: Evidence[]; home: string }) {
  return (
    <ul className="evidence">
      {items.map((e, i) => (
        <li key={i} className={e.ok === true ? 'ok' : e.ok === false ? 'bad' : 'neutral'}>
          <span className="ev-mark">
            <Icon name={e.ok === true ? 'check' : e.ok === false ? 'x' : 'minus'} size={12} />
          </span>
          <div>
            <div className="ev-text">{e.text}</div>
            {e.path && <PathText path={e.path} home={home} />}
            {e.url && (
              <span className="path" title={e.url}>
                <span className="path-text url">{e.url.replace(/^https?:\/\//, '')}</span>
                <CopyButton text={e.url} label="复制链接" />
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function IssueList({ items }: { items: (Issue | { level: 'block'; text: string; code?: string })[] }) {
  if (!items.length) return null;
  return (
    <ul className="issues">
      {items.map((i, k) => (
        <li key={k} className={`lv-${i.level}`}>
          <Icon name={i.level === 'block' || i.level === 'error' ? 'stop' : i.level === 'warn' ? 'warn' : 'info'} size={14} />
          <span>{i.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Modal({ title, onClose, children, footer, wide, testId }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Only the topmost dialog reacts.
      const all = document.querySelectorAll('.modal');
      if (all[all.length - 1] === ref.current) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} ref={ref} role="dialog" aria-modal data-testid={testId}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, testId }: { value: T; options: { id: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="segmented" role="tablist" data-testid={testId}>
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={o.id === value} className={o.id === value ? 'on' : ''} disabled={o.disabled} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Writable collection roots an operation may target, grouped for a native select. */
export function writableRoots(roots: RootReport[], agent: string): RootReport[] {
  const seen = new Set<string>();
  return roots.filter((r) => {
    if (r.agent !== agent || r.readOnly || r.singleSkill || r.lazy || (r.scope !== 'user' && r.scope !== 'project') || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

export function TargetPicker({
  agents,
  roots,
  home,
  agent,
  rootId,
  onChange,
}: {
  agents: AgentReport[];
  roots: RootReport[];
  home: string;
  agent: string;
  rootId: string;
  onChange: (agent: string, rootId: string) => void;
}) {
  const usable = agents.filter((a) => writableRoots(roots, a.id).length);
  const list = writableRoots(roots, agent);
  const users = list.filter((r) => r.scope === 'user');
  const projects = [...new Set(list.filter((r) => r.project).map((r) => r.project!))];
  const opt = (r: RootReport) => (
    <option key={r.id} value={r.id}>
      {tilde(r.dir, home)}
      {r.exists ? '' : '（将创建）'}
    </option>
  );
  return (
    <div className="row-2">
      <Field label="智能体">
        <select data-testid="target-agent" value={agent} onChange={(e) => onChange(e.target.value, writableRoots(roots, e.target.value)[0]?.id || '')}>
          {usable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="目录">
        <select data-testid="target-root" value={rootId} onChange={(e) => onChange(agent, e.target.value)}>
          {users.length > 0 && <optgroup label={SCOPE_LABEL.user}>{users.map(opt)}</optgroup>}
          {projects.map((p) => (
            <optgroup key={p} label={baseName(p)}>
              {list.filter((r) => r.project === p).map(opt)}
            </optgroup>
          ))}
        </select>
      </Field>
    </div>
  );
}

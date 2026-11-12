import type { Binding, Confidence, Detection, Scope, SkillRecord, Status } from '../core/types';

export const STATUS_ORDER: Status[] = ['active', 'unverified', 'disabled', 'invalid', 'conflict', 'archived', 'unknown'];

export const STATUS_LABEL: Record<Status, string> = {
  active: '确认生效',
  unverified: '未验证',
  disabled: '禁用',
  invalid: '无效',
  conflict: '冲突',
  archived: '归档',
  unknown: '未知',
};

/** Which status represents a row when several bindings match. */
const SEVERITY: Status[] = ['conflict', 'invalid', 'disabled', 'unknown', 'archived', 'unverified', 'active'];

export function headline(bindings: Binding[]): Status {
  for (const s of SEVERITY) if (bindings.some((b) => b.status === s)) return s;
  return 'unknown';
}

export const SCOPE_LABEL: Record<Scope, string> = { user: '用户级', project: '项目级', system: '系统', admin: '托管', plugin: '插件' };
export const CONFIDENCE_LABEL: Record<Confidence, string> = { documented: '官方文档', vendor: '厂商内置', observed: '本机观察' };
export const DETECTION_LABEL: Record<Detection, string> = { installed: '已安装', traces: '仅配置', absent: '未检测到' };
export const SOURCE_LABEL: Record<string, string> = { 'plugin-cache': '插件缓存', extension: '扩展', 'agent-config': '配置声明', custom: '手动登记' };
export const KIND_LABEL: Record<string, string> = {
  create: '新建',
  import: '导入',
  edit: '编辑',
  delete: '删除',
  toggle: '开关',
  archive: '归档',
  restore: '恢复',
  purge: '删除归档',
  transfer: '复制迁移',
  rollback: '回滚',
};

const AGENT_STYLE: Record<string, { code: string; hue: number }> = {
  claude: { code: 'CC', hue: 18 },
  codex: { code: 'CX', hue: 162 },
  cursor: { code: 'CU', hue: 220 },
  gemini: { code: 'GM', hue: 205 },
  opencode: { code: 'OC', hue: 42 },
  copilot: { code: 'CP', hue: 268 },
  kiro: { code: 'KR', hue: 285 },
  codebuddy: { code: 'CB', hue: 190 },
  antigravity: { code: 'AG', hue: 350 },
};

export function agentStyle(id: string): { code: string; hue: number } {
  if (AGENT_STYLE[id]) return AGENT_STYLE[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { code: id.slice(0, 2).toUpperCase(), hue: h };
}

export function tilde(p: string, home: string): string {
  if (!p) return p;
  if (p === home) return '~';
  return p.startsWith(home + '/') || p.startsWith(home + '\\') ? '~' + p.slice(home.length) : p;
}

export function baseName(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtTime(ms: number): string {
  // Package caches often carry epoch-zero timestamps; those are not real dates.
  if (!ms || ms < 86400000 * 365) return '—';
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDay(ms: number): string {
  return fmtTime(ms).slice(0, 10);
}

export interface Filters {
  agent: string | null;
  project: string | null;
  scope: 'all' | 'user' | 'project' | 'system';
  status: Status | null;
  query: string;
}

export function bindingMatches(b: Binding, f: Omit<Filters, 'status' | 'query'>): boolean {
  if (f.agent && b.agent !== f.agent) return false;
  if (f.project && b.project !== f.project) return false;
  if (f.scope === 'user' && b.scope !== 'user') return false;
  if (f.scope === 'project' && b.scope !== 'project') return false;
  if (f.scope === 'system' && (b.scope === 'user' || b.scope === 'project')) return false;
  return true;
}

export function queryMatches(s: SkillRecord, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = [s.name, s.dirName, s.description, s.realPath, ...s.bindings.flatMap((b) => [b.invocableName, b.entryPath, ...b.tags])].join('\n').toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

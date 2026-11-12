import type { DiscoveryIssue, Inventory, Issue, JournalEntry, Op, Plan, ScanDirectory } from '../core/types';

declare global {
  interface Window {
    skilldeck?: { call(method: string, params?: unknown): Promise<unknown> };
  }
}

export type HistoryItem = Omit<JournalEntry, 'steps' | 'post'> & { stepCount: number };
export interface SkillFiles {
  content: string | null;
  files: { rel: string; size: number; dir: boolean }[];
}
export type { DiscoveryIssue };

async function call<T>(method: string, params: unknown = {}): Promise<T> {
  if (!window.skilldeck) throw new Error('未连接到 SkillDeck 后端');
  try {
    return (await window.skilldeck.call(method, params)) as T;
  } catch (e) {
    // Electron prefixes remote errors with the channel name.
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

export const api = {
  scan: () => call<Inventory>('scan'),
  readSkill: (skillId: string) => call<SkillFiles>('readSkill', { skillId }),
  readFile: (skillId: string, rel: string) => call<{ text: string | null }>('readFile', { skillId, rel }),
  validate: (bindingId: string, content: string) => call<Issue[]>('validate', { bindingId, content }),
  plan: (op: Op) => call<Plan>('plan', { op }),
  apply: (planId: string) => call<JournalEntry>('apply', { planId }),
  history: () => call<HistoryItem[]>('history'),
  recoveryStatus: () => call<{ pending: unknown; locked: boolean }>('recoveryStatus'),
  addProject: (path: string) => call<Inventory>('addProject', { path }),
  removeProject: (path: string) => call<Inventory>('removeProject', { path }),
  listScanDirectories: () => call<ScanDirectory[]>('listScanDirectories'),
  addScanDirectory: (p: { agent: string; path: string; readOnly: boolean; layout?: 'collection' | 'skill' }) => call<Inventory>('addScanDirectory', p),
  removeScanDirectory: (id: string) => call<Inventory>('removeScanDirectory', { id }),
};

export type AgentId = string;
export type Scope = 'user' | 'project' | 'system' | 'admin' | 'plugin';
export type Status = 'active' | 'unverified' | 'disabled' | 'invalid' | 'conflict' | 'archived' | 'unknown';
export type Confidence = 'documented' | 'vendor' | 'observed';
export type Detection = 'installed' | 'traces' | 'absent';

export interface Ctx {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  dataDir: string;
}

export interface DocRef {
  title: string;
  url: string;
}

export interface RootSpec {
  id: string;
  agent: AgentId;
  scope: Scope;
  dir: string;
  project?: string;
  /** Rule text shown as evidence. */
  rule: string;
  source: DocRef;
  confidence: Confidence;
  /** Higher wins inside one agent. */
  priority: number;
  readOnly?: boolean;
  /** Prefix for the invocable name, e.g. a plugin name. */
  namespace?: string;
  /** Loaded on demand rather than at startup. */
  lazy?: boolean;
  ignore?: string[];
  pluginId?: string;
  /** Stable identity for an additional discovery source, separate from its directory. */
  singleSkill?: boolean;
  discoveryId?: string;
  sourceKind?: 'plugin-cache' | 'extension' | 'agent-config' | 'custom';
  evidence?: Evidence[];
  /** Static discovery cannot establish source activation/version selection. */
  loadState?: 'unknown';
}

export interface RootReport extends RootSpec {
  exists: boolean;
  count: number;
  error?: string;
}

export interface Issue {
  level: 'error' | 'warn' | 'info';
  code: string;
  text: string;
}

export interface Evidence {
  ok: boolean | null;
  text: string;
  path?: string;
  url?: string;
}

export interface Binding {
  id: string;
  agent: AgentId;
  rootId: string;
  entryPath: string;
  isSymlink: boolean;
  scope: Scope;
  project?: string;
  status: Status;
  invocableName: string;
  evidence: Evidence[];
  issues: Issue[];
  readOnly: boolean;
  /** official = agent config switch, marker = SKILL.md rename, none = not switchable */
  toggle: 'official' | 'marker' | 'none';
  tags: string[];
  archiveId?: string;
}

export interface SkillRecord {
  id: string;
  realPath: string;
  dirName: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown> | null;
  parseError?: string;
  hasSkillMd: boolean;
  markerDisabled: boolean;
  fileCount: number;
  size: number;
  mtime: number;
  hasScripts: boolean;
  bindings: Binding[];
}

export interface AgentReport {
  id: AgentId;
  name: string;
  vendor: string;
  detection: Detection;
  detectionEvidence: Evidence[];
  docs: DocRef[];
  collision: 'priority' | 'duplicate' | 'undocumented';
  toggleRule: string;
  counts: Partial<Record<Status, number>>;
}

export interface ProjectInfo {
  path: string;
  origin: 'manual' | 'claude' | 'codex';
  exists: boolean;
}

export interface DiscoveryIssue extends Issue {
  agent: AgentId;
  path?: string;
  url?: string;
}

export interface ScanDirectory {
  id: string;
  agent: AgentId;
  path: string;
  readOnly: boolean;
  layout?: 'collection' | 'skill';
}

export interface Inventory {
  scannedAt: number;
  durationMs: number;
  platform: string;
  home: string;
  dataDir: string;
  agents: AgentReport[];
  roots: RootReport[];
  skills: SkillRecord[];
  projects: ProjectInfo[];
  discoveryIssues?: DiscoveryIssue[];
}

export interface Change {
  action: 'create' | 'modify' | 'delete' | 'move' | 'copy' | 'link';
  path: string;
  to?: string;
  diff?: string;
  detail?: string;
}

export interface PlanChoice {
  id: string;
  label: string;
}

export interface Plan {
  id: string;
  kind: string;
  title: string;
  changes: Change[];
  warnings: Issue[];
  blockers: string[];
  /** Conflict that needs an explicit decision before the plan can apply. */
  conflict?: { text: string; choices: PlanChoice[] };
  backup: boolean;
}

export type Step =
  | { type: 'mkdir'; path: string }
  | { type: 'rmdir'; path: string }
  | { type: 'write'; path: string; content: string; backup?: string; existed?: boolean }
  | { type: 'move'; from: string; to: string }
  | { type: 'copy'; from: string; to: string }
  | { type: 'link'; target: string; path: string }
  | { type: 'trash'; path: string; backup?: string };

export interface JournalEntry {
  id: string;
  time: number;
  kind: string;
  title: string;
  steps: Step[];
  /** Fingerprints of touched paths right after applying. */
  post: Record<string, string>;
  status: 'applied' | 'rolledBack';
  rollbackOf?: string;
}

export interface ArchiveMeta {
  id: string;
  time: number;
  agent: AgentId;
  rootId: string;
  rootDir: string;
  scope: Scope;
  project?: string;
  originPath: string;
  dirName: string;
  wasSymlink: boolean;
  linkTarget?: string;
}

export interface AppConfig {
  projects: string[];
  hiddenProjects: string[];
  scanDirectories?: ScanDirectory[];
  [key: string]: unknown;
}

export type Op =
  | { kind: 'import'; sourcePath: string; rootId: string; newName?: string }
  | { kind: 'create'; rootId: string; name: string; description: string; body: string }
  | { kind: 'edit'; bindingId: string; content: string }
  | { kind: 'delete'; bindingId: string }
  | { kind: 'toggle'; bindingId: string; enable: boolean }
  | { kind: 'archive'; bindingId: string }
  | { kind: 'restore'; archiveId: string; choice?: string; newName?: string }
  | { kind: 'purge'; archiveId: string }
  | { kind: 'transfer'; bindingId: string; targetRootId: string; mode: 'copy' | 'move' | 'link'; choice?: string; newName?: string }
  | { kind: 'rollback'; entryId: string; force?: boolean; choice?: string };

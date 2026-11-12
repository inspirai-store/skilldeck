import type { Op } from './types';
import { Engine } from './engine';

function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('参数必须是对象');
  return v as Record<string, any>;
}
function str(v: unknown, field: string, empty = false): string {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.includes('\0')) throw new Error(`无效参数：${field}`);
  return v;
}
function choice(v: unknown, values: string[], field: string) {
  if (typeof v !== 'string' || !values.includes(v)) throw new Error(`无效参数：${field}`);
  return v;
}

/** Validated entry point shared by Electron IPC and the authenticated local HTTP bridge. */
export function dispatch(engine: Engine, method: string, input: unknown = {}): unknown {
  const p = object(input);
  switch (method) {
    case 'scan': return engine.scan();
    case 'recoveryStatus': return engine.recoveryStatus();
    case 'listScanDirectories': return engine.listScanDirectories();
    case 'addScanDirectory': {
      if (p.readOnly !== undefined && typeof p.readOnly !== 'boolean') throw new Error('readOnly 必须是布尔值');
      if (p.layout !== undefined) choice(p.layout, ['collection', 'skill'], 'layout');
      return engine.addScanDirectory(str(p.agent, 'agent'), str(p.path, 'path'), p.readOnly ?? true, p.layout);
    }
    case 'removeScanDirectory': return engine.removeScanDirectory(str(p.id, 'id'));
    case 'readSkill': return engine.readSkill(str(p.skillId, 'skillId'));
    case 'readFile': return engine.readFile(str(p.skillId, 'skillId'), str(p.rel, 'rel'));
    case 'validate': return engine.validate(str(p.bindingId, 'bindingId'), str(p.content, 'content', true));
    case 'plan': return engine.plan(normalize(p.op));
    case 'apply': return engine.apply(str(p.planId, 'planId'));
    case 'history': return engine.history().map(({ steps, post, ...e }) => ({ ...e, stepCount: steps.length }));
    case 'addProject': return engine.addProject(str(p.path, 'path'));
    case 'removeProject': return engine.removeProject(str(p.path, 'path'));
    default: throw new Error(`unknown method: ${method}`);
  }
}

export function normalize(input: unknown): Op {
  const op = object(input);
  const kind = str(op.kind, 'kind');
  const required: Record<string, string[]> = {
    create: ['rootId', 'name', 'description'], import: ['sourcePath', 'rootId'], edit: ['bindingId'],
    delete: ['bindingId'], toggle: ['bindingId'], archive: ['bindingId'], restore: ['archiveId'], purge: ['archiveId'],
    transfer: ['bindingId', 'targetRootId'], rollback: ['entryId'],
  };
  if (!Object.hasOwn(required, kind)) throw new Error('未知操作类型');
  for (const f of required[kind]) str(op[f], f);
  for (const f of ['choice', 'newName']) if (op[f] !== undefined) str(op[f], f);
  if (kind === 'create') str(op.body, 'body', true);
  if (kind === 'edit') str(op.content, 'content', true);
  if (kind === 'toggle' && typeof op.enable !== 'boolean') throw new Error('enable 必须是布尔值');
  if (kind === 'transfer') choice(op.mode, ['copy', 'move', 'link'], 'mode');
  if (op.choice !== undefined) choice(op.choice, kind === 'transfer' ? ['rename', 'replace'] : kind === 'restore' ? ['rename'] : kind === 'rollback' ? ['force'] : [], 'choice');
  if (kind === 'rollback') return { kind, entryId: op.entryId, choice: op.choice, force: op.choice === 'force' };
  return op as Op;
}

import YAML from 'yaml';
import type { Issue } from './types';

export interface ParsedSkill {
  hasFrontmatter: boolean;
  data: Record<string, unknown> | null;
  body: string;
  error?: string;
}

const FM = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillMd(text: string): ParsedSkill {
  const src = text.replace(/^﻿/, '');
  const m = FM.exec(src);
  if (!m) return { hasFrontmatter: false, data: null, body: src };
  const body = src.slice(m[0].length);
  try {
    const data = YAML.parse(m[1]);
    if (data == null) return { hasFrontmatter: true, data: {}, body };
    if (typeof data !== 'object' || Array.isArray(data)) return { hasFrontmatter: true, data: null, body, error: 'frontmatter 不是键值映射' };
    return { hasFrontmatter: true, data, body };
  } catch (e: any) {
    return { hasFrontmatter: true, data: null, body, error: String(e.message || e).split('\n')[0] };
  }
}

export function buildSkillMd(name: string, description: string, body: string): string {
  const fm = YAML.stringify({ name, description }, { lineWidth: 0 }).trimEnd();
  return `---\n${fm}\n---\n\n${body.replace(/^\n+/, '').trimEnd()}\n`;
}

export const SPEC_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ValidationRules {
  /** Fields whose absence makes the skill unloadable. */
  requires: ('name' | 'description')[];
  /** Agent rejects skills exceeding spec limits. */
  strictLimits: boolean;
  yamlErrorFatal: boolean;
  knownFields: string[];
}

export const SPEC_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];

export function validateSkill(p: ParsedSkill, dirName: string, rules: ValidationRules): Issue[] {
  const out: Issue[] = [];
  const fatal = (cond: boolean): Issue['level'] => (cond ? 'error' : 'warn');
  if (!p.hasFrontmatter) {
    out.push({ level: fatal(rules.requires.length > 0), code: 'no-frontmatter', text: 'SKILL.md 缺少 YAML frontmatter' });
    return out;
  }
  if (p.error || !p.data) {
    out.push({ level: fatal(rules.yamlErrorFatal), code: 'yaml', text: `frontmatter 解析失败：${p.error}` });
    return out;
  }
  const d = p.data;
  const name = d.name;
  const desc = d.description;
  if (name == null || name === '') {
    out.push({ level: fatal(rules.requires.includes('name')), code: 'name-missing', text: '缺少 name' });
  } else if (typeof name !== 'string') {
    out.push({ level: 'error', code: 'name-type', text: 'name 不是字符串' });
  } else {
    if (name.length > 64) out.push({ level: fatal(rules.strictLimits), code: 'name-long', text: `name 超过 64 字符（${name.length}）` });
    if (!SPEC_NAME.test(name)) out.push({ level: 'warn', code: 'name-chars', text: 'name 不符合 Agent Skills 规范（小写字母、数字、单连字符）' });
    if (name !== dirName) out.push({ level: 'warn', code: 'name-dir', text: `name「${name}」与目录名「${dirName}」不一致` });
  }
  if (desc == null || desc === '') {
    out.push({ level: fatal(rules.requires.includes('description')), code: 'desc-missing', text: '缺少 description' });
  } else if (typeof desc !== 'string') {
    out.push({ level: 'error', code: 'desc-type', text: 'description 不是字符串' });
  } else if (desc.length > 1024) {
    out.push({ level: fatal(rules.strictLimits), code: 'desc-long', text: `description 超过 1024 字符（${desc.length}）` });
  }
  if (typeof d.compatibility === 'string' && d.compatibility.length > 500) out.push({ level: 'warn', code: 'compat-long', text: 'compatibility 超过 500 字符' });
  const unknown = Object.keys(d).filter((k) => !rules.knownFields.includes(k));
  if (unknown.length) out.push({ level: 'info', code: 'unknown-fields', text: `未识别字段：${unknown.join(', ')}` });
  return out;
}

/** Rename only YAML metadata, preserving body and extension fields. */
export function renameSkillMd(text: string, name: string): string {
  const m = FM.exec(text.replace(/^\uFEFF/, ''));
  if (!m) throw new Error('缺少可编辑的 frontmatter');
  const doc = YAML.parseDocument(m[1]);
  if (doc.errors.length) throw new Error('frontmatter 无法解析');
  doc.set('name', name);
  return `---\n${doc.toString()}---\n${text.replace(/^\uFEFF/, '').slice(m[0].length)}`;
}

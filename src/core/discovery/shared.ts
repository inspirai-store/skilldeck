import fs from 'node:fs';
import path from 'node:path';
import { parseTree, getNodeValue, type ParseError } from 'jsonc-parser';
import type { DiscoveryIssue, DocRef } from '../types';
import { lstatSafe, readText, realFuture } from '../util';

/** Reader never evaluates expressions, loads env files, or follows referenced secrets. */
export function jsonObject(file: string, jsonc = false): Record<string, any> {
  const text = readText(file);
  if (text == null) throw new Error('文件无法读取或超过 2 MiB');
  const errors: ParseError[] = [];
  const tree = jsonc ? parseTree(text, errors, { allowTrailingComma: true }) : undefined;
  if (errors.length) throw new Error(`JSONC 解析失败，offset ${errors[0].offset}`);
  // getNodeValue uses null-prototype maps, including for a literal __proto__ key.
  const value = jsonc ? (tree ? getNodeValue(tree) : undefined) : JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('顶层必须是对象');
  return value;
}

export function problem(issues: DiscoveryIssue[], agent: string, code: string, text: string, file: string, doc: DocRef): void {
  issues.push({ agent, code, level: 'warn', text, path: file, url: doc.url });
}

/** Bounded, deterministic directory-only listing; linked packages are supported. */
export function directories(dir: string, max: number): string[] {
  if (!lstatSafe(dir)) return [];
  const names = fs.readdirSync(dir).sort();
  if (names.length > max) throw new Error(`发现目录条目超过 ${max}，未宣称完整扫描`);
  return names.filter((n) => !n.startsWith('.') && !n.endsWith('.lock')).map((n) => path.join(dir, n)).filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());
}

/** Plugin manifest paths must stay inside the package, including resolved links. */
export function packagePath(base: string, relative: unknown): string {
  if (typeof relative !== 'string' || !relative.startsWith('./') || relative.includes('\0') || relative.includes('\\') || relative.split('/').includes('..')) throw new Error('Skill 路径必须以 ./ 开头且不越出插件');
  const full = path.resolve(base, relative);
  const root = realFuture(base), real = realFuture(full);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('Skill 路径或符号链接越出插件');
  return full;
}

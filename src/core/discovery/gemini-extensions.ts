import path from 'node:path';
import type { Ctx } from '../types';
import { root, type DiscoveryResult } from '../adapters/base';
import { lstatSafe } from '../util';
import { directories, jsonObject, problem } from './shared';

export const GEMINI_EXTENSIONS_DOC = { title: 'Gemini CLI · Extension reference', url: 'https://geminicli.com/docs/extensions/reference/' };
const LINK_SOURCE = 'https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/extension-manager.ts';

export function discoverGeminiExtensions(ctx: Ctx): DiscoveryResult {
  const result: DiscoveryResult = { roots: [], issues: [] };
  const extensions = path.join(ctx.home, '.gemini', 'extensions');
  const enablementFile = path.join(extensions, 'extension-enablement.json');
  let enablement: Record<string, any> | undefined;
  if (lstatSafe(enablementFile)) {
    try { enablement = jsonObject(enablementFile); }
    catch { problem(result.issues, 'gemini', 'extension-enablement-unreadable', '扩展 enablement 文件无法解析，保留未知状态，不影响有效清单发现', enablementFile, GEMINI_EXTENSIONS_DOC); }
  }
  try {
    for (const installed of directories(extensions, 1000)) {
      const metadataFile = path.join(installed, '.gemini-extension-install.json');
      let effective = installed;
      const evidence = [{ ok: null, text: '本地扩展清单；未核实 extension enablement、工作区信任、安全策略或 CLI 覆盖参数', path: installed, url: GEMINI_EXTENSIONS_DOC.url }];
      try {
        if (lstatSafe(metadataFile)) {
          const metadata = jsonObject(metadataFile);
          if (metadata.type === 'link') {
            if (typeof metadata.source !== 'string' || !path.isAbsolute(metadata.source) || metadata.source.includes('\0')) throw new Error('linked extension source 必须是绝对目录');
            effective = metadata.source;
            evidence.push({ ok: null, text: '扩展安装元数据指向 linked source；仅读取，不执行扩展', path: metadataFile, url: LINK_SOURCE });
          }
        }
        const manifest = path.join(effective, 'gemini-extension.json');
        const pkg = jsonObject(manifest);
        if (typeof pkg.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.name) || typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error('扩展 name/version 无效');
        const overrides = enablement?.[pkg.name]?.overrides;
        if (Array.isArray(overrides) && overrides.every((r) => typeof r === 'string')) evidence.push({ ok: null, text: `本地 enablement 包含 ${overrides.length} 条路径覆盖；未计算工作区、CLI 覆盖及有效状态`, path: enablementFile, url: 'https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/extensions/extensionEnablement.ts' });
        else if (enablement && Object.hasOwn(enablement, pkg.name)) problem(result.issues, 'gemini', 'extension-enablement-shape', '扩展 enablement 条目格式未被识别，保留未知状态', enablementFile, GEMINI_EXTENSIONS_DOC);
        evidence.push({ ok: null, text: `扩展 ${pkg.name}，声明版本 ${pkg.version}`, path: manifest, url: GEMINI_EXTENSIONS_DOC.url });
        result.roots.push(root('gemini', { scope: 'plugin', dir: path.join(effective, 'skills'), priority: 100, readOnly: true,
          pluginId: pkg.name, sourceKind: 'extension', discoveryId: installed, source: GEMINI_EXTENSIONS_DOC,
          confidence: 'documented', rule: 'Gemini 扩展根 skills/<name>/SKILL.md，不添加扩展命令的命名空间', loadState: 'unknown', evidence }));
      } catch { problem(result.issues, 'gemini', 'extension-manifest-invalid', '扩展清单或 link 元数据无效/不可读取，已跳过；其他扩展继续扫描', installed, GEMINI_EXTENSIONS_DOC); }
    }
  } catch (e) { problem(result.issues, 'gemini', 'extension-discovery-incomplete', String(e), extensions, GEMINI_EXTENSIONS_DOC); }
  return result;
}

import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { Ctx } from '../types';
import { root, type DiscoveryResult } from '../adapters/base';
import { lstatSafe, readText } from '../util';
import { directories, jsonObject, packagePath, problem } from './shared';

export const CODEX_PLUGINS_DOC = { title: 'OpenAI · Package your plugin', url: 'https://developers.openai.com/plugins/build/plugins' };
const CONFIG_DOC = { title: 'Codex · Config reference', url: 'https://developers.openai.com/codex/config-reference' };

/** Cache presence is observed layout evidence, never installation or version-selection proof. */
export function discoverCodexPlugins(ctx: Ctx): DiscoveryResult {
  const result: DiscoveryResult = { roots: [], issues: [] };
  const home = ctx.env.CODEX_HOME || path.join(ctx.home, '.codex');
  const cache = path.join(home, 'plugins', 'cache');
  const configFile = path.join(home, 'config.toml');
  let plugins: any;
  if (lstatSafe(configFile)) {
    try { const text = readText(configFile); if (text == null) throw new Error('配置无法读取'); plugins = (parseToml(text) as any).plugins; }
    catch { problem(result.issues, 'codex', 'plugin-config-unreadable', '插件配置无法解析，不能推断启用状态', configFile, CONFIG_DOC); }
  }
  let remaining = 4000;
  const children = (dir: string, max: number) => {
    if (--remaining < 0) throw new Error('插件缓存目录访问超过 4000，扫描已截断');
    return directories(dir, max);
  };
  try {
    for (const market of children(cache, 256)) for (const plugin of children(market, 1000)) {
      for (const version of children(plugin, 256)) {
        if (--remaining < 0) throw new Error('插件缓存候选超过 4000，扫描已截断');
        const portable = path.join(version, 'plugin.json');
        const compatibility = path.join(version, '.codex-plugin', 'plugin.json');
        const manifest = lstatSafe(portable) ? portable : compatibility;
        if (!lstatSafe(manifest)) continue;
        try {
          const pkg = jsonObject(manifest);
          if (typeof pkg.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.name)) throw new Error('插件 name 无效');
          if (manifest === portable && pkg.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw new Error('未支持的 portable plugin schema，未猜测兼容格式');
          const skills = manifest === portable ? './skills/' : pkg.skills;
          if (skills == null) continue; // compatibility manifest without skills has no declared skill source
          const dir = packagePath(version, skills);
          const id = `${pkg.name}@${path.basename(market)}`;
          const evidence = [
            { ok: null, text: '发现缓存中的插件清单；缓存不证明已安装、版本被选中或当前会话启用', path: manifest, url: CODEX_PLUGINS_DOC.url },
            { ok: null, text: `缓存版本目录：${path.basename(version)}；未比较版本号或擅自选择最新版本`, path: version },
          ];
          if (typeof pkg.version === 'string') evidence.push({ ok: null, text: `清单声明版本：${pkg.version}`, path: manifest });
          if (path.basename(plugin) !== pkg.name) evidence.push({ ok: null, text: '缓存目录名与清单名称不一致，不据此推断安装身份', path: plugin });
          const enabled = plugins?.[id]?.enabled;
          if (typeof enabled === 'boolean') evidence.push({ ok: null, text: `用户层 plugins[${JSON.stringify(id)}].enabled = ${enabled}；未合并可信项目、托管或工作区状态`, path: configFile, url: CONFIG_DOC.url });
          if (typeof plugins?._default?.enabled === 'boolean') evidence.push({ ok: null, text: `用户层 plugins._default.enabled = ${plugins._default.enabled}；未推断源或工作区的最终激活状态`, path: configFile, url: CONFIG_DOC.url });
          result.roots.push(root('codex', { scope: 'plugin', dir, priority: 50, readOnly: true, pluginId: id, namespace: pkg.name,
            confidence: 'observed', source: CODEX_PLUGINS_DOC, rule: '插件包 skills 清单规则已核对；本地 plugins/cache 位置仅为观察证据',
            sourceKind: 'plugin-cache', discoveryId: manifest, loadState: 'unknown', evidence }));
        } catch { problem(result.issues, 'codex', 'plugin-manifest-invalid', '插件清单、schema 或 Skill 路径无效，已跳过；其他候选继续扫描', manifest, CODEX_PLUGINS_DOC); }
      }
    }
  } catch (e) { problem(result.issues, 'codex', 'plugin-cache-incomplete', String(e), cache, CODEX_PLUGINS_DOC); }
  return result;
}

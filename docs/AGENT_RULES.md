# 智能体规则核对

核对日期：2026-11-12。以下为目录型 Skill 的本地后端适配，所有运行时结果均保持未验证。链接是规范来源，不是此版本客户端已经运行验收的证据。

| 智能体 | 本次核对的规则及采用方式 | 官方来源 |
| --- | --- | --- |
| Claude Code | 个人/项目 `.claude/skills`，托管优先；嵌套 Skill 按需加载并有目录限定名称。持久可见性用 `skillOverrides`；插件不适用此开关，插件与同步目录只读。权限限制保留。 | [Skills](https://code.claude.com/docs/en/skills)、[Plugins](https://code.claude.com/docs/en/plugins-reference) |
| Codex | 用户 `.agents/skills`、项目启动目录至 Git 根的各级 `.agents/skills`、admin/system；同名不合并。`[[skills.config]]` 每条一个绝对文件 path 或 name 选择器，最后匹配规则优先。启用/禁用追加单路径 true/false，不删除全局同名限制。`.codex/skills` 单独注明 vendor/observed 证据。缓存候选按清单只读发现，全部保留 unknown；portable 固定 skills/，兼容格式读取声明路径。 | [Build skills](https://developers.openai.com/codex/skills)、[Config reference](https://developers.openai.com/codex/config-reference)、[Package your plugin](https://developers.openai.com/plugins/build/plugins) |
| Gemini CLI | 用户与项目 `.gemini/skills`、`.agents/skills`；项目优先，同层 `.agents` 优先。`skills.disabled` 持久列表，`skills.enabled` 功能开关；不会为启用某一个 Skill 自动解除全局功能关闭。扩展目录清单及 skills/ 只读发现，不将扩展命令命名空间套给 Skill；启用求值保留未知。 | [Skills](https://geminicli.com/docs/cli/skills/)、[Configuration](https://geminicli.com/docs/reference/configuration/)、[Extension reference](https://geminicli.com/docs/extensions/reference/) |
| Cursor | `.cursor/skills`、`.agents/skills` 及 Claude/Codex 兼容目录；支持分组递归，身份来自 Skill 文件夹。嵌套项目目录具有子目录作用域；同名取舍不猜测。用户本地目录不推断为云端可用。 | [Skills](https://cursor.com/docs/skills) |
| OpenCode | 原生/Claude/Agents 兼容目录；按目录 ID、区分大小写、后注册覆盖；V2 frontmatter 可选，description 影响模型展示。当前覆盖目录型及六层递归，根级单 Markdown 仅报告未支持管理的诊断；已读取系统/全局/项目 JSON/JSONC 的本地 skills[]，相对来源按启动目录解析；远程 catalog 与替换表达式仅返回未解析诊断。 | [Skills](https://opencode.ai/docs/skills/)、[Config](https://opencode.ai/docs/config/) |
| GitHub Copilot | 项目 `.github/skills`、`.claude/skills`、`.agents/skills`；个人 `.copilot/skills`、`.agents/skills`。本机存在不推断云端/IDE 各版本都能使用。 | [Agent skills](https://docs.github.com/en/copilot/concepts/customizations/agent-skills) |
| Kiro | 项目与全局 `.kiro/skills`，项目同名优先。自定义 agent 的 resources、Web/Mobile 上传状态不作本机生效推断。 | [Agent Skills](https://kiro.dev/docs/skills/) |
| CodeBuddy | 用户/项目 `.codebuddy/skills`，项目优先；官方文档示例包含分组目录，允许递归。没有证据的官方开关不写入自创配置。 | [Skills](https://www.codebuddy.ai/docs/cli/skills) |
| Antigravity | App/CLI/IDE 共用全局 `.gemini/config/skills` 和项目 `.agents/skills`；CLI 另读 `.gemini/antigravity-cli/skills`、`.gemini/skills`，独立 IDE 兼容旧 `.gemini/antigravity/skills`。各使用面的同名优先级不同，单报告保留未知冲突，不伪造统一优先级。manifest 与插件尚不穷尽。 | [Skills](https://antigravity.google/docs/skills)、[Customization discovery](https://antigravity.google/docs/customization-discovery) |

Claude、Codex、Gemini 使用已核实的官方配置开关。其余适配器暂用明确的文件标记方案：将 `SKILL.md` 改名为 `SKILL.md.disabled`，恢复时反向改名；不宣称这是智能体官方开关。共享目录会一并影响其他智能体，预览必须保留这一警告。只读来源不允许绕过；链接来源不轻率暴露文件标记操作。

这些页面描述当前公开行为；本地旧版本、企业策略、动态启动参数及特性开关可能不同。静态扫描不运行 CLI、不请求模型执行、不测调用成功率，因此不会仅凭这些文档将状态标为 active。

第二轮补充：缓存目录层级是本机观察，不是 OpenAI 公布的稳定安装接口；用户层插件开关不能替代有效合并配置。Gemini linked-source 元数据和 enablement 格式补充核对了官方仓库的 [extension-manager.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/extension-manager.ts) 和 [extensionEnablement.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/extensions/extensionEnablement.ts)（2026-11-12 读取的 main，实现细节可能变动）。这类实现证据不提升为跨版本稳定规范，相关来源仍只读、unknown。

OpenCode JSONC 使用 Microsoft [node-jsonc-parser](https://github.com/microsoft/node-jsonc-parser) 的语法树读取并检查完整错误列表，避免容错结果误报；取值采用无原型映射，避免 __proto__ 成为继承的来源声明。扫描不展开配置中的秘密文件、不执行配置内代码。

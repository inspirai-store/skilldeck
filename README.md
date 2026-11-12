# SkillDeck

SkillDeck 是一个本地桌面应用，用于发现和管理多个 AI 编程智能体的 Skills，支持查看来源与状态、编辑、启用或禁用、归档恢复，以及跨智能体复制或迁移。

![SkillDeck 图标](build/icon.png)

## 能力与边界

- 扫描 Codex、Claude Code 等智能体的已知 Skill 目录和部分插件、扩展来源，支持添加项目及自定义扫描目录。
- 展示扫描范围、配置证据、冲突与未知状态；静态可发现不等于当前智能体会话已加载。
- 写操作先预览，再应用；支持备份、归档、恢复和操作回滚。不同智能体的专用语法和外部依赖不保证可自动转换。
- 默认在本地处理，不执行 Skill 中的脚本。扫描范围和适配器限制见 [规则说明](docs/AGENT_RULES.md)及[后端说明](docs/BACKEND_HANDOFF.md)。

## 本地运行

需要 Node.js 24 和 npm：

```sh
npm ci
npm start
```

应用以 Electron 运行。Windows、macOS 和 Linux 的构建由 [GitHub Actions](.github/workflows/ci.yml) 在各自平台上执行，构建产物可在工作流运行页面的 Artifacts 中下载。构建包默认未签名；macOS 包未公证。具体测试范围以每次 CI 结果为准。

## 开发与打包

```sh
npm run typecheck
npm test
npm run test:backend:bundle
npm run test:e2e
npm run build
npx electron-builder --mac dmg zip --arm64 --publish never
npx electron-builder --win nsis portable --x64 --publish never
npx electron-builder --linux AppImage deb --x64 --publish never
```

Linux ARM64 使用 `--arm64`，Intel Mac 使用 `--x64`；Linux 图形测试需要 Xvfb 或可用的桌面环境。Windows 的符号链接测试需要系统允许创建符号链接。详见 [前端说明](docs/FRONTEND.md)和[构建记录](docs/RELEASE.md)。

## 许可

[MIT License](LICENSE)。

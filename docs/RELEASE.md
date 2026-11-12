# SkillDeck 0.1.0 构建与验证

- macOS：Apple Silicon 和 Intel 的 DMG/ZIP。Apple Silicon 版本已安装到本机 /Applications 并通过真实目录只读扫描冒烟测试。当前包未使用开发者证书签名或公证。
- Windows：x64 NSIS 安装包及便携包。已在 macOS 构建，PE 架构检查通过；Apple Silicon 上的 x64 Linux/Wine 模拟发生 Rosetta GDT 异常，未完成 Windows 原生启动或安装验证。文件未签名。
- Linux：x64/ARM64 的 AppImage 和 Debian 包。Ubuntu 24.04 ARM64 容器中安装 Debian 包，虚拟显示环境下进程持续运行；x64 Debian 包通过 x64 模拟同样的启动检查。容器没有真实桌面与系统 D-Bus；未验证实体 Linux 桌面。AppImage 构建成功，未做独立运行测试。
- 项目类型检查、80 项后端测试、14 项 macOS Electron 端到端测试通过。安装包 SHA-256 见 release/SHA256SUMS.txt。
- 打包资源 build/icon.png 为应用图标。使用此前设计的 Fable 前端，图标由 imagegen 生成。

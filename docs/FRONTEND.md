# 前端

React + Vite，位于 `src/ui/`，只通过 `window.skilldeck.call(method, params)` 访问后端，未改动 `src/core/**` 与 RPC 契约。

| 文件 | 内容 |
| --- | --- |
| `App.tsx` | 外壳、筛选状态、列表、对话框编排、撤销提示 |
| `Detail.tsx` | 详情：位置与证据、SKILL.md、文件、元数据、操作 |
| `dialogs.tsx` | 预览/冲突（`PlanDialog`）、编辑、新建/导入、复制迁移、路径登记 |
| `views.tsx` | 扫描范围、操作历史 |
| `meta.ts` / `ui.tsx` | 状态与智能体的显示映射、基础控件 |

所有写操作都经 `PlanDialog`：`plan → 展示 → apply`；`blockers` 或 `conflict` 存在时“应用”不可用，`replace` / `force` / 改名只在用户点击后重新 plan。

```sh
npm start              # 构建并启动
npm run test:e2e       # 沙箱 home 下驱动真实 Electron，14 个流程
node tests/e2e/real-smoke.mjs [可执行文件]   # 真实 home 只读冒烟，可指向打包产物
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir   # 未签名本地包，输出到 release/
```

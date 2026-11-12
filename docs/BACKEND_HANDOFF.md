# 客户端后端交接（Fable）

日期：2026-11-12（已补充第二轮发现能力与验证）。范围：`src/core/**`、`electron/**` 的后端与通信桥、`tests/backend/**`、后端 npm 命令和本文档。没有创建或修改前端页面、组件、样式、Vite 配置。接手时仓库代码全部未跟踪，未重置、提交或覆盖其他人的工作。

## 接口

唯一入口是 `dispatch(engine, method, params)`（`src/core/api.ts`），数据契约在 `src/core/types.ts`。所有参数必须是真实类型，不接受把 `"false"` 当成布尔值、把 `null` 转成字符串。方法失败抛出 Error。

| method | params | 返回 |
| --- | --- | --- |
| `scan` | `{}` | `Inventory` |
| `readSkill` | `{skillId}` | `{content: string|null, files: {rel,size,dir}[]}` |
| `readFile` | `{skillId,rel}` | `{text: string|null}`，禁止越界及跟随内部链接读取外部文件 |
| `validate` | `{bindingId,content}` | `Issue[]`，仅校验，不写盘 |
| `plan` | `{op}` | `Plan`：changes/diff、warnings、blockers、conflict、backup |
| `apply` | `{planId}` | `JournalEntry`，成功后主动重新 `scan` |
| `history` | `{}` | 操作摘要数组，包含 `stepCount`，省略内部 steps/post |
| `recoveryStatus` | `{}` | `{pending: object|null, locked: boolean}`，只读诊断 |
| `addProject` | `{path}` | `Inventory`；要求存在的绝对目录 |
| `removeProject` | `{path}` | `Inventory`；取消扫描，不删除项目文件 |
| `listScanDirectories` | `{}` | `ScanDirectory[]`，返回 SkillDeck 的手动登记，不代表智能体安装记录 |
| `addScanDirectory` | `{agent,path,readOnly?,layout?}` | `Inventory`；已存在绝对目录，默认只读；layout 为 collection/skill，省略时按根 SKILL.md 自动识别 |
| `removeScanDirectory` | `{id}` | `Inventory`；仅取消登记，保留全部 Skill 文件 |

`op` 支持以下对象（字段拼写以 types.ts 为准）：

```ts
{kind:'create', rootId, name, description, body}
{kind:'import', rootId, sourcePath, newName?} // 已存在的绝对本地目录，完整复制
{kind:'edit', bindingId, content}
{kind:'delete', bindingId}
{kind:'toggle', bindingId, enable: boolean}
{kind:'archive', bindingId}
{kind:'restore', archiveId, choice?: 'rename', newName?}
{kind:'purge', archiveId} // 移入备份，仍可回滚
{kind:'transfer', bindingId, targetRootId, mode:'copy'|'move'|'link',
 choice?:'rename'|'replace', newName?}
{kind:'rollback', entryId, choice?:'force'}
```

调用顺序：`scan → plan → 展示计划 → apply → scan`。`blockers` 非空或存在 `conflict` 时不能 apply。用户决定后以选择重新 plan，使用新 planId。冲突替换只允许 `transfer` 的显式 `choice:'replace'`；恢复占位只提供改名。RPC 的回滚只有 `choice:'force'` 才能强制，传 `force:true` 不会绕过冲突。单个 Engine 最多保留 40 份计划，重启失效，apply 尝试后该计划不可复用。新建/导入不覆盖已有目标。

`backup` 是计划涉及备份机制的标志，不表示 apply 已完成；预览没有执行 Skill 修改。`apply` 返回的 `status:'applied'` 只说明文件与日志提交成功，不代表智能体已加载。读取接口不会运行 Skill 中任何脚本或指令。

## 通信桥

Electron preload 只暴露 `window.skilldeck.call(method, params): Promise<unknown>`；IPC 通道 `skilldeck:rpc`。main 仅接受自身主窗口、主 frame、固定 `dist/index.html` 来源。启用 contextIsolation、sandbox，关闭 nodeIntegration，拒绝弹窗及导航。未启动 UI，也未新增任何 UI 内容。

本地 HTTP 使用 `POST /rpc`，body 为 `{method,params}`；成功 `{result}`，错误 `{error}`。绑定 `127.0.0.1` 的随机端口；启动时 stdout 一行给出 `{url,token}`；调用须使用 `Authorization: Bearer <token>`。拒绝 Origin，不开放 CORS，不提供静态文件。请求上限 2 MiB。token 每次启动重新随机生成，不写磁盘。

后端独立命令：

```sh
npm run typecheck
npm run test:backend
npm run test:backend:bundle
npm run build:main
npm run serve:backend
```

既有 `start`、`serve`、`build` 仍包含 UI 构建；当前没有 UI 入口，Fable 接续时再完成。后端无需等待 UI 构建即可构建或测试。后端 esbuild 明确优先使用包的 module 入口，避免 jsonc-parser 的 UMD 动态 require 在 CJS bundle 内缺模块；打包后 smoke 独立覆盖此问题。

## 扫描及状态

适配器注册表在 `src/core/adapters/index.ts`，`Engine(ctx, adapters)` 和 `scan(ctx,cfg,adapters)` 可注入扩展与测试适配器。每个适配器负责 roots、发现规则、名称来源、冲突策略、校验、开关及证据链接。新增智能体不需要改扫描引擎分支。适配器新增可选 `discover(ctx,projects)`，返回 `{roots,issues}`；一条坏清单或独立发现器异常不会取消标准根和手动根。

按真实路径合并实体，每个智能体/目录位置仍保留独立 Binding。同一目录经多个智能体或链接引用时，内容编辑会提示共同影响；存在只读绑定则拒绝内容修改或实体移动删除。移除链接只移除链接；通过链接“迁移”会在目标生成独立内容并移除源链接，保留外部源实体。

| status | 契约 |
| --- | --- |
| `unverified` | 静态可发现候选，未验证当前会话、版本、信任、权限、模型可见性及加载状态 |
| `active` | 兼容保留值；当前扫描器不会仅凭二进制存在而生成此值 |
| `disabled` | 文件标记或已解析持久配置表明关闭；不是正在运行会话的实测状态 |
| `invalid` | 断链、缺文件、读取失败或适配器校验错误 |
| `unknown` | 隐藏/未覆盖深度，或插件缓存版本、扩展激活、自定义来源的有效加载状态尚不明确 |
| `conflict` | 静态同名覆盖/重复/取舍不明的诊断；不等于两个都已在运行时失效 |
| `archived` | SkillDeck 归档位置，已脱离原发现路径 |

没有程序的已知根目录也扫描；“安装检测”与“Skill 可发现”分开。配置解析失败返回未知证据并阻止写入，不自动当启用。`disable-model-invocation`、`user-invocable` 等调用限制以 tags 提示，不把“仅手动”误称为完全禁用。Claude permissions.deny 也不等同于关闭斜杠菜单，启用操作不会删除权限规则。

扫描根有条目上限 20000；目录 Skill 递归默认最多 6 层（非递归智能体仍可显示较浅的未知条目）。根读取/预算错误由 `RootReport.error` 返回，不能把错误当“零个 Skill”。项目嵌套根搜索跳过依赖、隐藏目录及符号链接，最多 4 层/3000 目录；每次 scan 清空嵌套缓存。实体摘要与文件列表分别有 5000/800 条目预算，仅用于展示；安全指纹不复用这些截断摘要。

项目路径从显式配置及智能体记录中读取；已知启动路径沿祖先找到最近 Git 根，包含各级标准根。没有 Git 边界时仅扫描指定项目。不会全盘或遍历所有 home 子目录。Claude 嵌套根保留目录限定调用名、按需加载证据；Cursor 嵌套根限定到其子项目。运行时 `--add-dir`、CLI 参数和会话临时权限不属于本地静态事实。

## 第二轮新增发现能力

- **Codex 插件**：有界读取 `$CODEX_HOME/plugins/cache/<market>/<package>/<version>/` 内 portable `plugin.json` 和兼容 `.codex-plugin/plugin.json`。portable 仅接受已核对的 Agent Plugins 1.0.0 schema 并使用固定 `skills/`；兼容清单仅读取声明的 `skills` 路径。路径须以 `./` 开始，禁止 `..`、越界符号链接。保留全部版本候选、清单路径、目录版本与声明版本，不比较“最新版本”，不以缓存判断已安装。用户层 `plugins["name@market"].enabled` 和 `_default.enabled` 只作为该层配置证据，不当成可信项目、托管和工作区合并后的有效状态。所有候选只读、默认 unknown。
- **Gemini 扩展**：读取 `~/.gemini/extensions/<entry>/gemini-extension.json` 及 `skills/`。支持扩展目录符号链接，以及当前官方实现中 `.gemini-extension-install.json` 的绝对 `type:link` 来源；不运行 MCP、hooks、安装器或脚本。可读取 enablement 的覆盖条目数量作为证据，未实现工作区/CLI 覆盖求值。扩展 Skill 不套用扩展自定义命令的命名空间。来源只读、默认 unknown。
- **OpenCode 自定义目录**：读取系统、XDG 全局、已登记启动目录至文件系统根的 `opencode.json(c)`，以及各级 `.opencode/opencode.json(c)` 中的 `skills[]`。JSONC 支持注释和尾逗号，解析有错误时整份配置不采用部分结果。全局绝对/`~/` 路径作为共享来源；相对路径按每个已知启动目录分别解析，绝不按配置文件目录或进程当前目录猜测。没有启动上下文时返回诊断。多个配置的来源分别保留，最终运行时配置版本/顺序未验证，因此只读、unknown。系统 `skills/` 同时只读发现。
- **手动目录**：只写 SkillDeck 的 `config.json.scanDirectories`，不写任何智能体设置。可登记 Skill 集合或一个 Skill 包，默认只读；显式 `readOnly:false` 才允许常规计划/应用操作。手动映射到 Codex/Gemini 等智能体也不使用官方配置开关，写模式只使用文件标记；状态不会据此变为 active。单 Skill 登记不能当作新建/导入/迁移的集合目标，支持其内容读取、编辑、归档恢复等既有操作。

每条额外根返回 `sourceKind`、`discoveryId`、`evidence`、`loadState` 等证据。`Inventory.discoveryIssues` 返回 `{agent,level,code,text,path?,url?}`；包括配置损坏、未知 schema、非法/未解析路径、远程 catalog 未访问、扫描预算用尽、不可用适配器。配置声明但不存在的额外根仍返回 `exists:false`，不能当成“没有该声明”。HTTP URL 只形成诊断，不下载；诊断不回显 URL 查询中的凭据。`{env:...}` 和 `{file:...}` 来源替换暂不求值，尤其不会读取被引用的秘密文件。

独立来源即使指向同一目录，也保留不同 root/binding ID，实体内容仍按真实路径合并。因此调用方应在扫描后使用返回的新 ID，不跨版本持久缓存 bindingId。新增发现默认只读；手动登记及其链接/祖先/子目录与任何已知只读来源重叠时保持保护。计划应用前重新扫描、重查当前只读来源，不能用旧预览绕过后来增加的保护；移除只读目标之外的用户符号链接仍只操作链接本身。

自定义目录至少包含 `id,agent,path,readOnly,layout`（旧配置可以缺省 layout，按 collection 理解）。同一智能体的目录链接别名去重；已有记录的权限或布局不同会报错，不静默改写。移除后可以显式重新登记。登记不允许 home 本身、文件系统根，以及应用数据目录或其祖先/子目录，最多 256 条。登记方法遵守 mutation.lock 和 pending 恢复边界；原配置覆盖前保存到 `dataDir/config-backups/`，保留未知配置字段。此类配置备份不加入 Skill 操作 journal，撤销登记使用 removeScanDirectory，必要时人工还原配置备份。

发现预算：Codex 缓存最多 4000 次目录/版本访问，单级有额外条目限额；Gemini 最多 1000 个扩展入口；OpenCode 最多 256 个启动上下文、每份 skills[] 1024 项、4096 个额外配置根。预算不足返回诊断，不宣称库存完整。继承目录型 Skill 的扫描与文件读取预算。

## 数据保护和恢复

- 修改前完整 SHA-256 内容指纹，包括大文件、隐藏目录、依赖目录、权限及链接文本；不使用大小/mtime 近似。预览同时记录祖先目录身份，拒绝路径或链接重定向后执行。
- 原有文件改写前复制备份；删除、替换、purge 都移入 `dataDir/backups/<opId>/`，不会自动清理。文本通过独占临时文件、fsync、rename 写入，保留已有文件权限。
- `dataDir/mutation.lock/` 保证同一数据目录的应用写操作串行；项目列表写入也遵守写锁和未完成记录。预览可以扫描，真正写 Skill 必须 apply。
- 每一步之前持久化 `pending.json`，记录操作 ID、备份目录、done 与 next。普通失败逆序恢复已完成步骤；恢复失败保留证据并拒绝后续写入。
- journal.json 提交失败会尝试逆转文件变更；若日志已经提交则保留提交事实，不再错误地二次恢复。损坏日志/配置不会静默重置或覆盖。
- 回滚重查操作后的内容。发生漂移先返回冲突；显式强制也会备份将移除或替换的新内容。备份缺失/被改写时不能强制绕过。已经回滚的记录及回滚记录本身不可再次回滚。
- 跨卷 move 使用复制后移除源；复制失败清理未完成目标，源移除失败保留完整目标与 pending，不声称已完成。它不是跨文件系统原子事务。
- 归档普通目录保存内容；归档符号链接仅保存链接及原目标信息，不是外部目标的内容快照。恢复保留原链接文本；目标失踪会给警告。原目标变为只读/托管范围时拒绝恢复写入。

进程崩溃/断电后禁止自动猜测下一步是否完成。恢复流程：关闭所有 SkillDeck 进程，复制整个 dataDir 作保全；查看 recoveryStatus、pending.json 的 done/next、对应 backups 和 journal.json；比较真实路径后人工恢复或确认提交。确认一致之后才移走 pending.json 和残留 mutation.lock。不要直接删除阻塞文件再继续操作。当前没有自动崩溃恢复接口。

## 验证结果

2026-11-12，当前 macOS 沙箱，使用临时 home/data 和注入适配器，没有改动真实智能体的 Skill 或配置。

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run test:backend` | PASS：80 个测试通过，0 个跳过，3 个测试文件 |
| `npm run build:main` | PASS：main/preload/server 三个 CJS 包 |
| `npm run test:backend:bundle` | PASS：实际启动打包的 CJS server、真实 RPC 鉴权及 OpenCode JSONC 发现 |
| HTTP handler | PASS：鉴权、拒绝 Origin、路由、JSON、大小限制，无 socket 请求处理测试 |
| 真实 loopback HTTP | PASS：当前权限环境已完成真实 127.0.0.1 socket 请求；上一轮 EPERM 限制已解除 |
| UI/浏览器/Electron 窗口 | NOT_RUN，按任务边界未实现 UI |
| Windows/Linux 原生、Windows junction/权限、真实跨卷挂载 | NOT_RUN；跨卷错误分支使用故障注入测试 |
| 各智能体真实会话加载/执行 | NOT_RUN，所有状态均保守解释 |

测试覆盖生命周期、重启后回滚、冲突替换、共享及只读实体、链接、绝对路径边界、YAML 元数据保留、未知递归、优先级/重复、官方开关、配置损坏、内容漂移、同大小大文件、祖先重定向、插件清单/多版本缓存/越界路径、Gemini linked source、OpenCode JSONC/CWD/多来源/秘密替换拒绝、自定义登记/只读覆盖/单包恢复、部分 copy 失败、journal 写失败、自动恢复失败、跨卷源移除失败、写锁与 API 参数校验。

Vitest 仍输出既有 Vite 配置以 CommonJS 加载 ESM 的未来兼容警告；本次未改前端构建约定。

## 剩余问题与明确边界

1. OpenCode V2 的根级独立 `.md` Skill 尚未纳入目录型 CRUD；扫描发现时明确写入 `RootReport.error`，不会把它默默当成完整库存。当前管理单位是目录型 `SKILL.md`。
2. 已补齐 Codex 有清单的缓存候选、Gemini 本地扩展、OpenCode 本地 skills[] 及手动扫描目录；仍不穷尽 Codex 安装注册表/本地市场和远程安装来源、Gemini 扩展有效 enablement/安全策略、OpenCode 远程 catalog/秘密替换/其他版本配置格式，以及 Antigravity manifest 与插件。未知 schema 不回退猜测；不能把库存称为所有运行时 Skill 的完整集合。
3. 官方规则按当前公开文档实现，并非已安装历史版本的特性探测。Claude 的 `skillOverrides` 依赖版本支持；Antigravity 同一报告含 App/CLI/IDE 的不同目录，规则文本明确使用面，跨面同名优先级保持未知。详情见 AGENT_RULES.md。
4. 精确指纹及文件操作同步执行，超大 Skill 会阻塞主线程；尚无后台 worker、取消扫描或文件监听器。已有有界发现、可扩展适配器，不是大规模性能验收。
5. 没有操作系统级跨文件锁或 rename-no-replace 保证；写锁仅约束共享 dataDir 的 SkillDeck 实例。应用外部进程在校验后并发改写的恶意竞争、不同 dataDir 同时管理同一 Skill、突然断电等仍需系统级验证与恢复。不承诺整个目录树原子提交。
6. 归档改名仅改变恢复目录名，保留原 frontmatter；迁移和导入改名会安全修改 YAML name，保留其他字段与正文。迁移不自动转换智能体专用语法、外部脚本依赖、绝对路径或平台可执行环境，只提供兼容性提示。
7. 后续前端需要消费 error/evidence/warnings/conflict 以及 recoveryStatus；不能把 unverified 显示为“已生效”，不能绕过计划或自动选择 replace/force。

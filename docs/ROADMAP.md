# GitDesk 开发路线与任务拆分

版本：v0.1 · M1–M6。顺序是依赖关系，不是固定工期承诺。每阶段一个可审查的 PR 或独立提交序列；完成定义以验收为准。禁止多 Agent 同时大范围改同一目录。

| 里程碑 | 目标 | 退出条件 |
| --- | --- | --- |
| M1 | UI Mock 原型 | 所有者确认视觉和主要交互；无真实 Git writes |
| M2 | Workspace 和 Git read adapter | 真实目录扫描、状态、refs/worktrees、持久化与错误处理 |
| M3 | 正确的 Commit Graph | 拓扑、分页、搜索、虚拟滚动与真实仓库测试 |
| M4 | Commit detail / Changes 与独立的 Release Tracking | 基础只读流程可内部 alpha 试用，发布流转追踪纳入 v0.1 P0 |
| M5 | 安全的 Git 操作 | 分支、Fetch/Pull/Push 通过集成测试 |
| M6 | 稳定性和 macOS 发布 | P0 验收、性能记录、可安装 app/DMG |

## M1 — UI prototype（先做，独立任务）

- [x] M1.1 搭建 Tauri 2 / React / TypeScript / pnpm 工程，配置 strict、lint 和 Vitest，生成 pnpm 和 Cargo 锁文件，验证浏览器和 Tauri 开发入口。
- [x] M1.2 实现 design tokens、AppShell、可调宽 Sidebar、Toolbar、Tabs、StatusBar 和可调高详情面板。
- [x] M1.3 实现 `GitService`、Mock adapter 与 Zustand 状态。提供确定性的仓库数据，包含加载中、空历史和加载失败场景。
- [x] M1.4 History 使用预设的 Mock 轨道和真实的模拟父提交关系，支持点击、键盘选择、搜索高亮、ref 标签和列宽调整。正式图布局算法在 M3 实现。
- [x] M1.5 实现 Commit detail、Unified Diff、Changes 和 Worktrees，支持合并提交父节点比较和关联 worktree 浏览。
- [x] M1.6 支持仓库切换、折叠、侧栏搜索、面板调整、详情关闭和 Settings。Git 操作入口在 Mock mode 中显示为禁用。
- [x] M1.7 通过 lint、类型检查、10 项前端测试和浏览器构建。在浏览器检查 1280×820、1440×900、980×600 三种尺寸。在 Apple Silicon macOS 26.6.2 上验证 Tauri 启动、构建和原生窗口的 worktree Diff 流程。 [实际界面截图](GitDesk-M1-preview.png)

验收：1280×820、1440×900、最小尺寸视觉无重叠；浅色和深色主题的提交图都清晰可读；Mock 交互完成，所有者批准界面后进入 M2。不要先写 Git 后端。

## M2 — Workspace + read-only Git

- [x] M2.1 注册表、系统 Git 发现、只读进程执行、结构化错误、扫描取消和输出上限。
- [x] M2.2 原生目录选择器、手动添加和重新扫描。扫描普通仓库、嵌套仓库、submodule 和 linked worktree，并按 Git common directory 去重。
- [x] M2.3 读取 porcelain v2 状态、本地和远程 refs、标签和 worktree。临时仓库覆盖空仓库、detached HEAD、重命名、冲突和 Unicode 路径。
- [x] M2.4 使用 schema v1 的配置保存工作区、注册路径和选中的 worktree。配置采用原子写入，损坏时保留备份并显示提示。
- [x] M2.5 原生窗口连接实际 IPC，浏览器保留 Mock 预览。切换时丢弃过期结果，本地读取失败显示真实错误。
- [x] M2.6 选中 worktree 的文件监听和去抖，辅以窗口聚焦刷新与分批后台状态刷新。

已在 macOS 原生窗口用临时多仓库目录验证添加、分支与关联 worktree、外部文件写入后的自动刷新，以及重启恢复上次的 worktree。M2 验收覆盖工作区状态，提交图随后在 M3 接入。

## M3 — Git Graph core

- [x] M3.1 冻结 refs/HEAD 目标，streaming history parser + history session/cancellation/sequence，测试分片、empty、shallow、annotated tags。
- [x] M3.2 Active Lanes 纯 TS layout，每个 parent 正确、确定性、无重复 pending OID、分页与一次性布局等价。覆盖随机 DAG。
- [x] M3.3 SVG per-row renderer、虚拟滚动、稳定列宽和横向滚动。普通、合并、根提交和浅克隆边界使用不同节点。
- [x] M3.4 实现全部引用、当前分支、仅本地分支和 Focus branch 四种历史范围。接入搜索高亮、上下定位、继续加载和会话过期提示。
- [x] M3.5 用真实 Git fixtures 核对多 tips 和多父提交，记录 10 万条合成提交的读取和布局测量。
- [x] M3.6 实现可折叠的 Local / Remote / Tags / Worktrees 引用区、按远程名分组、Branch / Tag 列与按 OID 定位。加入独立的本地和远程引用显示开关，默认开启并按仓库保存。

验收时用多分支仓库找到一对本地与远程跟踪分支。两者同头时标签同行，分叉后各自指向真实提交，点击可定位。切换显示开关时保持提交、合并线、选中行和滚动位置，重开仓库恢复设置。切到仅本地分支范围后，比对从本地分支可达的提交。合并节点保留每条父边，分页接缝保持连续，外部引用变化提示刷新。

Apple Silicon 原生窗口已验证合并图、引用显隐、范围切换、跨页定位和外部引用更新后的刷新提示。读取测试和测量方法见 [提交图算法与渲染设计](GRAPH_ALGORITHM.md)。

## M4 — Commit detail / Changes

- [x] M4.1 commit metadata、parents、file list、numstat、rename、root commit。
- [x] M4.2 统一 Diff、合并父提交选择和受限预览。大文件、二进制和截断有明确状态，Git 使用 literal pathspec。
- [x] M4.3 Changes 分组展示 staged、unstaged、untracked 和 conflicts。安全预览可取消过期请求。
- [x] M4.4 复制 hash、打开 Finder / Terminal、浏览 worktree、恢复首屏提交详情和键盘导航。
- [x] M4.5 用真实临时仓库验收只读流程，在 macOS 构建内部试用包。

### M4.R — 发布流转追踪

依赖 M3 的真实历史和提交定位。作为独立只读工作推进，基础 alpha 仍可在 M4.5 后先试用。完整规则见 [发布流转追踪](RELEASE_TRACKING.md)。

- [x] M4.R1 迁移本地配置，保存每个仓库的阶段目标及版本。实现精确 ancestry、快照复核和未知状态，覆盖目标切换、缺失、浅克隆和并发刷新。
- [x] M4.R2 实现 Releases、从分支生成并确认提交清单、任务版本与归档、按阶段聚合和有界历史观察。History 增加默认关闭的状态列，支持查看证据与定位提交。
- [x] M4.R3 用临时仓库验收部分包含、跳过阶段、cherry-pick、revert、测试目标切换及历史观察。覆盖 linked worktree 和 History 的读取回归。

macOS 原生验收覆盖两个合并父提交、暂存与未暂存的同一文件、未跟踪文件、提交多选创建任务、按范围查看候选及切换测试目标。验收前后比对了临时仓库的引用、索引和工作文件。

## M5 — 安全 Git operations

- [x] M5.1 按逻辑仓库串行执行、预检与预期状态校验；本会话操作日志与操作后刷新。
- [x] M5.2 分支列表/创建/切换；阻断 dirty/conflict/in-progress，测试同分支其他 worktree 已 checkout。
- [x] M5.3 显式 Fetch 指定远程、Pull 仅快进、Push 明确提交和 upstream。确认目标并报告缺少 upstream、认证和非快进错误。
- [x] M5.4 本地 bare remote 集成测试、hook 与认证错误处理、同仓库并发、外部状态变化、非快进与 Fetch 取消。
- [x] M5.5 UI 状态与安全审计，检查所有 IPC、禁止任意命令、禁止 destructive flags；默认不启用 P1。
- [x] M5.6 将用户主动 Fetch 的结果接入发布证据刷新，按 remote 记录成功时间。失败时保留并标注旧证据，显示 refspec 未覆盖的情况。

验收：全部写测试只使用 temp repositories/local remotes；真实用户仓库操作仅由用户在 App 中明确触发。确认前后 refs 和工作区状态；风险操作阻断。正式 v0.1.0 发布验收在 M6。

在 macOS 原生窗口用临时仓库和本地 bare remote 验收五项 Git 操作与会话日志。Fetch 更新 Releases 的提交比例和时间，远程不可达时保留原有比例并标记过期。

## M6 — macOS packaging / release

- [ ] M6.1 性能测量：首屏、仓库切换、扫描 100 repos、10 万 commits、滚动、内存；记录真实设备和限制，优先解决可复现卡顿。
- [ ] M6.2 故障测试：缺 Git、Finder PATH、unborn/detached/shallow、失效路径、权限、长路径、非 UTF-8、外部 Git、watcher overflow。
- [ ] M6.3 Accessibility、快捷键、真实窗口布局，测试退出与恢复、缓存清理、进程释放。
- [x] M6.4 在 Mac arm64 构建 App/DMG，验证本地安装与启动，并记录安装和开发说明。对外分发条件见下方验收记录。
- [x] M6.5 对照 PRODUCT 的 P0 验收功能，记录 v0.1.0 本地包的验证结果和限制。
- [ ] M6.6 复验 Release Tracking 的 L01–L03，记录多任务调度、浅色和深色主题及窄窗口可读性。核对本地快照、未知状态和实际部署的文案。

### v0.1.0 本地安装包验收

构建代码来自 `main` 的 `c4aa96c`。在 Apple M4、macOS 26.6.2、Apple Git 2.54.0 上通过 66 项前端测试和 40 项 Rust 测试。DMG 校验、挂载、复制、应用签名校验和复制后的启动均通过，应用版本为 `0.1.0`，架构为 arm64。本地打包命令见 [安装说明](../README.md#安装-v010)。

| 范围 | 本地验证 |
| --- | --- |
| W01–W04、T01 | 在原生窗口读取两个独立仓库、浏览工作区外的 linked worktree、核对其独立的未跟踪文件，并从系统目录选择器扫描出另外 100 个临时仓库。注册、移除和变更监听有回归测试。 |
| H01–H04、D01–D02、C01 | 提交图布局、分页、合并父提交、Diff、Changes 分组和滚动位置有回归测试。100,000 条提交的 Rust 调试构建复测，首批 500 条约 341 ms，总读取约 573 ms。 |
| B01–B02、R01 | 分支、upstream 和工作区保护通过临时仓库测试。Fetch、Pull、Push 使用本地 bare remote 验证。 |
| L01–L03 | 980×600 原生窗口显示两个任务及三个目标。两提交任务的结果为 Test 1/2、Staging 0/2、Prod 2/2。目标、历史观察、证据和 Fetch 失败有回归覆盖。 |

本机安装包沿用 GitDesk 名称和临时签名。对外分发需另行确认命名、许可证、Developer ID 签名和公证。性能表中的窗口首屏、滚动帧时间与内存预算继续按 M6.1 验收。

## 任务分配建议

M1 可由单一 Agent 完成，减少 UI 风格割裂。之后按边界拆分：Workspace/Rust、Graph TS、History UI、Diff/Changes、Integration。每个任务声明允许改动的目录、接口、测试和禁止范围；先合并 `services/contracts.ts` 与 Rust DTO 契约，避免独立生成不兼容类型。若需要调整文档契约，先说明原因和影响，不要各 worktree 私自发明协议。各 worktree 统一遵守仓库根目录的 [AGENTS.md](../AGENTS.md)。

## v0.2 候选（暂不实现）

Stage/Unstage/Commit、Merge/Cherry-pick、分支比较、Stash、批量 Fetch、Workspace dashboard、worktree 创建/管理。v0.3 可探索 Orca/Agent 任务关联、跨仓库变更总览；无需先引入 AI。每项另写安全与验收标准，再进入任务。

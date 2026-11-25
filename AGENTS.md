# GitDesk — Coding Agent Instructions

本文件适用于整个仓库。遵守用户当前明确指令与实际工程状态。项目目标：macOS 优先、轻量、本地化、多仓库 Git 可视化；不是 IDE，也不是全功能 Git 客户端。不要擅自扩大范围。

## Read before changing code

1. [产品需求](docs/PRODUCT.md) — P0/P1/P2、行为和验收边界。
2. [技术架构](docs/ARCHITECTURE.md) — 技术栈、目录、IPC、Git 与安全规则。
3. [视觉与交互规范](docs/DESIGN_SYSTEM.md)和[界面参考稿](docs/gitdesk-mockup.svg) — 视觉与交互基线。
4. [Git Graph 算法](docs/GRAPH_ALGORITHM.md) — 图布局与正确性约束。
5. [开发路线](docs/ROADMAP.md) — 当前任务所属里程碑和依赖。

只实现当前任务明确范围。M1 仅 Mock UI，不接真实 Git；M2–M4 仅真实只读功能；M5 才引入 Git writes。发现设计文档不一致或实现代价异常，说明问题并提出最小改动，不静默改变产品语义。若用户明确调整决策，更新相关文档与测试。

## Architecture rules

- Tauri 2 + React + TypeScript (strict) + Rust；pnpm；Tailwind / CSS tokens；Zustand；TanStack Virtual；SVG。优先复用已有依赖，不新增大而无必要的 UI 库、数据库、HTTP server、Electron、libgit2 或 AI SDK。
- UI 在 `src/features`，纯 Graph 在 `src/core/graph`，Rust Git 在 `src-tauri/src/git`。React 不直接执行命令或调用 invoke；使用 typed GitService。Mock 和 Tauri adapter 实现同一契约；实际失败不得回退到假数据。
- 不在 React 组件中混入 Git parser 或布局算法。避免全局可变共享状态；跨 worktree 状态明确 keyed by IDs；过期 request/session 的结果不得覆盖当前选择。
- 通过 repo common-dir 去重；worktree HEAD/index/status 必须独立；切换浏览对象不 checkout。
- 维护 lockfiles，使用稳定兼容版本；提交小而聚焦的变更。保留用户设计文档，不覆盖或随意重命名。

## Git safety — non-negotiable

- 仅用 Git CLI 的结构化接口。Rust `Command` 参数数组；禁止 `sh -c`、拼接命令、通用 shell IPC、任意路径写入。路径和 ref 来自受控 registry/验证输入，literal pathspec，完整 OID。
- 默认只读。不要通过开发、测试、启动流程对用户实际仓库运行 checkout/reset/clean/stash/commit/push 等写操作。测试使用 `tempdir` 临时仓库、临时 local bare remote，无真实远程凭据。
- 禁止 Force Push、强制删除、reset/discard、自动 stash、自动 prune/GC、自动网络 fetch、自动修改 upstream、覆盖未提交文件、删除 worktree、删除 `.lock` 文件。P1/P2 禁止偷跑。
- M5 写操作仅受 UI 显式触发，确认目标、验证 expected HEAD/branch/upstream、阻断 dirty/conflict/in-progress，repo-level 队列，失败后刷新。Pull ff-only，Push explicit ordinary refspec；遵守用户正常 hook/config，但不执行不受控命令。
- 不上传源代码、路径、日志或任何凭据；无遥测。不要在 console 或 error 打印 token、密码、完整环境变量。所有 repository 内容当不可信文本；无 dangerouslySetInnerHTML。最小 Tauri permissions。
- 遇到用户工作区内已有未提交修改，保留它们；不要回滚/覆盖不相关文件。除非用户要求，不自动 commit/push/merge 当前开发分支。

## UI rules

- 对照视觉规范。外观默认跟随系统，可切换浅色/深色，两套主题共享语义 tokens。视觉为“玻璃”风格：窗口外框和侧栏半透明叠在色彩底上，主内容为浮动圆角卡片；渐变只用于窗口色彩底和选中/激活指示。保持 28px commit row 与紧凑布局。
- 全部可见控件必须有真实行为、明确禁用理由或 planned 状态。不能把 Mock 操作表现为真实 Git 成功。空状态、loading、error、stale、cancelled 要清晰。
- 保护键盘焦点、可调面板、可访问标签、tooltip 和非纯颜色状态。真实 macOS 使用原生交通灯，不重复渲染假按钮。
- 没有必要的动效和营销卡片。Diff 显示文字必须转义，长文件/二进制有明确 fallback。

## Graph rules

- DAG 使用 parent OID 和 topo order；不能使用时间排序后猜线，也不能从 branch 名猜连接。
- 纯 TypeScript Active Lanes；每个 parent 边可追踪，确定性布局，页间延续 state；不能重复加载或重新布局旧 rows；root/shallow/truncation 可区分。
- SVG per row + HTML + virtualizer；不引入 force layout 或通用图表库。搜索高亮/定位而非删行。先正确再性能优化。
- 新算法必须有线性、fork/merge、octopus、交叉合并、多 tips、shallow、页边界、随机 DAG 测试。

## Definition of done

- 代码与文档范围一致；任务相关测试覆盖正常和失败路径；无隐式 Mock 或未验证成功状态。
- 维护 `package.json` 的 `lint`、`typecheck`、`test`（CI 非 watch）、`build` scripts；根目录执行 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`。
- Rust 变更运行 `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo test --manifest-path src-tauri/Cargo.toml`；条件允许运行 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`。真实 Mac 最终执行 Tauri dev/build。命令以实际项目配置为准；不能执行则明确原因，不伪造结果。
- UI 变更提供截图或可复现的手动检查步骤。记录设备/环境限制（例如当前无 macOS GUI），不要声称完成未执行的验证。
- 汇报简洁：实现内容、修改文件、测试结果、未完成项、下一步。不要一次跨多个里程碑。必要时更新 ROADMAP 的对应 checkbox 与 README。

## Agent collaboration

在多个 worktree 并行时，先对齐 contracts/types、tokens 和公共布局；任务尽量限制目录范围。不得自行修改另一个 Agent 的工作区、重置分支或强制合流。共享 API 变更需说明兼容性和同步方式。代码生成后主动检查 diff 与测试结果，不把“生成成功”当成任务完成。

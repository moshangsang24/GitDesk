# 第一次交给 Codex 的任务

将下面整段提示词复制给在 Orca 中打开 GitDesk 仓库的 Codex。只执行 M1，先让视觉与交互得到确认。

---

你现在是 GitDesk 项目的第一阶段开发者。当前仓库是产品与技术设计基线，可能还没有应用代码。先检查目录和 Git 状态，再完整阅读根目录 `AGENTS.md`、`README.md`、`docs/PRODUCT.md`、`docs/ARCHITECTURE.md`、`docs/DESIGN_SYSTEM.md`、`docs/GRAPH_ALGORITHM.md`、`docs/ROADMAP.md`。打开 `docs/gitdesk-mockup.svg` 作为视觉目标。

本次只实施 **M1：UI Mock 原型**。技术栈为 Tauri 2 + React + TypeScript + Rust，pnpm、Tailwind CSS、Zustand、TanStack Virtual、Lucide、SVG。项目第一版 macOS 优先，保持浏览器 Mock preview 能独立运行。现有文档不要覆盖：如脚手架不能初始化非空目录，可在临时目录生成并有选择地复制脚手架文件进本项目，先检查冲突，绝不要删除已有文件。

请完成以下工作：

1. 初始化工程并建立文档定义的目录骨架，TypeScript strict，配置 lint/typecheck/test/build scripts 与 lockfiles。
2. 按 DESIGN_SYSTEM 的 token 和参考 SVG 设计单窗口桌面界面：深色、紧凑的多仓库 Sidebar、Toolbar、History / Changes / Worktrees tabs、Commit Graph、Commit 详情与 Unified Diff、StatusBar。不要改成常见 web dashboard 风格。保留可拖拽分隔线，照顾 1280×820、1440×900 和最小窗口。
3. 用 deterministic mock adapter 提供两个 Workspace、六个以上仓库、至少二十个 commits（含真实 mock parent 关系、merge/ref 标签）、文件差异与多个 worktree。实现仓库切换、折叠、搜索、提交选择、详情关闭、parent 切换和 worktree 浏览。可使用预计算 GraphRow 供 UI 验收，正式算法在 M3。
4. 定义清晰、最小的 GitService contract，UI 依赖 adapter，不直接 invoke 或运行 Git。M1 不访问真实用户仓库、不执行任何真实 Git 操作。Fetch/Pull/Push/Branch 等尚未实现的操作必须明确禁用或标记 planned，不模拟真实成功。开发界面显示 Mock mode。
5. 给交互和纯函数添加基础测试，执行 lint、typecheck、test、build。当前在 Mac 时验证 Tauri dev 窗口；如果无法运行 GUI，记录限制，仍应验证浏览器构建。提供截图（环境支持时）或可复现的查看步骤。

先给出简短实施计划，然后直接开发本次任务。不要提前做 M2–M6，不新增数据库、HTTP 服务、AI 功能，不为了方便改用 Electron，不安装不必要的依赖。保留用户已有文件和修改，不自动 push 或 commit。遇到必要的技术调整，说明原因，并选择最小改动。完成后汇报具体实现、运行命令、测试结果、设计偏差和未完成项。等待用户验收 UI 后再开始 M2。

---

后续任务提示模板：

> 阅读 AGENTS.md 和 docs 中本任务相关章节。只完成 ROADMAP 中 Mx.y–Mx.z，保持已验收界面与接口。允许修改 [目录]，验收标准为 [条目]。实现、测试、记录结果与限制，不提前执行后续里程碑。

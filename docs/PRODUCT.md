# GitDesk 产品需求文档（PRD）

版本：v0.1 · 设计基线

## 1. 背景与目标

用户从 VS Code 迁移到 Orca 后，需要补齐清晰、紧凑的 Git 提交图和多仓库管理。一个 `~/work` 目录可能包含多个独立前端、后端、Agent 与基础组件仓库；同一仓库还可能被多个 Coding Agent 以 worktree 方式同时开发。传统客户端通常优先围绕单个仓库组织界面，GitDesk 则优先围绕 Workspace 组织。

**核心价值：打开一个工作目录，即可观察所有仓库状态；单击任意仓库即可快速理解其分支合并历史、当前修改与 worktree。**

GitDesk 还将支持按任务核对指定提交是否已进入测试、预生产和正式目标分支，证据来自本机 Git 历史。

第一版仅支持 macOS，Apple Silicon 优先。完全本地运行；网络仅来自用户主动发起的标准 Git 远程操作，不需要登录 GitDesk。设计目标为低饱和度、高信息密度、接近 IDE 的操作体验。默认使用浅色，提供深色主题。后续可拓展 Windows / Linux，但不以跨平台兼容拖慢 v0.1。

### 非目标

不是 IDE、终端、Git 服务端、GitHub/GitLab 管理平台、AI 审查工具或完整 Fork 克隆。v0.1 不包含账号体系、遥测、订阅、后台云同步或自研 Git 协议。

## 2. 核心对象

| 对象 | 定义 |
| --- | --- |
| Workspace | 用户选择的扫描根目录或手动组织的仓库组；一个应用可有多个 Workspace |
| Repository | 以 canonical git common directory 标识的逻辑仓库；共享对象和大部分 refs |
| Worktree | 实际工作目录及其独立 HEAD、index、状态；主工作目录也是一个 worktree |
| Commit | 完整对象 ID、父提交、作者、时间、subject 与 refs |
| History session | 在确定 refs/HEAD 快照下生成的拓扑历史流。切换历史范围会创建新会话，外部引用变化会提示刷新 |

一个 Workspace 可以包含多仓库，仓库可出现在多个 Workspace 中，但后台数据按逻辑仓库去重。切换 worktree 必须明确区分“浏览哪个工作目录”和 Git checkout；浏览切换不修改磁盘。

## 3. 功能边界与优先级

P0 是 v0.1.0 发布门槛，P1 计划在 v0.2 或提前独立评审，P2 暂不纳入本轮。M4 的 Commit detail / Changes 通过后可先试用只读 alpha。发布流转追踪作为 M4 的独立只读工作纳入 v0.1，Git 写操作留至 M5。

| ID | 模块 / 功能 | 优先级 | 可验收行为 |
| --- | --- | --- | --- |
| W01 | 添加/移除 Workspace，递归扫描目录 | P0 | 识别普通仓库和 `.git` 文件；不重复扫描、不误改仓库 |
| W02 | 仓库列表、分组、折叠、筛选、保存配置 | P0 | 重启后恢复；每项显示名称、分支和变更状态 |
| W03 | 手动添加仓库、重新扫描、打开 Finder | P0 | 未找到/失效路径可定位或移除，移除仅删除应用配置 |
| W04 | 选中仓库状态监听、后台低频刷新 | P0 | 外部 Git 操作后能刷新；无无界轮询 |
| H01 | Git Graph | P0 | 展示真实拓扑、彩色轨道、普通/merge/root 节点 |
| H02 | 本地分支、远程跟踪分支、tag、HEAD 标签 | P0 | 按类别导航并定位到目标提交。本地与远程引用可独立显示或隐藏，支持全部引用、当前分支、仅本地分支和所选分支的历史范围 |
| H03 | Commit 搜索与分页 | P0 | 已加载记录支持 hash/subject/author 搜索、定位高亮；未加载记录可继续搜索，明确范围 |
| H04 | 虚拟滚动、列宽与详情面板调整 | P0 | 历史滚动流畅，不重复加载或错位 |
| D01 | Commit 详情、父提交、复制 hash | P0 | 点击提交展示完整信息与变更文件 |
| D02 | Unified Diff | P0 | 新增/删除/重命名/二进制/大文件合理展示；merge 可选 parent |
| C01 | Changes 页面只读浏览 | P0 | staged、unstaged、untracked、冲突状态分区，允许查看差异 |
| B01 | 本地/远程分支列表、当前分支 | P0 | 显示实际引用及 upstream；支持搜索 |
| B02 | 创建本地分支、切换已有本地分支 | P0 | 显示目标 worktree；脏工作区阻断，不做自动 stash |
| R01 | Fetch、Pull（fast-forward only）、普通 Push | P0 | 用户主动触发，确认实际目标，失败显示 Git 错误 |
| T01 | 发现、浏览、打开已有 worktree | P0 | 识别 Workspace 之外的关联 worktree，显示各自独立状态 |
| L01 | 每仓库配置发布目标 | P0 | 配置实际远程跟踪分支，可更换测试目标，保留历史观察 |
| L02 | 提交级发布证据 | P0 | 独立判断原提交是否出现在各目标的本地历史，支持可选 History 状态列 |
| L03 | 任务级发布追踪 | P0 | 保存确认后的提交清单，展示各阶段的包含比例、未知项与逐提交证据 |
| T02 | Worktree 创建、删除 | P1 | v0.1 不做，避免删除 Agent 工作目录 |
| C02 | Stage / Unstage / Commit | P1 | v0.1 暂由 IDE / CLI 完成 |
| B03 | Merge、Cherry-pick、分支比较 | P1 | 后续独立安全设计与测试 |
| R02 | 批量 Fetch、Workspace 总览 | P1 | v0.1 按钮不应执行未实现功能 |
| S01 | Stash 保存、恢复、列表 | P1 | v0.1 隐藏或明确禁用入口 |
| X01 | 交互式 Rebase、冲突编辑器、reset/discard | P2 | 不实现 |
| X02 | Force Push、强制删除分支、AI 功能、平台集成 | P2 | 不实现 |

## 4. 主要流程

### 4.1 首次启动

空状态 → Add Workspace → 系统目录选择器 → 展示扫描进度 → 自动发现仓库（可取消）→ 左侧列出仓库 → 首次自动选中一个有效仓库（若存在）→ History 页面首批提交 → 点击任意提交查看 diff。

目录只在用户授权添加后扫描；默认不跟随符号链接，不跨越用户所选目录去遍历文件系统。Git 元数据指向的关联 worktree 可读取，但要标注位于 Workspace 外部；不得因此递归扫描外部目录。支持隐藏无效项与手动添加仓库。

### 4.2 日常查看提交

选择仓库和 worktree，打开 History。在引用区按 Local、Remote、Tags 或 Worktrees 查找。Remote 按远程名分组，展示保存在本机的远程跟踪分支。点击分支或标签会定位到它指向的提交。需要专看某个分支时，可以显式选择 **Focus branch**。点开 merge commit 后，可在 M4 选择 parent 并查看文件 Diff。

**显示引用**菜单里的本地分支与远程分支开关默认都开启，按仓库保存。开关同时控制引用区和图上的对应标签，提交、合并线和当前选中行继续保留。**仅本地分支**是历史范围选项，展示从本地分支可达的提交。切换仓库时，恢复该仓库的引用显示选择，并尽量恢复其最近的历史范围、滚动位置和提交选择。

**My branches** 用选定的 Git Author 姓名和邮箱匹配提交。只要某分支在基准分支之外有该身份写的提交，就显示该分支的可达历史，包含协作者提交和合并关系。身份和基准分支按仓库保存。

### 4.3 日常同步与分支

用户选择远程并确认 Fetch，随后刷新引用和 ahead/behind。分支操作及 Pull/Push 在确认页显示目标 worktree 和相关引用。Pull 仅允许快进，Push 发送确认的提交到现有 upstream。缺少 upstream、存在冲突或正在执行 Git 操作、无法快进或认证失败时，界面说明原因。

### 4.4 外部 Agent 修改

Orca 创建新 worktree 或修改代码 → GitDesk 通过监听和定期状态刷新更新 → Worktrees 页面显示新条目 → 用户点击后查看该 worktree 的 Changes 与当前 HEAD。GitDesk 不依赖 Orca 私有 API，也不应尝试推断某个 worktree 对应哪个 Agent；未来可选显式关联。

### 4.5 发布流转追踪

在 Releases 为当前仓库选择测试、预生产和正式目标分支。用户可从 History 选提交，或从任务分支生成候选并确认清单。Releases 分阶段展示包含比例和证据。更换测试目标后，历史观察仍可查，新目标重新判断。M4 手动刷新读取本机快照，M5 用户主动 Fetch 后同步刷新相应证据。Git 包含结果用于核对提交，真实部署状态以发布系统为准。详见 [发布流转追踪](RELEASE_TRACKING.md)。

## 5. 页面与布局

- Workspace Sidebar：目录组、仓库搜索、折叠、仓库状态与快速添加。
- Repository Toolbar：名称、路径、当前 worktree，Fetch/Pull/Push/Branch；入口按能力和状态启用。
- History：可折叠的引用区、独立的分支与标签列、提交图、提交信息、作者、日期、可选 hash 列、搜索、引用显示开关和历史范围。可按需开启发布状态列。
- Changes：staged/unstaged/untracked/conflict 文件列表与统一 diff；不出现可误触的删除按钮。
- Worktrees：路径、分支、状态、锁定/prunable 提示，选择或打开目录。
- Releases：仓库的目标分支、任务清单、分阶段包含比例、逐提交证据与历史观察。
- Commit detail：可折叠、可调高的底部区域，包含提交元信息、文件列表、diff。
- Settings：主题（浅色默认，可切换深色）、Git 路径、扫描忽略项、刷新策略、诊断日志。

详细视觉与行为约束见 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)。

## 6. 状态与异常

必须设计 loading、empty、error、ready、stale、cancelled、unsupported 状态。仓库为空（unborn HEAD）、detached HEAD、浅克隆、目录丢失、bare 仓库（只读历史若可读取，否则清晰说明）、submodule、非 UTF-8 路径、不支持 Git 版本、权限不足、认证失败均不应让应用崩溃。分支/历史/工作区状态无法计算时显示 Unknown，而不是错误的 Clean 或 0。

所有历史、状态及进度结果必须关联 repository/worktree 与 requestId；切换仓库后旧结果不能覆盖当前视图。

## 7. 非功能需求与验收

以下为工程目标，非现有性能承诺；M6 在实际 Apple Silicon Mac 上记录设备、Git 版本、样本规模与测量方法。大仓库与大工作区不必同时达到所有目标，但不能卡死主线程。

| 项 | v0.1 目标 |
| --- | --- |
| 应用冷启动 | 可交互主窗口约 2 秒以内，不阻塞首次扫描 |
| 已缓存仓库切换 | p95 ≤ 200 ms 到可见内容 |
| 普通仓库首屏 | 约 500–1000 个提交首批加载；有清晰 loading |
| 大仓库 | 10 万 commits 测试，分批读取，界面可滚动与取消 |
| Workspace | 100 个仓库测试，扫描可取消、并发有界 |
| 滚动 | 60 Hz 设备上尽量保持帧时间 < 16.7 ms；记录 p95 |
| 资源 | 空闲内存争取低于 150 MB，记录 app 与 WebView 进程统计口径 |
| 隐私 | 不上传代码、日志、路径或凭据；默认无遥测 |
| 可靠性 | Git 外部写入期间保持只读刷新；不自动删除/重写用户历史 |

## 8. 发布门槛

- M1 UI 由项目所有者验收；M2–M4 通过后可内部试用只读 alpha。
- M5 写操作全部通过临时 Git 仓库与本地 bare remote 的集成测试；没有 destructive UI/IPC 入口。
- M6 在真实 macOS 中从 Finder 启动、完成典型多仓库流程与 worktree 流程，生成可本地安装的 App/DMG；对外分发另行验证签名、公证、许可证与命名。
- 未实现功能必须隐藏或明确标记不可用，不能使用假成功状态。没有完成 P0 的版本不标记正式 v0.1.0。

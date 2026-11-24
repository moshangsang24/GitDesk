# Git Graph 算法与渲染设计

版本：v0.1 · 本项目的核心技术模块

## 1. 目标与不变量

Git commit 历史是一个 DAG（有向无环图），边指向 parent。GitDesk 从 Git 获取拓扑排序的提交及 parent，而不是解析 `git log --graph` 的 ASCII，也不采用任意网络图的力导向布局。界面每一行对应一个 commit，新到旧（Git `--topo-order`；不是严格按时间排序）。

任何时刻必须满足：

1. 一个 commit 在同一 session 中最多出现一行，所有可达提交按 Git 返回顺序处理。
2. 只有真实 parent 边可以画为 commit 连接；每个 merge 的每个 parent 都有一条明确的边。
3. 已存在的活动轨道有唯一 pending OID；多个子提交汇合到同一 pending parent 时复用轨道。
4. 在分页时追加行不能改变已输出行的几何和颜色（图形列可能因新轨道而扩宽）。
5. 虚拟滚动、选择、高亮、搜索不影响布局结果；图形不得暗示不存在的 parent 关系。
6. 浅克隆、截断、加载未完的边界必须明确显示，不能把未加载 parent 错当成 root。

## 2. 数据契约

使用 `ARCHITECTURE.md` 的 Commit / GitRef。图布局只需要完整 OID 与有序 parents；refs 是独立装饰层（颜色轨道不是分支名称）。Git CLI 保证拓扑顺序：在完整遍历中，子先于其所有可见 parents；不得对页面按 authorTime 重新排序。

```ts
export interface Lane {
  pendingOid: string;
  colorId: number;  // monotonic allocation ID -> palette index
}
export interface ParentEdge {
  parentOid: string;
  destination: { lane: number; colorId: number };
}
export interface ThroughSegment {
  lane: number;
  colorId: number;
  // full vertical passage, does NOT connect to this row's node
}
export interface GraphRow {
  oid: string;
  lane: number;
  colorId: number;
  nodeKind: 'normal' | 'merge' | 'root' | 'boundary';
  incoming: boolean; // true only if OID was pending before this row
  through: ThroughSegment[];
  parentEdges: ParentEdge[];
}
```

`HistoryLayout` owns the slots, pending OID map and seen OIDs for one session. `append` returns the new rows and advances the private session state. Previously returned rows keep their original geometry. Discard the layout after an invalid page or scope change. Tests compare one append of the full history with multiple paged appends.

## 3. Active Lanes algorithm

Represent active lanes as stable numbered slots, from left to right. A slot holds the next commit expected on that lane. Unused middle slots are null; never compact middle slots in v0.1 (prevents discontinuity); trim only trailing nulls. Prefer the current slot for first parent; secondary parents use nearest free slot to its right, otherwise lowest free slot, otherwise append. Existing pending parents always win. Maintain a pendingOid -> slot index map if performance warrants; initial O(L) scans are sufficient.

### One row transition

```text
for commit in topological_order:
    assert commit.oid not in seen
    # Before processing, retain pre-row slots for through/incoming geometry.
    before = snapshot(active slots)
    existing = find_slot(commit.oid)
    if existing exists:
        k = existing
        color = before[k].colorId
        incoming = true
    else:
        k = lowest_free_slot_or_append()
        color = allocate_color()
        incoming = false

    # Consume current commit, preserve all unrelated slots in place.
    clear(k)
    through = every non-null before slot except k

    # Reserve the first parent destination before other parents allocate.
    for i, parent in enumerate(unique_preserve_order(commit.parents)):
        if parent in seen: fail invalid topology (not a normal lane merge)
        j = find_slot(parent)
        if j exists:
            dest_color = slots[j].colorId
        else if i == 0:
            j = k
            dest_color = color
            slots[j] = Lane(parent, dest_color)
        else:
            j = nearest_free_right_else_lowest_or_append(k)
            dest_color = allocate_color()
            slots[j] = Lane(parent, dest_color)
        append edge(k, j, dest_color, parent, i == 0)
    trim_trailing_nulls()
    seen.add(commit.oid)
    emit GraphRow(k, color, incoming, through, parentEdges, ...)
```

If first parent already pending on another lane, the current lane terminates into that lane; any secondary parent may reuse the freed slot (with a new color). If an unrelated active lane passes through the row, draw its vertical segment without connecting to the node; joining edges end on that lane at row bottom. At row top incoming is drawn only for a previously active lane. A new independent tip has no incoming line. Root has no parent edges; shallow boundary is explicitly styled based on known shallow commit metadata rather than assuming all parentless traversal rows are true roots. When parsing inconsistent data, do not synthesize a plausible graph: report error and offer reload.

Time is O(N × L) with slot scans for geometry, and memory for retained geometry is O(N × L) in the worst case. The working state is O(N + L), including seen OIDs. The current renderer scrolls horizontally, with limits of 256 lanes and two million retained segments. If a page exceeds either limit, History displays the reason and preserves previously loaded rows. A narrower history scope can reduce width.

## 4. Worked example

```text
A parents [B,C]    # merge tip
B parents [D]
C parents [D]
D parents []
```

| Row | Slots before | Node lane | Parent edge destination(s) | Slots after |
| --- | --- | ---: | --- | --- |
| A | [] | 0 | B:0; C:1 | [B,C] |
| B | [B,C] | 0 | D:0 | [D,C] |
| C | [D,C] | 1 | D:0 | [D] |
| D | [D] | 0 | none | [] |

```text
   A ●╮
     ││
   B ●│
     ││
   C │●
     ├╯
   D ●
```

The ASCII is illustrative; use actual per-row SVG geometry, not ASCII as data. Octopus merges use the same algorithm with 3+ parents. Independent roots may allocate a new lane even while older pending lanes remain active. Criss-cross merges reuse actual OIDs; don't infer “main branch” from leftmost lane.

## 5. Stable color and geometry

Default dark palette: purple #BC7CE9, orange #E5AA65, cyan #59C3D0, blue #7DA8EF, green #7DC7A4, pink #E482A7, yellow #D5C16C, indigo #9D96EA. Allocate colors deterministically by monotonic colorId modulo palette length; optionally choose next palette entry not currently used by neighboring lanes (algorithm must be deterministic). Inherit first-parent color on a new slot; when joining existing lane use destination color for the outgoing edge. Node color stays that of its incoming lane (or newly allocated tip). Repeated loads of the same root snapshot/commit order have identical layout; ref changes may legitimately change layout. Labels can color by ref kind, not imply branch ownership.

Row height H = 28 px, lane spacing S = 14 px, left inset P = 12 px, node radius about 4 px. The node center is `(P + lane*S, H/2)`. Each SVG uses the shared graph width and viewBox `0 0 width H`. Through segments run from y=0 to y=H, incoming segments reach the node center, and parent edges end at the destination lane at y=H. Same-lane edges are straight and changes of lane use cubic Beziers. Draw through lines, parent edges and then the node. Merge uses a ring with an inner dot, regular commits use solid dots, root uses a square and shallow boundaries use a triangle. Incoming and outgoing meet at row boundaries.

Graph column width = max(minWidth, 2P + (maxLaneCount-1)*S). Shared column width across all rendered rows. Use horizontal scroll for wide histories; do not shrink lane spacing to zero. Optionally freeze a reasonable graph/message viewport, but preserve scrollability and labels. Merge node and branch labels accessible via semantic row text (e.g. “merge, 2 parents”), not only color.

## 6. Pagination and history consistency

Backend owns session roots, decorations, streaming Git process and sequence; frontend owns lane state, row cache, current selection, virtual list. Open creates first page; one request in flight for next page per session. Sequence mismatch, stale session or duplicated OID fails with structured error. Preserve `LayoutState` exactly across pages (no page-local resets). At lower loaded boundary, show loading/continue marker with active lanes extending to bottom; actual end with nonempty active lanes indicates truncation/missing parents, not fabricated merges. Backend should surface shallow/limited state. If user refreshes or changes scope, start a new session, cancel old reads, restore selection by OID if present. If refs change mid-session, mark stale; never append data from new root list to old graph.

Search in v0.1 highlights and navigates loaded rows by subject, author, or hash. Keep existing rows and edges while searching. Load additional matches in bounded cancellable batches with explicit progress and incomplete state. If full search later uses Git `--grep`, return OIDs and locate in the existing layout. Switching history scope (`all`, `current`, `local`, or exact `ref`) starts a new session with roots defined in [ARCHITECTURE.md](ARCHITECTURE.md).

Local and remote visibility flags change ref decorations only. Commit OIDs, row order, `GraphRow`, `LayoutState`, and the active session stay stable across all four flag combinations. Resolve jumps to a ref against the frozen snapshot. For unloaded targets, continue in bounded cancellable pages using the existing lane state. If no target row is found, offer a scope change and let the user choose it explicitly.

## 7. Rendering and interaction

React HistoryTable uses TanStack Virtual with fixed estimated row height 28px, overscan initially 12–20 rows. Commit rows have SVG graph cell + HTML metadata cells in one virtualized row. Memoize row layout and renderer; no whole-graph SVG or force-layout package. Stable key = commit OID + sessionId. Keep selected OID independent from row index. Scroll to hash using virtualizer; keyboard up/down moves selection, Enter opens details, Escape closes lower panel/search. Ensure selected row remains visible; copy full hash via context menu. Use a separate sticky header and synchronized horizontal scrolling. Diff fetch on selection is cancellable/debounced; stale detail responses discarded.

Keep layout synchronous for page-size batches only; if profiling shows main-thread cost, move pure algorithm to Web Worker with serializable snapshot (seen stored in worker). Avoid worker before correctness/benchmarks. Do not recalculate graph on hover, toolbar state, resize or theme switch.

Optional release status columns attach evidence to full OIDs in an independent query against each frozen target tip. They share the 28 px row height. Displaying evidence uses the current row order and lane layout. See [Release Tracking](RELEASE_TRACKING.md).

## 8. Testing and acceptance

Pure TS tests (Vitest): linear, fork/merge, octopus, multiple tips/unrelated roots, nested/criss-cross, first parent already pending, secondary already pending, root, shallow boundary, missing parent, duplicate OID, invalid topology, long lane lifetime, > palette size, paging at every possible cut for small fixtures. Property tests with seeded random DAGs: all parent edges match input; after all reachable commits consumed no pending lanes; before/after geometry continuity; no duplicate pending OIDs; no later child refers to seen parent; identical rows across pagination boundaries.

Integration fixtures generate actual Git repos (temp directories) with deterministic dates/author, controlled commits, merges, tags, detached HEAD/worktrees, and shallow clone via file://. Compare collected commits and parent arrays with Git output; compare reachability and edge sets rather than pixel-identical Git ASCII. Test annotated/lightweight tags and non-commit tag targets. Test history snapshot during external ref update, cancellation, stale responses and parser chunk splits. Never write fixture commits in real user workspaces.

UI: screenshot comparisons for linear, dense merge, dark theme, narrow/window-wide graph, selected merge, scroll page boundary. Manual review against design reference: graph lines crisp, no row jumps; text never overlaps graph; labels truncate with tooltip; selection does not change layout. Benchmark 100k synthetic commits (real Git fixture if feasible), record p95 page layout time, memory, initial visible frame, scroll FPS; target <16.7 ms per frame in normal graphs, use profiling before optimization.

引用覆盖同一 OID 上的本地和远程标签、目标已分叉的跟踪分支，以及具有远程独有提交的历史。四种开关组合输出相同的提交行和边。仅本地分支范围保留从本地分支可达的历史，包括已合并进本地的提交。定位测试覆盖已加载、后续页和当前范围无目标三种情况。

M3 合成测试在 Apple M4、macOS 26.6.2、Apple Git 2.54.0 上运行，使用 `git fast-import` 生成线性历史。Rust 调试构建首批 500 条约 287 ms，读取 100,000 条约 494 ms。Node 24.19 的纯布局测试每批 500 条 p95 约 0.25 ms。这两项测量分别覆盖读取和布局，窗口呈现及滚动测量在 M6 记录。可用 `cargo test --manifest-path src-tauri/Cargo.toml benchmark_one_hundred_thousand_commits -- --ignored --nocapture` 复现读取测试。

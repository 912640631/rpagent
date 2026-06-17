# Issue tracker: Local Markdown

任务和规格存放在 `.scratch/`。

## 文件约定

- 每个功能使用 `.scratch/<feature-slug>/`。
- 规格存放在 `spec.md`。
- 实现任务分别存放在 `issues/<NN>-<slug>.md`，从 `01` 开始编号。
- 每个任务文件顶部附近使用 `Status:` 记录分类状态；
  状态名称见 `triage-labels.md`。
- 评论和对话历史追加在文件末尾的 `## Comments` 下。

## 技能操作

“发布到任务跟踪器”：按上述约定创建文件及所需目录。
“获取相关任务”：读取指定路径；仅提供编号时，在对应功能目录中查找。

## Wayfinding

- 地图：`.scratch/<effort>/map.md`，包含 Notes、
  Decisions-so-far、Fog。
- 子任务：`.scratch/<effort>/issues/<NN>-<slug>.md`，
  从 `01` 编号，正文记录问题。
- `Type:` 为 research、prototype、grilling 或 task。
- Wayfinding 的 `Status:` 使用 open、claimed、resolved，
  与普通任务的 triage 状态分开使用。
- `Blocked by: NN, NN` 记录依赖；所有依赖 resolved 后解除阻塞。
- 选择任务：扫描 open、未阻塞且未认领的任务，优先编号最小者。
- 认领：开始工作前写入 `Status: claimed` 并保存。
- 完成：在 `## Answer` 下追加答案，设为 resolved，
  并在地图的 Decisions-so-far 中追加摘要和链接。

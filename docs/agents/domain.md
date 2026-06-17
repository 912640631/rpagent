# Domain docs

## 探索代码前

采用 single-context 布局：

- 阅读根目录 `CONTEXT.md`。
- 阅读 `docs/adr/` 中与当前工作相关的架构决策记录。

文件不存在时，直接继续。
由 domain-modeling 技能在术语或决策明确后按需创建文档。

## 术语

在任务标题、设计建议、假设和测试名称中，使用
`CONTEXT.md` 定义的术语。

需要的概念尚未收录时，确认是否符合项目用语；
确有缺口则记录为 domain-modeling 的后续输入。

## 决策冲突

建议与现有 ADR 冲突时，明确指出对应 ADR、
冲突内容以及建议重新考虑的理由。

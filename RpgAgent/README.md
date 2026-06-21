# 独立 RPG Agent

TypeScript CLI，直接复用 NarrativeDice 和 CombatEngine。需要 Node.js 24+。

在仓库根目录运行：

```powershell
npm install
npm run build
node RpgAgent/dist/src/cli.js --init
npm run rpg
```

`--init` 从根目录 `api接入.txt` 读取 local、deepseek 通道，生成被 Git 忽略的 `.local/rpg/providers.json`。不会输出密钥，不覆盖现有配置。
也可复制 `providers.example.json` 到该路径，用 `apiKeyEnv` 引用环境变量；不要提交带密钥的配置。

网页通过 `npm run web` 启动。在“模型与提示词”中可读取已保存 Provider 的模型目录，为两个 Agent 或 Provider 默认模型选择模型，也可手动输入模型 ID。修改连接后先保存，再刷新目录；目录仅代表 Provider 列出的模型，实际调用请使用“测试已保存连接”。目录请求在 10 秒后超时，服务端通过 `GET /api/providers/:id/models` 返回去重、排序后的模型 ID，不返回凭据。

玩家故事和实时输出会隐藏内部叙事续接备忘 JSON，已有历史与旧存档读档后同样生效。过滤只作用于展示，不修改 Agent 上下文或原始存档；执行控制台的 `message.complete` 详情保留原始消息用于排查。

Provider 只做路由键，多个 Provider 共用 `openai-chat` Adapter。`baseURL` 是 API 前缀（如 `/v1`），Adapter 追加 `/chat/completions`。
主 Agent 和战斗子 Agent 可分别配置 provider/model。`requestFields` 可提供兼容服务的额外字段，例如 `reasoning_effort` 或 `thinking`；协议保留字段由 Adapter 覆盖。
不支持 SSE 或 `stream_options` 的服务可在对应 Provider 设置 `stream: false`。
`contextTokens` 默认 32768 是保守的本地配置，不是自动发现的模型容量，请按服务实际容量修改。

命令：`/compact` 压缩主 Agent 旧消息；`/status` 查看规则状态；`/retry` 继续未完成生成或工具循环；`/quit` 退出。
用 `--config <路径>` 指定配置，`--save <目录>` 切换冒险存档。每个存档只允许一个 CLI 进程写入。

主 Agent 做叙事，战斗时由全新子 Agent 上下文接管同一 CLI；引擎负责规则。首版只支持杰洛特对单只目录怪物。
角色 HP、护甲、法印点、毒性、状态与药剂在下一场战斗继续保留；没有新增战斗外休息或恢复规则。
战斗归档保存完整规则事件，主 Agent 只接收默认 1500 tokens 内的结算。必要字段过大时报错，调整预算后 `/retry`。

主 Agent 的固定备忘只有当前局面、继续所需事实、未完成行动与玩家意图，不建立额外游戏状态系统。
API usage 达到配置容量的 75% 时触发压缩；默认保留约 6000 tokens 最近完整消息，工具调用和结果成组保留。
系统指令、工具定义、规则权限与权威规则状态在每次请求时独立提供，不交给摘要模型改写。
用本地 `cl100k_base` tokenizer 对预算及 50% 压缩率做一致计数；兼容服务实际 tokenizer 可能不同，自动压力取 API usage，不能把本地计数视作服务计费计数。
两次压缩失败保留旧历史；上下文过大时停止生成。流式缺少 usage 时后续请求改为非流式，仍无 usage 则提示使用手动压缩。

模型完整响应后才执行工具。执行前保存工具日志和发起 Agent，工具结果始终写回该 Agent 的历史；恢复时核对引擎版本，已提交规则步骤不会再次执行。
模型输出中断时可用 `/retry`，尚未执行的玩家输入和授权随存档保留。成功提交玩家步骤后消费授权，后续追加选择仍需玩家新输入；同场战斗重启从权威状态重建上下文，并保留仍有效的未执行输入。
存档分为应用上下文 `session.json` 和引擎权威状态 `rules.json`，二者必须一起保留。

规则账本持久化叙事随机序列与下一场战斗的随机种子来源，和规则结果一起提交。网页手动存档会在首次判定前初始化随机状态，读档后相同规则操作可得到相同骰值；模型生成仍可能不同。已有 version-1 账本缺少该字段时自动初始化，过去未记录随机状态的快照无法还原当时的随机序列，重新保存后才具备完整随机状态。

Chat Completions 协议依据：[官方 API 文档](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

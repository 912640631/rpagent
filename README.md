# AI-GM RPG 

**TypeScript / Node.js / React / Vite / Tool Calling / SSE / Context Engineering**

独立开发的可玩 AI-GM RPG Web 原型，将 LLM 叙事与确定性游戏规则结合，串联自由冒险、战斗交接、实时状态同步与存档恢复。玩家用自然语言描述行动，主 Agent 主持剧情，战斗子 Agent 接管战斗，规则引擎负责校验与结算。

## 核心能力

- **交互式 Web 客户端**：React + Vite 实现流式剧情、战斗交互、角色状态、模型配置与存读档；Node.js 提供 HTTP API，通过 SSE 的 `baseline` / `delta` 同步状态和 Agent 执行过程，控制台展示 Tool Call 参数、结果与请求事件。
- **多模型服务适配**：封装 OpenAI-compatible Chat Completions 调用层，主 Agent 与战斗子 Agent 可独立配置 Provider 和模型；支持流式响应解析、增量 Tool Call 参数拼接、模型目录与连接检测。可配置非流式调用，流式缺少 usage 时后续请求自动改用非流式。
- **持久化与恢复**：分离 Agent 会话与权威规则状态，以 NDJSON 事件日志、Checkpoint 和原子文件写入保存进度；恢复时结合工具执行记录与规则 Revision 判断提交状态，避免重复执行已完成的规则操作。手动存档配套保存上下文、规则、随机数状态和故事记录，读档前自动备份。
- **Agent 上下文管理**：依据 Token 预算，将主 Agent 的早期剧情压缩为结构化的叙事续接备忘，保留近期完整消息及成组的工具调用结果；规则状态独立提供，完整故事独立存储，控制长对话的上下文规模。
- **LLM 与规则协同**：通过 Tool Calling 将自然语言意图映射为可校验的游戏操作；确定性规则核心维护掷骰、资源、伤害与状态，模型根据规则结果生成叙事。

## 快速开始

需要 **Node.js 24+**。在仓库根目录运行：

```powershell
npm install
npm run web
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)，在「模型」中配置 API 地址、凭据和模型，保存并测试连接，再新建冒险。模型服务需要支持 Tool Calling；API 地址填写前缀（如 `https://example.com/v1`）。

网页数据默认保存在 `.local/web-rpg/`。浏览器断线后后台行动继续执行；模型失败或进程中断后，使用「重试恢复」继续。

## 项目结构

| 模块 | 职责 |
| --- | --- |
| [Frontend](Frontend/) | React 客户端、SSE 增量同步、骰子动画与执行控制台 |
| [RpgAgent](RpgAgent/README.md) | Agent 调度、模型适配、上下文管理、HTTP API 与存档恢复 |
| [CombatEngine](CombatEngine/README.md) | 战斗规则、行动校验与权威状态账本 |
| [NarrativeDice](NarrativeDice/README.md) | 叙事判定与希望／绝望资源结算 |

`npm run build` 构建全部模块；`npm test` 构建并运行引擎、Agent、Web、前端及 CLI 测试。另提供 [独立 RPG Agent CLI](RpgAgent/README.md) 和根目录 `cli.js` JSON 规则入口。


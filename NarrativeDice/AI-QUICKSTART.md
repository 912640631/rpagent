# 给 AI GM 的最短使用说明

同一局会进入 CombatEngine 战斗时，请直接复制 [统一冒险 AI 提示词](../AI-QUICKSTART.md)，使用根目录 `cli.js`。它覆盖冒险判定、开战、逐步行动和战后继续冒险；下面的独立 CLI 状态不会与战斗共享，不要混用。

在仓库根目录运行以下 PowerShell 命令。每次调用只发送一个 JSON 对象；只读取返回 JSON 的 `result`。状态自动保存在 `NarrativeDice/.local/session.json`，跨调用保留。

```powershell
'{"action":"status"}' | node NarrativeDice/cli.js
'{"action":"roll","difficulty":15,"modifier":2}' | node NarrativeDice/cli.js
'{"action":"roll","difficulty":15,"modifier":2,"useHopeAdvantage":true}' | node NarrativeDice/cli.js
'{"action":"spendFear"}' | node NarrativeDice/cli.js
'{"action":"reset"}' | node NarrativeDice/cli.js
```

| 命令 | 何时调用 |
| --- | --- |
| `status` | 读取当前希望、绝望和完整历史。首次调用自动初始化为希望 2、绝望 0。 |
| `roll` | 你判断剧情需要判定时调用。你先定难度和整数修正；`modifier` 可省略，默认 0。杰洛特的经历或能力适用且希望至少 2 时，可设 `useHopeAdvantage: true`，先支付 2 希望并获得 +3。 |
| `spendFear` | 你决定发动一次需要 2 绝望的 GM Move、Fear Feature 或敌方强化时调用；代码只扣点，不判断叙事条件。 |
| `reset` | 仅在明确开始新任务时调用，清空资源和历史。 |

判定后主要看 `result.outcome` 和 `result.resources`：

| `outcome` | 叙事处理 |
| --- | --- |
| `success_hope` | 成功；玩家得 1 希望，通常继续行动。 |
| `success_fear` | 成功；**立刻**发生较小麻烦，GM 同时得 1 绝望并接过主动权。 |
| `failure_hope` | 失败，后果较轻；玩家得 1 希望，GM 接过主动权。 |
| `failure_fear` | 失败，后果较重；GM 得 1 绝望并接过主动权。 |
| `critical_success` | 两骰相同，自动成功；玩家得 1 希望和额外好处，主动权在玩家侧。 |

`result.dice` 是两颗骰；`result.resources` 是**实际**剩余点数。希望最多 6、绝望最多 12，满额时超出部分舍弃。返回 `ok: false` 时，判定或消费没有完成；按 `error.message` 调整调用。绝望在同一次判定中刚获得后，可以立即用 `spendFear` 消费。

可直接放进 AI GM 指令：**你负责判断何时判定、难度、修正、优势资格和叙事；所有掷骰及希望／绝望增减都调用上述工具。不要自行编造骰点或修改状态文件。**

# 叙事二元骰工具

AI GM 可直接使用 [最短使用说明](AI-QUICKSTART.md)。

这是供 AI GM 调用的独立 Node.js 工具。AI 决定何时判定、难度、修正、杰洛特是否有资格使用希望优势，以及如何叙述结果；工具只掷骰并管理希望、绝望。无需运行 CombatEngine。

同一局需要衔接 CombatEngine 时，使用仓库根目录 `cli.js` 和 [完整 AI 提示词](../AI-QUICKSTART.md)，让叙事与战斗共用账本；独立 CLI 的状态文件不会自动与战斗同步，不要混写同一存档。

## 命令行

在仓库根目录运行，一次调用向标准输入发送一个 JSON 命令，标准输出返回一个 JSON 对象。默认状态保存在 `NarrativeDice/.local/session.json`，也可用 `--state <路径>` 指定其他任务的状态文件。首次调用自动建立 2 希望、0 绝望的状态；只有 `reset` 会清空资源和历史。

```powershell
'{"action":"status"}' | node NarrativeDice/cli.js
'{"action":"roll","difficulty":15,"modifier":2,"useHopeAdvantage":true}' | node NarrativeDice/cli.js
'{"action":"spendFear"}' | node NarrativeDice/cli.js
'{"action":"reset"}' | node NarrativeDice/cli.js
```

`roll` 的 `difficulty` 必须是正整数，`modifier` 是可选的整数（默认 0），`useHopeAdvantage` 是可选的布尔值（默认 `false`）。购买优势先扣 2 希望，再加 3 到总和；希望不足时拒绝判定且不掷骰。`spendFear` 只扣 2 绝望，GM Move 或 Fear Feature 的选择与发动条件由 AI 判断。绝望不足时拒绝消费。错误响应为 `{ "ok": false, "error": { "code": "...", "message": "..." } }`，进程退出码为 1。

## 判定结果

结果包含两颗骰、总和、难度、修正、优势加值、`outcome`、资源实际增减和当前资源。`outcome` 取值为 `success_hope`、`success_fear`、`failure_hope`、`failure_fear` 或 `critical_success`。两骰相同自动暴击成功，即使总和低于难度。

`immediateComplication` 在“成功＋绝望”时为 `true`，表示当前就发生较小麻烦；`fearGained` 同时仍可为 1，留待之后消费。`consequence` 标记为 `none`、`minor_complication`、`light` 或 `serious`；`initiative` 为 `player` 或 `gm`；暴击另有 `extraBenefit: true`。资源已满时实际获取量为 0，叙事结果本身照常发生。

`status` 返回当前希望、绝望及完整事件历史，历史包含每次掷骰和绝望消费。调用方应按顺序执行修改状态的命令。

## JavaScript API

```js
import { createEngine } from './NarrativeDice/index.js';

const engine = createEngine({ statePath: './my-side-quest.json' });
const result = await engine.roll({ difficulty: 15, modifier: 2, useHopeAdvantage: true });
const state = await engine.status();
await engine.spendFear();
await engine.reset();
```

测试可通过 `npm test --workspace @ai-gm/narrative-dice` 运行。

# 战斗引擎

当前支持杰洛特与一只怪物的战斗。调用方选择行动，战斗引擎检查行动是否合法，并结算掷骰、伤害、状态和战斗结果。

## 安装与运行

需要 Node.js 24 或更新版本。从仓库根目录运行：

```powershell
npm install
npm run build
node CombatEngine/dist/src/cli.js simulate --monster wolf --seed 42
```

`simulate` 可省略 `--monster`，逐一模拟所有怪物。运行 `node CombatEngine/dist/src/cli.js coverage` 可查看可用怪物 ID。

## 同一局的叙事与战斗

叙事和战斗共用资源时，使用 `createAdventureSession` 或 `adventure-*` 命令。它把希望、绝望、历史和当前战斗写入同一个 `NarrativeDice/.local/adventure.json` 文件；可用 `ADVENTURE_SESSION_FILE` 为不同冒险指定路径。新局明确调用 `reset`，继续同一局直接读取 `status`。普通叙事掷骰使用 NarrativeDice 的判定规则，进入战斗后账本交给 CombatEngine；战斗结束才可再进行叙事判定。

```js
import { createAdventureSession } from 'witcher-combat-engine';

const adventure = createAdventureSession('./my-adventure.json');
let state = adventure.status();
state = adventure.narrativeRoll(state.revision, { difficulty: 12 });
state = adventure.startBattle(state.revision, { monsterId: 'wolf', seed: 42 });
const battle = state.battle;
state = adventure.act(battle.battleId, battle.revision, {
  type: 'action', id: 'sword:normal', part: 'torso',
  useHopeAdvantage: true, advantage: 'advantage'
});
console.log(state.resources, state.battle.view, state.events);
```

`narrativeRoll`、`spendFear` 和 `startBattle` 使用冒险 `revision`；`act` 使用战斗 `revision`。旧版本提交会被拒绝，历史与资源随行动原子保存。杰洛特的战斗判定可花 2 希望获得 +3，环境优势或劣势另行结算。希望和绝望上限为 6 和 12，初始为 2 和 0。怪物招式和强化从同一绝望池扣费。

命令行分别使用 `adventure-status`、`adventure-reset`、`adventure-roll`、`adventure-spend-fear`、`adventure-start-battle` 和 `adventure-act`。修改命令从标准输入接收 JSON，例如：

```powershell
$cli = 'CombatEngine/dist/src/cli.js'
$state = node $cli adventure-status | ConvertFrom-Json
$input = @{ expectedRevision = $state.result.revision; difficulty = 12 } | ConvertTo-Json
$state = $input | node $cli adventure-roll | ConvertFrom-Json
$input = @{ expectedRevision = $state.result.revision; config = @{ monsterId = 'wolf' } } | ConvertTo-Json -Depth 5
$state = $input | node $cli adventure-start-battle | ConvertFrom-Json
```

## 在 JavaScript 中使用

```js
import { createCombatSession } from 'witcher-combat-engine';

const combat = createCombatSession();
const started = combat.start({ monsterId: 'wolf', seed: 42 });
if (!started.ok) throw new Error(started.error.message);

const next = combat.act(started.battleId, started.revision, {
  type: 'action', id: 'sword:normal', part: 'torso'
});
if (!next.ok) throw new Error(next.error.message);
console.log(next.view, next.events);
```

`start` 开始战斗并返回 `battleId`、`revision` 和当前 `view`。从 `view.options` 中选择行动；若 `view.pending` 有待处理抉择，则从 `view.pending.options` 中选择，并提交 `{ type: 'decision', choice: '...' }`。行动还可按选项需要提供 `choice`、`advantage`、`useHopeAdvantage`、`empowerHit` 或 `empowerDamage`。

每次 `act` 只提交一条命令，成功后返回更新的视图和本次新增的 `events`。继续行动时使用新返回的 `revision`。`combat.view(battleId)` 可随时读取当前视图；`combat.view(battleId, true)` 还会返回完整事件历史。失败时返回 `ok: false`、错误代码和可用时的 `current` 视图。

独立战斗会话只保留一场战斗：再次调用 `start` 会替换上一场。需要跨叙事与战斗连续管理资源时，使用上面的冒险会话。

## 从命令行使用

构建后，在仓库根目录的 PowerShell 中运行：

```powershell
$cli = 'CombatEngine/dist/src/cli.js'
$battle = node $cli session-start --monster wolf --seed 42 | ConvertFrom-Json
$input = @{
  battleId = $battle.battleId
  expectedRevision = $battle.revision
  command = @{ type = 'action'; id = 'sword:normal'; part = 'torso' }
} | ConvertTo-Json -Depth 5
$next = $input | node $cli session-act | ConvertFrom-Json
$next.view
```

后续用 `$next.battleId` 和 `$next.revision` 提交下一条命令。`node $cli session-view --battle-id $next.battleId` 查看当前战斗，加上 `--history` 可查看完整事件历史。`session-act` 从标准输入读取 JSON；出错时返回非零退出码。

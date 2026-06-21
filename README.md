# AI-GM RPG Engine

同一个 AI 可以主持自由冒险，并在交战时调用杰洛特与单只怪物的战斗引擎。叙事与战斗共用希望、绝望和历史，战斗结束后继续冒险。

已提供 [TypeScript 独立 RPG Agent](RpgAgent/README.md)：配置模型通道后，直接在命令行玩，主 Agent 负责叙事，战斗子 Agent 接管战斗，支持本地续玩和上下文压缩。

```powershell
npm install
npm run build
node RpgAgent/dist/src/cli.js --init
npm run rpg
```

`--init` 从本地 `api接入.txt` 生成被 Git 忽略的 Provider 配置。已有配置时直接 `npm run rpg`。

需要 Node.js 24 或更新版本。从仓库根目录运行：

```powershell
npm install
npm run build
'{"action":"status"}' | node E:\Projects\witcher\cli.js --state E:\Projects\witcher\.local\adventure.json
```

将 [完整 AI 提示词](AI-QUICKSTART.md) 复制给能执行 PowerShell 的 AI 即可开始。统一入口每次从 stdin 读取一个 JSON，返回 `{ok:true,result}` 或 `{ok:false,error:{code,message}}`；失败退出码为 1。

| action | 输入与用途 |
| --- | --- |
| status / reset | 读取冒险／明确重开整局；reset 清空战斗档案。 |
| roll | expectedRevision、difficulty，可选 modifier、useHopeAdvantage。具体判定位于 result.result。 |
| spendFear | expectedRevision；叙事阶段消费 2 绝望。 |
| monsters | 查询现有怪物的 ID、名称和简介。 |
| startBattle | expectedRevision、config（monsterId，可选 initiative、initial、seed、maxActions）。 |
| act | battleId、战斗 expectedRevision、command；合法行动和待决选项由战斗视图提供。 |
| battleResult | 可选 battleId；只读查询当前或归档战斗终局、双方状态、资源快照和事件。 |

`--state` 优先于环境变量 `ADVENTURE_SESSION_FILE`；两者省略时固定使用仓库内 `NarrativeDice/.local/adventure.json`，不随调用目录变化。相对的显式路径按调用目录解析，推荐始终使用绝对路径。请勿用两个独立 CLI 混写统一存档。不会自动迁移旧叙事存档。

后续战斗初始角色状态通过 config.initial 提供，暂不自动恢复或延续全部角色数值。当前仅支持一对一，同行 NPC 不参与机械结算。完整规则和示例见提示词；库接口及旧 CLI 仍见 [战斗引擎说明](CombatEngine/README.md) 和 [独立叙事工具说明](NarrativeDice/README.md)。

`npm test` 会先构建，再运行两个引擎、独立 RPG Agent 及统一 CLI 的测试。

# AI-GM RPG Engine

当前提供杰洛特与单只怪物的自动战斗引擎。引擎负责检查行动并结算战斗。

需要 Node.js 24 或更新版本。从仓库根目录运行：

```powershell
npm install
npm run build
node CombatEngine/dist/src/cli.js simulate --monster wolf --seed 42
```

交互调用方法见 [战斗引擎使用说明](CombatEngine/README.md)。

叙事判定的双 d12、希望和绝望资源由独立的 [叙事二元骰工具](NarrativeDice/README.md) 提供。

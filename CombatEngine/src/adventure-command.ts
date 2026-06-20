import { AdventureError, createAdventureSession } from './adventure-session.js';
import { combatData, monsterIds } from './data.js';
import type { BattleConfig, Command } from './types.js';

/** One JSON command, one shared adventure ledger. Validation of mechanics stays in the engines. */
export function executeAdventureCommand(input: unknown, storagePath: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AdventureError('INVALID_COMMAND', 'Command must be a JSON object');
  }
  const request = input as Record<string, unknown>;
  const session = createAdventureSession(storagePath);
  const revision = request.expectedRevision as number;
  switch (request.action) {
    case 'status': return session.status();
    case 'reset': return session.reset();
    case 'roll': return session.narrativeRoll(revision, request as unknown as {
      difficulty: number; modifier?: number; useHopeAdvantage?: boolean;
    });
    case 'spendFear': return session.spendFear(revision);
    case 'monsters': return {
      monsters: monsterIds.map(id => {
        const actor = combatData.actors[id]!;
        const moves = Object.values(actor.attacks ?? {}).concat(Object.values(actor.actions ?? {})) as { name_zh: string }[];
        return { id, name: actor.name_zh, description:
          `类型：${actor.monster_type}；难度：${actor.difficulty}；招式：${moves.map(move => move.name_zh).join('、')}` };
      })
    };
    case 'startBattle': return session.startBattle(revision, request.config as BattleConfig);
    case 'act': return session.act(request.battleId as string, revision, request.command as Command);
    case 'battleResult': {
      if (request.battleId !== undefined && (typeof request.battleId !== 'string' || !request.battleId.trim())) {
        throw new AdventureError('INVALID_COMMAND', 'battleId must be a nonempty string');
      }
      const record = session.battleRecord(request.battleId as string | undefined);
      const battle = record.state;
      if (!battle.outcome) throw new AdventureError('BATTLE_NOT_FINISHED', 'Cannot read a result before the battle finishes');
      return {
        battleId: record.battleId, revision: record.revision, monsterId: battle.monsterId,
        outcome: battle.outcome, actionCount: battle.actionCount,
        combatants: battle.combatants, resources: { hope: battle.hope, fear: battle.fear },
        events: battle.events
      };
    }
    default: throw new AdventureError('UNKNOWN_ACTION', 'action must be status, reset, roll, spendFear, monsters, startBattle, act or battleResult');
  }
}

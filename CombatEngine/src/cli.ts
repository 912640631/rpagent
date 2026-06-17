import { readFileSync } from 'node:fs';
import { advanceBattle, createBattle, getBattleView } from './engine.js';
import { combatData, monsterIds, validateCombatData } from './data.js';
import { simulateBattle } from './policy.js';
import { createCombatSession, type SessionResult } from './session.js';
import { AdventureError, createAdventureSession } from './adventure-session.js';
import type { BattleConfig, BattleState, Command } from './types.js';

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function printSession(result: SessionResult): void {
  print(result);
  if (!result.ok) process.exitCode = 1;
}

function cliSession() {
  return createCombatSession(process.env.COMBAT_SESSION_FILE);
}

const operation = process.argv[2] ?? 'help';
try {
  if (operation.startsWith('adventure-')) {
    const session = createAdventureSession(process.env.ADVENTURE_SESSION_FILE);
    if (operation === 'adventure-status') print({ ok: true, result: session.status() });
    else if (operation === 'adventure-reset') print({ ok: true, result: session.reset() });
    else {
      const input = JSON.parse(readFileSync(0, 'utf8')) as {
        expectedRevision: number; battleId: string; command: Command; config: BattleConfig;
        difficulty: number; modifier?: number; useHopeAdvantage?: boolean;
      };
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdventureError('INVALID_COMMAND', 'Command must be an object');
      if (operation === 'adventure-roll') print({ ok: true, result: session.narrativeRoll(input.expectedRevision, input) });
      else if (operation === 'adventure-spend-fear') print({ ok: true, result: session.spendFear(input.expectedRevision) });
      else if (operation === 'adventure-start-battle') print({ ok: true, result: session.startBattle(input.expectedRevision, input.config) });
      else if (operation === 'adventure-act') print({ ok: true, result: session.act(input.battleId, input.expectedRevision, input.command) });
      else throw new AdventureError('UNKNOWN_ACTION', `Unknown adventure action: ${operation}`);
    }
  } else if (operation === 'session-start') {
    const configPath = arg('--config');
    const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) as BattleConfig : null;
    const monsterId = arg('--monster');
    if (!config && !monsterId) throw new Error('--monster or --config is required');
    const seed = arg('--seed');
    const maxActions = arg('--max-actions');
    printSession(cliSession().start(config ?? {
      monsterId: monsterId!,
      ...(seed === undefined ? {} : { seed: Number(seed) }),
      ...(maxActions === undefined ? {} : { maxActions: Number(maxActions) })
    }));
  } else if (operation === 'session-act') {
    const input = JSON.parse(readFileSync(0, 'utf8')) as {
      battleId: string; expectedRevision: number; command: Command
    };
    if (!input || typeof input !== 'object') throw new Error('Session command must be a JSON object');
    printSession(cliSession().act(input.battleId, input.expectedRevision, input.command));
  } else if (operation === 'session-view') {
    const battleId = arg('--battle-id');
    if (!battleId) throw new Error('--battle-id is required');
    printSession(cliSession().view(battleId, process.argv.includes('--history')));
  } else if (operation === 'start') {
    const configPath = arg('--config');
    const config = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) as BattleConfig : null;
    const monster = arg('--monster');
    if (!config && !monster) throw new Error('--monster or --config is required');
    const state = config ? createBattle(config) : createBattle(monster!, Number(arg('--seed', '1')), Number(arg('--max-actions', '200')));
    print(getBattleView(state));
  } else if (operation === 'step') {
    const input = JSON.parse(readFileSync(0, 'utf8')) as { state: BattleState; command: Command };
    print(getBattleView(advanceBattle(input.state, input.command)));
  } else if (operation === 'simulate') {
    const selected = arg('--monster');
    const seed = Number(arg('--seed', '1'));
    const maxActions = Number(arg('--max-actions', '200'));
    if (selected && !monsterIds.includes(selected)) throw new Error(`Unknown monster: ${selected}`);
    const ids = selected ? [selected] : monsterIds;
    const results = ids.map((id, index) => {
      const final = simulateBattle(createBattle(id, seed + index, maxActions));
      return { monsterId: id, outcome: final.outcome, actions: final.actionCount, fear: final.fear,
        geraltHp: final.combatants.geralt.hp, monsterHp: final.combatants.monster.hp,
        ...(selected ? { events: final.events } : {}) };
    });
    print(selected ? results[0] : results);
  } else if (operation === 'coverage') {
    validateCombatData();
    const monsters = monsterIds.map(id => {
      const actor = combatData.actors[id]!;
      return { id, attacks: Object.keys(actor.attacks ?? {}), actions: Object.keys(actor.actions ?? {}),
        traits: Object.keys(actor.traits ?? {}), parts: Object.keys(actor.parts ?? {}) };
    });
    print({ monsterCount: monsters.length, monsters });
  } else {
    process.stdout.write('Usage:\n  node CombatEngine/dist/src/cli.js adventure-status|adventure-reset\n' +
      '  Get-Content command.json -Raw | node CombatEngine/dist/src/cli.js adventure-roll|adventure-spend-fear|adventure-start-battle|adventure-act\n' +
      '  node CombatEngine/dist/src/cli.js session-start --monster wolf [--seed 1]\n' +
      '  node CombatEngine/dist/src/cli.js session-start --config battle.json\n' +
      '  Get-Content command.json -Raw | node CombatEngine/dist/src/cli.js session-act\n' +
      '  node CombatEngine/dist/src/cli.js session-view --battle-id ID [--history]\n' +
      '  npm run engine -- start --monster wolf [--seed 1]\n' +
      '  npm run engine -- start --config battle.json\n' +
      '  npm run engine -- step < input.json\n' +
      '  npm run engine -- simulate [--monster wolf] [--seed 1]\n' +
      '  npm run engine -- coverage\n');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (operation.startsWith('adventure-')) {
    print({ ok: false, error: { code: 'code' in (error as object) && typeof (error as { code?: unknown }).code === 'string' ?
      (error as { code: string }).code :
      error instanceof SyntaxError ? 'INVALID_COMMAND' : 'INTERNAL_ERROR', message } });
  } else if (operation.startsWith('session-')) {
    const inputError = error instanceof SyntaxError || message.startsWith('--') ||
      message === 'Session command must be a JSON object';
    print({ ok: false, error: {
      code: inputError ? (operation === 'session-start' ? 'INVALID_CONFIG' : 'INVALID_COMMAND') : 'INTERNAL_ERROR',
      message
    } });
  } else print({ error: { message } });
  process.exitCode = 1;
}

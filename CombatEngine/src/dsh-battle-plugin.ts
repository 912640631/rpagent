import { commandSchema } from './command.js';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BattleInput, type BattleInputAgent, type PlayerInputMessage } from './battle-input.js';
import { createBattleHandoff, type BattleHandoffContext } from './battle-handoff.js';
import { createAdventureSession } from './adventure-session.js';
import { battlePersona } from './battle-persona.js';
import type { BattleConfig, Command } from './types.js';

// Structural public DSH seams keep the RPG package independent of a checkout/npm DSH version.
interface Agent extends BattleInputAgent<Message> {
  id: string;
  steer(message: Message): void;
  session: { header: { parentSession?: string }; isOwnSeq(seq: number): boolean };
  ctx: { tools: { presentAs(mode: 'native'): () => void } };
}
interface Message extends PlayerInputMessage { source: { kind: string; senderSessionId?: string } }
interface Exec { agent?: Agent; signal: AbortSignal }
type Args = Record<string, any>;
interface Tool {
  name: string; description: string; parameters: object;
  output: { schema: object; render(args: unknown, value: unknown): { type: 'text'; text: string }[] };
  execute(args: Args, exec: Exec): Promise<unknown>;
}
interface Context {
  tools: { register(tool: Tool): unknown };
  agents: { get(id: string): Agent | undefined };
  sessionProjections: { stateOf(session: Agent['session'], key: 'subagent'): { identity?: { mode: string; label?: string; seq: number } } | undefined };
  subagents: {
    getProvider(name: string): { prepareContinuable?: unknown; capabilities: { persona: boolean; toolFilter: boolean } } | undefined;
    startContinuable(spec: object): Promise<{ childId: string }>;
    sendMessage(sender: Agent, target: string, content: { type: 'text'; text: string }[], options: { signal: AbortSignal }): Promise<string>;
  };
  on(event: string, listener: (event: any) => void, options?: { global: boolean }): () => void;
  effect(effect: () => () => void): unknown;
}
export const name = 'rpg-quiet-battle';
export const inject = ['tools', 'agents', 'subagents', 'sessionProjections'];
export interface Config { storagePath?: string; provider?: string }
const prefix = 'rpg-battle:';
const childTools = ['rpg_battle_status', 'rpg_battle_act', 'rpg_battle_wait', 'rpg_battle_settlement', 'rpg_battle_escalate'];
const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
const object = { type: 'object', additionalProperties: true };

export function apply(ctx: Context, config: Config = {}): void {
  // This file is loaded from dist/src, not relative to the DSH process cwd.
  const path = config.storagePath ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../NarrativeDice/.local/adventure.json');
  const handoff = createBattleHandoff(path);
  const adventure = createAdventureSession(path);
  const input = new BattleInput<Message, Agent>(listener => ctx.on('agent/inbox/inserted', listener, { global: true }));
  const native = new Map<Agent, () => void>();
  const parentWaits = new Map<Agent, { accept(message: Message): void; cancel(): void }>();
  const prematureStops = new WeakMap<Agent, number>();
  const identify = (agent: Agent): string | undefined => {
    const identity = ctx.sessionProjections.stateOf(agent.session, 'subagent')?.identity;
    return identity?.mode === 'continuable' && agent.session.isOwnSeq(identity.seq) && identity.label?.startsWith(prefix)
      ? identity.label.slice(prefix.length) : undefined;
  };
  const setup = (agent: Agent) => {
    const id = identify(agent);
    if (!id) return;
    handoff.bindChild(id, agent.id);
    if (!native.has(agent)) native.set(agent, agent.ctx.tools.presentAs('native'));
  };
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => setup(agent), { global: true });
  ctx.on('agent/turn-stopping', ({ agent, signal }: { agent: Agent; signal: AbortSignal }) => {
    const id = identify(agent);
    if (!id || signal.aborted || handoff.status(id).phase === 'finished') return;
    const attempts = (prematureStops.get(agent) ?? 0) + 1;
    prematureStops.set(agent, attempts);
    // Repeated refusal to follow the protocol is a runtime error, not a fake terminal battle.
    if (attempts > 3) throw new Error('Battle agent repeatedly ended before battle completion: ' + id);
    agent.steer(Object.freeze({ id: randomUUID(), role: 'user', source: { kind: 'rpg-battle-protocol' },
      content: [{ type: 'text', text: 'Battle is not finished. Continue via rpg_battle_status; at player decision narrate then call native rpg_battle_wait. Do not issue final.' }] }));
  }, { global: true });
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    input.cancel(agent); native.get(agent)?.(); native.delete(agent); parentWaits.get(agent)?.cancel();
  }, { global: true });
  ctx.on('agent/inbox/inserted', ({ agent, message }: { agent: Agent; message: Message }) => parentWaits.get(agent)?.accept(message), { global: true });
  ctx.effect(() => () => {
    input.dispose();
    for (const wait of [...parentWaits.values()]) wait.cancel();
    for (const dispose of native.values()) dispose();
    native.clear();
  });
  const caller = (exec: Exec) => {
    exec.signal.throwIfAborted();
    if (!exec.agent || ctx.agents.get(exec.agent.id) !== exec.agent) throw new Error('A live calling agent is required');
    return exec.agent;
  };
  const child = (args: Args, exec: Exec) => {
    const agent = caller(exec);
    if (identify(agent) !== args.battleId || handoff.status(args.battleId).childSessionId !== agent.id) throw new Error('Battle belongs to another child');
    return agent;
  };
  const register = (toolName: string, description: string, properties: object, required: string[], execute: Tool['execute']) => {
    ctx.tools.register({ name: toolName, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: object, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute });
  };
  const spawn = async (battleId: string, exec: Exec) => {
    const parent = caller(exec);
    if (identify(parent)) throw new Error('Battle children cannot delegate');
    const current = handoff.status(battleId);
    if (current.phase === 'finished') throw new Error('Battle is already finished');
    if (current.childSessionId) return { kind: 'continuable', battleId, subagentId: current.childSessionId, resumed: true };
    const started = await ctx.subagents.startContinuable({ provider: config.provider ?? 'spawn', label: prefix + battleId, signal: exec.signal,
      request: { parent, label: prefix + battleId, persona: battlePersona, toolFilter: { allow: childTools },
        prompt: [{ type: 'text', text: JSON.stringify({ battleId, instruction: 'Read rpg_battle_status, narrate, then wait for player input. Never final before terminal battle.' }) }] } });
    handoff.bindChild(battleId, started.childId);
    return { kind: 'continuable', battleId, subagentId: started.childId,
      instruction: 'Open this child session and type player actions there. On final notification call rpg_battle_settlement to verify engine truth; never treat forwarded assistant prose as verified settlement.' };
  };
  register('rpg_adventure_status', 'Read the shared resource ledger before handing off a battle.', {}, [], async (_args, exec) => { caller(exec); return adventure.status(); });
  register('rpg_start_battle', 'Start one catalog-monster battle and return its directly playable quiet child.',
    { expectedRevision: integer,
      config: { ...object, description: 'BattleConfig: required monsterId (catalog ID e.g. wolf); optional seed, maxActions, initiative (geralt|monster), initial (geralt/monster hp, armor, signPoints, toxicity, statuses, trauma, potions). Never supply hope/fear; ledger owns resources.' },
      context: { type: 'object', additionalProperties: false,
        properties: { scene: string, facts: { type: 'array', items: string }, objectives: { type: 'array', items: string },
          environment: { type: 'array', items: string }, risks: { type: 'array', items: string },
          participants: { type: 'array', items: { type: 'object', properties: { id: string, role: { type: 'string', enum: ['geralt', 'monster'] } }, required: ['id', 'role'], additionalProperties: false }, description: 'Exactly one Geralt and one monster with unique story object IDs.' },
          resources: { type: 'object', properties: { revision: integer, hope: integer, fear: integer }, required: ['revision', 'hope', 'fear'], additionalProperties: false } },
        required: ['scene', 'facts', 'objectives', 'environment', 'risks', 'participants', 'resources'] } }, ['expectedRevision', 'config', 'context'], async (args, exec) => {
      const parent = caller(exec);
      if (identify(parent)) throw new Error('Battle children cannot start another battle');
      const provider = ctx.subagents.getProvider(config.provider ?? 'spawn');
      if (!provider?.prepareContinuable || !provider.capabilities.persona || !provider.capabilities.toolFilter) throw new Error('Load an in-process continuable spawn provider with persona and toolFilter');
      const started = handoff.start(args.expectedRevision, args.config as BattleConfig, args.context as BattleHandoffContext);
      try { return await spawn(started.battleId, exec); }
      catch (error) { throw new Error('Battle ' + started.battleId + ' is saved. Retry rpg_attach_battle; do not start/reset it. ' + String(error)); }
    });
  register('rpg_attach_battle', 'Retry child creation for an already saved handoff. An existing child is never duplicated.', { battleId: string }, ['battleId'], (args, exec) => spawn(args.battleId, exec));
  register('rpg_battle_status', 'Read persisted battle, available commands, revision and whose decision is next.', { battleId: string }, ['battleId'], async (args, exec) => { caller(exec); return handoff.status(args.battleId); });
  register('rpg_battle_act', 'Apply exactly one legal CombatEngine command at expected battle revision.',
    { battleId: string, expectedRevision: integer, command: commandSchema }, ['battleId', 'expectedRevision', 'command'], async (args, exec) => {
      child(args, exec);
      if (parentWaits.has(exec.agent!)) throw new Error('Waiting for GM decision');
      return handoff.act(args.battleId, args.expectedRevision, args.command as Command);
    });
  register('rpg_battle_wait', 'After narration, keep this native tool pending until the player types in this child chat. No timeout, no final reply.',
    { battleId: string, expectedRevision: integer }, ['battleId', 'expectedRevision'], async (args, exec) => {
      const agent = child(args, exec);
      const before = handoff.status(args.battleId);
      if (before.revision !== args.expectedRevision || !['player_action', 'player_decision'].includes(before.awaiting ?? '')) throw new Error('Not the current player decision');
      prematureStops.delete(agent);
      const message = await input.waitForPlayerAction(agent, exec.signal);
      const current = handoff.status(args.battleId);
      return { battleId: args.battleId, expectedRevision: current.revision, stale: current.revision !== before.revision,
        messageId: message.id, content: message.content, instruction: 'Use this input once. If stale, re-read status before interpreting; engine revisions prevent repeat commits.' };
    });
  register('rpg_battle_settlement', 'Read engine-derived final settlement; main GM must verify this instead of trusting forwarded prose.',
    { battleId: string, narrativeSummary: { type: 'string' } }, ['battleId'], async (args, exec) => { caller(exec); return handoff.settlement(args.battleId, args.narrativeSummary); });
  register('rpg_battle_escalate', 'Ask main GM about an unruled major story change and wait for its adjacent-agent reply. Never changes mechanics.',
    { battleId: string, question: string }, ['battleId', 'question'], async (args, exec) => {
      const agent = child(args, exec);
      const parent = agent.session.header.parentSession;
      if (!parent || !ctx.agents.get(parent)) throw new Error('Main GM unavailable; keep battle unchanged and retry later');
      if (parentWaits.has(agent)) throw new Error('A GM decision is already pending');
      let cancel!: () => void;
      const reply = new Promise<Message>((resolveReply, reject) => {
        const clean = () => { parentWaits.delete(agent); exec.signal.removeEventListener('abort', cancel); };
        cancel = () => { clean(); reject(new Error('GM decision wait cancelled')); };
        parentWaits.set(agent, { cancel, accept(message) {
          if (message.source.kind === 'agent-message' && message.source.senderSessionId === parent && agent.inbox.remove(message.id)) { clean(); resolveReply(message); }
        } });
        exec.signal.addEventListener('abort', cancel, { once: true });
      });
      // Attach a rejection handler before delivery can fail or cancellation can arrive.
      void reply.catch(() => {});
      try {
        await ctx.subagents.sendMessage(agent, parent, [{ type: 'text', text: JSON.stringify({ kind: 'battle_major_event', battleId: args.battleId, question: args.question, instruction: 'Reply once using send_message to this child. Do not alter engine-resolved outcomes.' }) }], { signal: exec.signal });
        const message = await reply;
        return { battleId: args.battleId, messageId: message.id, content: message.content };
      } catch (error) { cancel(); throw error; }
    });
}

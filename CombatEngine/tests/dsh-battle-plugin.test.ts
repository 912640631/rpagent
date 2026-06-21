import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../src/dsh-battle-plugin.js';

type Host = Parameters<typeof apply>[0];
type Tool = Parameters<Host['tools']['register']>[0];
type Agent = NonNullable<ReturnType<Host['agents']['get']>>;
type Message = Agent['inbox']['nextTurn'][number];

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-battle-plugin-'));
  const tools = new Map<string, Tool>();
  const agents = new Map<string, Agent>();
  const identities = new Map<Agent['session'], { identity: { mode: string; label: string; seq: number } }>();
  const listeners = new Map<string, Set<(event: any) => void>>();
  const cleanups: (() => void)[] = [];
  const presentations: string[] = [];
  const restored: string[] = [];
  const specs: any[] = [];
  const sends: { sender: Agent; target: string; content: unknown }[] = [];
  let failSpawn = false;
  let failSend = false;
  let providerEnabled = true;
  function emit(event: string, value: unknown) { for (const listener of listeners.get(event) ?? []) listener(value); }
  function makeAgent(id: string, label?: string, parentSession?: string, own = true): Agent {
    const nextTurn: Message[] = [];
    const nextStep: Message[] = [];
    const agent: Agent = { id, steer(message) { nextStep.push(message); },
      session: { header: { parentSession }, isOwnSeq: () => own },
      ctx: { tools: { presentAs(mode) { presentations.push(id + ':' + mode); return () => { restored.push(id); }; } } },
      inbox: { nextTurn, nextStep, remove(messageId) {
        for (const queue of [nextStep, nextTurn]) {
          const index = queue.findIndex(message => message.id === messageId);
          if (index >= 0) { queue.splice(index, 1); return true; }
        }
        return false;
      } }
    };
    agents.set(id, agent);
    if (label) identities.set(agent.session, { identity: { mode: 'continuable', label, seq: 1 } });
    return agent;
  }
  const parent = makeAgent('gm');
  const host: Host = {
    tools: { register(tool) { tools.set(tool.name, tool); } },
    agents: { get(id) { return agents.get(id); } },
    sessionProjections: { stateOf(session) { return identities.get(session); } },
    subagents: {
      getProvider() { return providerEnabled ? { prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } } : undefined; },
      async startContinuable(spec) {
        specs.push(spec);
        if (failSpawn) throw new Error('spawn unavailable');
        const request = spec as { label: string; request: { parent: Agent } };
        const child = makeAgent('child-' + specs.length, request.label, request.request.parent.id);
        emit('agent/created', { agent: child });
        return { childId: child.id };
      },
      async sendMessage(sender, target, content) {
        sends.push({ sender, target, content });
        if (failSend) throw new Error('delivery unavailable');
        return 'sent-' + sends.length;
      }
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set); set.add(listener);
      return () => { set.delete(listener); };
    },
    effect(effect) { cleanups.push(effect()); }
  };
  apply(host, { storagePath: join(directory, 'adventure.json') });
  t.after(() => { for (const cleanup of cleanups) cleanup(); rmSync(directory, { recursive: true, force: true }); });
  async function call(name: string, args: Record<string, unknown> = {}, agent = parent, signal = new AbortController().signal): Promise<any> {
    const tool = tools.get(name);
    assert(tool, 'registered tool ' + name);
    return tool.execute(args, { agent, signal });
  }
  function insert(agent: Agent, message: Message) {
    (agent.inbox.nextTurn as Message[]).push(message);
    emit('agent/inbox/inserted', { agent, message });
  }
  async function start(config: object = {}) {
    const state = await call('rpg_adventure_status');
    const result = await call('rpg_start_battle', { expectedRevision: state.revision,
      config: { monsterId: 'wolf', seed: 42, ...config },
      context: { scene: 'Bridge', facts: [], participants: [{ id: 'g', role: 'geralt' }, { id: 'w', role: 'monster' }],
        objectives: ['Survive'], environment: [], risks: [], resources: { ...state.resources, revision: state.revision } } });
    return { ...result, child: agents.get(result.subagentId)! };
  }
  return { call, start, insert, emit, makeAgent, parent, agents, tools, presentations, restored, specs, sends,
    setFailSpawn(value: boolean) { failSpawn = value; }, setFailSend(value: boolean) { failSend = value; },
    setProvider(value: boolean) { providerEnabled = value; } };
}
const message = (id: string, kind = 'user', senderSessionId?: string): Message => ({
  id, source: { kind, senderSessionId }, content: [{ type: 'text', text: 'Strike with the sword' }]
});

test('registered start installs persona/tool filter, native child hooks, pending input and verified final read', async t => {
  const f = fixture(t);
  const started = await f.start({ initial: { monster: { hp: 1 } } });
  assert.equal(started.kind, 'continuable');
  assert.equal(f.specs[0].provider, 'spawn');
  assert.equal(f.specs[0].request.parent, f.parent);
  assert(f.specs[0].request.persona);
  assert.deepEqual(f.specs[0].request.toolFilter.allow, ['rpg_battle_status', 'rpg_battle_act', 'rpg_battle_wait', 'rpg_battle_settlement', 'rpg_battle_escalate']);
  assert.deepEqual(f.presentations, [started.child.id + ':native']);
  f.emit('agent/created', { agent: started.child });
  assert.equal(f.presentations.length, 1);
  assert.equal((await f.call('rpg_attach_battle', { battleId: started.battleId })).subagentId, started.child.id);
  assert.equal(f.specs.length, 1);
  let completed = false;
  const pending = f.call('rpg_battle_wait', { battleId: started.battleId, expectedRevision: 0 }, started.child);
  void pending.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(f.sends.length, 0);
  f.insert(started.child, message('human-1'));
  const input = await pending;
  assert.equal(input.messageId, 'human-1');
  assert.equal(input.stale, false);
  assert.equal(started.child.inbox.nextTurn.length, 0);
  const final = await f.call('rpg_battle_act', { battleId: started.battleId, expectedRevision: 0,
    command: { type: 'action', id: 'sword:normal', part: 'torso', useHopeAdvantage: true } }, started.child);
  assert.equal(final.phase, 'finished');
  assert.equal(f.sends.length, 0, 'ordinary tool calls do not send parent notifications');
  const settlement = await f.call('rpg_battle_settlement', { battleId: started.battleId, narrativeSummary: 'Invented victory text' });
  assert.equal(settlement.structured.outcome, final.view.outcome);
  assert.equal(settlement.narrativeSummary.trusted, false);
  await assert.rejects(f.call('rpg_battle_wait', { battleId: started.battleId, expectedRevision: final.revision }, started.child), /current player decision/);
  f.emit('agent/disposed', { agent: started.child });
  assert.deepEqual(f.restored, [started.child.id]);
});

test('ordinary and inherited siblings stay unaffected; wrong child and stale requests cannot act', async t => {
  const f = fixture(t);
  const started = await f.start();
  const sibling = f.makeAgent('ordinary', 'research-task', 'gm');
  const inherited = f.makeAgent('inherited', 'rpg-battle:' + started.battleId, 'gm', false);
  f.emit('agent/created', { agent: sibling }); f.emit('agent/created', { agent: inherited });
  assert.equal(f.presentations.length, 1);
  const command = { battleId: started.battleId, expectedRevision: 0, command: { type: 'action', id: 'sword:normal' } };
  await assert.rejects(f.call('rpg_battle_act', command, sibling), /another child/);
  await assert.rejects(f.call('rpg_battle_act', command, inherited), /another child/);
  await assert.rejects(f.call('rpg_battle_act', command), /another child/);
  await assert.rejects(f.call('rpg_battle_act', { ...command, expectedRevision: 99 }, started.child), /revision/);
  await assert.rejects(f.call('rpg_battle_wait', { battleId: started.battleId, expectedRevision: 99 }, started.child), /current player decision/);
  const abort = new AbortController();
  const waiting = f.call('rpg_battle_wait', { battleId: started.battleId, expectedRevision: 0 }, started.child, abort.signal);
  f.insert(sibling, message('sibling-human'));
  f.insert(started.child, message('agent-msg', 'agent-message', 'gm'));
  assert.equal(sibling.inbox.nextTurn.length, 1);
  const rejection = assert.rejects(waiting, /cancelled/);
  abort.abort(new Error('cancelled'));
  await rejection;
  f.insert(started.child, message('later-human'));
  const retry = await f.call('rpg_battle_wait', { battleId: started.battleId, expectedRevision: 0 }, started.child);
  assert.equal(retry.messageId, 'later-human');
  assert.equal((await f.call('rpg_battle_status', { battleId: started.battleId })).revision, 0);
});

test('major event waits for exact parent reply, blocks actions and ignores sibling/player messages', async t => {
  const f = fixture(t);
  const started = await f.start();
  const before = await f.call('rpg_battle_status', { battleId: started.battleId });
  const waiting = f.call('rpg_battle_escalate', { battleId: started.battleId, question: 'May a new NPC arrive?' }, started.child);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]!.target, 'gm');
  const sent = f.sends[0]!.content as { text: string }[];
  assert.equal(JSON.parse(sent[0]!.text).kind, 'battle_major_event');
  await assert.rejects(f.call('rpg_battle_act', { battleId: started.battleId, expectedRevision: 0,
    command: { type: 'action', id: 'sword:normal' } }, started.child), /Waiting for GM/);
  await assert.rejects(f.call('rpg_battle_escalate', { battleId: started.battleId, question: 'Duplicate?' }, started.child), /already pending/);
  f.insert(started.child, message('other-agent', 'agent-message', 'other'));
  f.insert(started.child, message('human'));
  f.insert(started.child, message('parent-answer', 'agent-message', 'gm'));
  const reply = await waiting;
  assert.equal(reply.messageId, 'parent-answer');
  assert.deepEqual(started.child.inbox.nextTurn.map((m: Message) => m.id), ['other-agent', 'human']);
  assert.deepEqual(await f.call('rpg_battle_status', { battleId: started.battleId }), before);
});

for (const failure of ['delivery failure', 'cancellation', 'unavailable GM']) {
  test(`major event ${failure} leaves the battle unchanged and permits retry`, async t => {
    const f = fixture(t);
    const started = await f.start();
    const args = { battleId: started.battleId, question: 'New main-story fact?' };
    const before = await f.call('rpg_battle_status', { battleId: started.battleId });
    if (failure === 'delivery failure') {
      f.setFailSend(true);
      await assert.rejects(f.call('rpg_battle_escalate', args, started.child), /delivery unavailable/);
      f.setFailSend(false);
    } else if (failure === 'cancellation') {
      const abort = new AbortController();
      const rejection = assert.rejects(f.call('rpg_battle_escalate', args, started.child, abort.signal), /cancelled/);
      abort.abort(); await rejection;
    } else {
      f.agents.delete('gm');
      await assert.rejects(f.call('rpg_battle_escalate', args, started.child), /GM unavailable/);
      f.agents.set('gm', f.parent);
    }
    assert.deepEqual(await f.call('rpg_battle_status', { battleId: started.battleId }), before);
    const retry = f.call('rpg_battle_escalate', args, started.child);
    f.insert(started.child, message('recovered-parent', 'agent-message', 'gm'));
    assert.equal((await retry).messageId, 'recovered-parent');
    assert.deepEqual(await f.call('rpg_battle_status', { battleId: started.battleId }), before);
  });
}

test('disposing a child cancels native input without consuming later messages', async t => {
  const f = fixture(t);
  const started = await f.start();
  const waiting = f.call('rpg_battle_wait', { battleId: started.battleId, expectedRevision: 0 }, started.child);
  const rejection = assert.rejects(waiting, /cancel|disposed/i);
  f.emit('agent/disposed', { agent: started.child });
  await rejection;
  f.insert(started.child, message('after-disposal'));
  assert.equal(started.child.inbox.nextTurn.length, 1);
  assert.deepEqual(f.restored, [started.child.id]);
});

test('stop hook steers unfinished battles, ignores siblings/abort and accepts real terminal state', async t => {
  const f = fixture(t);
  const started = await f.start({ initial: { monster: { hp: 1 } } });
  const signal = new AbortController().signal;
  f.emit('agent/turn-stopping', { agent: started.child, signal });
  assert.equal(started.child.inbox.nextStep.length, 1);
  assert.equal(started.child.inbox.nextStep[0]!.source.kind, 'rpg-battle-protocol');
  const sibling = f.makeAgent('ordinary');
  f.emit('agent/turn-stopping', { agent: sibling, signal });
  assert.equal(sibling.inbox.nextStep.length, 0);
  const abort = new AbortController(); abort.abort();
  f.emit('agent/turn-stopping', { agent: started.child, signal: abort.signal });
  assert.equal(started.child.inbox.nextStep.length, 1);
  await f.call('rpg_battle_act', { battleId: started.battleId, expectedRevision: 0,
    command: { type: 'action', id: 'sword:normal', part: 'torso', useHopeAdvantage: true } }, started.child);
  f.emit('agent/turn-stopping', { agent: started.child, signal });
  assert.equal(started.child.inbox.nextStep.length, 1);
});

test('repeated premature final replies surface a runtime error instead of fabricated battle completion', async t => {
  const f = fixture(t);
  const started = await f.start();
  const event = { agent: started.child, signal: new AbortController().signal };
  for (let count = 0; count < 3; count++) f.emit('agent/turn-stopping', event);
  assert.throws(() => f.emit('agent/turn-stopping', event), /repeatedly ended/);
  assert.equal((await f.call('rpg_battle_status', { battleId: started.battleId })).phase, 'active');
});

test('provider preflight failure does not commit a battle', async t => {
  const f = fixture(t);
  f.setProvider(false);
  await assert.rejects(f.start(), /continuable spawn provider/);
  assert.equal((await f.call('rpg_adventure_status')).revision, 0);
});
test('failed child spawn preserves the handoff for attachment retry', async t => {
  const f = fixture(t);
  f.setFailSpawn(true);
  await assert.rejects(f.start(), /saved.*Retry rpg_attach_battle/);
  const saved = await f.call('rpg_adventure_status');
  assert.equal(saved.owner, 'combat');
  assert.equal(saved.battle.revision, 0);
  f.setFailSpawn(false);
  const attached = await f.call('rpg_attach_battle', { battleId: saved.battle.battleId });
  assert.equal((await f.call('rpg_battle_status', { battleId: saved.battle.battleId })).childSessionId, attached.subagentId);
  assert.equal((await f.call('rpg_attach_battle', { battleId: saved.battle.battleId })).resumed, true);
  assert.equal(f.specs.length, 2);
});

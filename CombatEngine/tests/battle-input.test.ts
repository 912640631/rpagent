import assert from 'node:assert/strict';
import test from 'node:test';
import { BattleInput, type BattleInputAgent, type PlayerInputMessage } from '../src/battle-input.js';

function fixture() {
  type Event = { agent: BattleInputAgent; message: PlayerInputMessage };
  const listeners = new Set<(event: Event) => void>();
  const input = new BattleInput(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  const makeAgent = () => {
    const nextStep: PlayerInputMessage[] = [];
    const nextTurn: PlayerInputMessage[] = [];
    return { inbox: { nextStep, nextTurn, remove(id: string) {
      for (const queue of [nextStep, nextTurn]) {
        const index = queue.findIndex(message => message.id === id);
        if (index !== -1) { queue.splice(index, 1); return true; }
      }
      return false;
    } } };
  };
  const insert = (agent: ReturnType<typeof makeAgent>, message: PlayerInputMessage, target: 'nextStep' | 'nextTurn' = 'nextTurn') => {
    agent.inbox[target].push(message);
    for (const listener of listeners) listener({ agent, message });
  };
  return { input, makeAgent, insert, listeners };
}
const message = (id: string, kind = 'user'): PlayerInputMessage => ({
  id, source: { kind }, content: [{ type: 'text', text: 'sword:normal' }],
});

test('pending input ignores other agents and non-human messages, preserves original identity and content', async () => {
  const f = fixture();
  const agent = f.makeAgent();
  const other = f.makeAgent();
  const controller = new AbortController();
  let settled = false;
  const pending = f.input.waitForPlayerAction(agent, controller.signal);
  void pending.then(() => { settled = true; });
  f.insert(other, message('other'));
  f.insert(agent, message('parent', 'subagent-message'));
  await Promise.resolve();
  assert.equal(settled, false);
  const action = message('human');
  f.insert(agent, action);
  assert.equal(await pending, action);
  assert.deepEqual(agent.inbox.nextTurn.map(m => m.id), ['parent']);
  assert.equal(other.inbox.nextTurn.length, 1);
  f.input.dispose();
  assert.equal(f.listeners.size, 0);
});

test('queued input is consumed once, steering before next-turn, without polling', async () => {
  const f = fixture();
  const agent = f.makeAgent();
  const first = message('step');
  const second = message('turn');
  f.insert(agent, second);
  f.insert(agent, first, 'nextStep');
  const signal = new AbortController().signal;
  assert.equal(await f.input.waitForPlayerAction(agent, signal), first);
  assert.equal(await f.input.waitForPlayerAction(agent, signal), second);
  assert.equal(agent.inbox.nextStep.length + agent.inbox.nextTurn.length, 0);
  f.input.dispose();
});

test('concurrent wait is rejected without replacing the first waiter', async () => {
  const f = fixture();
  const agent = f.makeAgent();
  const signal = new AbortController().signal;
  const pending = f.input.waitForPlayerAction(agent, signal);
  await assert.rejects(f.input.waitForPlayerAction(agent, signal), /already pending/);
  const action = message('one');
  f.insert(agent, action);
  assert.equal(await pending, action);
  f.input.dispose();
});

test('abort releases the wait, preserves later input and permits a fresh wait', async () => {
  const f = fixture();
  const agent = f.makeAgent();
  const controller = new AbortController();
  const reason = new Error('stopped');
  const pending = f.input.waitForPlayerAction(agent, controller.signal);
  const rejection = assert.rejects(pending, error => error === reason);
  controller.abort(reason);
  await rejection;
  const action = message('later');
  f.insert(agent, action);
  await assert.rejects(f.input.waitForPlayerAction(agent, controller.signal), error => error === reason);
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(await f.input.waitForPlayerAction(agent, new AbortController().signal), action);
  f.input.dispose();
});

test('dispose rejects all pending agents, removes listener and forbids further waits', async () => {
  const f = fixture();
  const agent = f.makeAgent();
  const other = f.makeAgent();
  const signal = new AbortController().signal;
  const first = assert.rejects(f.input.waitForPlayerAction(agent, signal), /disposed/);
  const second = assert.rejects(f.input.waitForPlayerAction(other, signal), /disposed/);
  f.input.dispose();
  f.input.dispose();
  await Promise.all([first, second]);
  assert.equal(f.listeners.size, 0);
  f.insert(agent, message('kept'));
  assert.equal(agent.inbox.nextTurn.length, 1);
  await assert.rejects(f.input.waitForPlayerAction(agent, signal), /disposed/);
});

test('failed removal cannot settle input or consume a different message', async () => {
  const f = fixture();
  const agent = f.makeAgent();
  agent.inbox.remove = () => false;
  const controller = new AbortController();
  let settled = false;
  const pending = f.input.waitForPlayerAction(agent, controller.signal);
  const rejection = assert.rejects(pending, /cancel/);
  void pending.then(() => { settled = true; }, () => {});
  f.insert(agent, message('kept'));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(agent.inbox.nextTurn.length, 1);
  controller.abort(new Error('cancel'));
  await rejection;
  f.input.dispose();
});

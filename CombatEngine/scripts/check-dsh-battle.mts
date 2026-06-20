/** Optional real-DSH smoke test. Run: DSH_CHECKOUT=<built checkout> node --import tsx scripts/check-dsh-battle.mts
 * Does not modify the checkout or install harness dependencies. Uses its built packages.
 * Model output is scripted; the agent, tool pipeline, inbox, scopes and lifecycle are real.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BattleInput } from '../src/battle-input.js';

const checkout = process.env.DSH_CHECKOUT;
if (!checkout) throw new Error('Set DSH_CHECKOUT to an installed, built DSH checkout');
const load = (path: string) => import(pathToFileURL(resolve(checkout, path)).href);
const { Context } = await load('vendor/cordis/lib/index.js');
const { mountAgentLoopTestDependencies } = await load('packages/test-support/agent-loop-testkit/lib/index.js');
const { default: AgentLoop } = await load('packages/core/agent-loop/lib/index.js');
const { createUserMessage } = await load('packages/llm/llm/lib/index.js');
const { defineTool } = await load('packages/core/tools/lib/index.js');
const { subagentIdentityProjectionDefinition } = await load('packages/subagent/subagent/src/projection.ts');
const { MockAdapter, toolCallResponse, textResponse } = await load('packages/core/agent-loop/tests/mock-adapter.ts');
const { PtcRuntime } = await load('packages/ptc-runtime/ptc-runtime/lib/index.js');

const ctx = new Context();
let input: BattleInput<any, any> | undefined;
const timeout = setTimeout(() => { console.error('FAIL: DSH battle smoke test exceeded 20 seconds'); process.exit(1); }, 20_000);
try {
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'ptc' } });
  // No program is executed: this provider only lets the parent advertise PTC.
  class UnusedPtc extends PtcRuntime {
    language = 'typescript'; isolation = 'test';
    resolve(request: unknown) { return request; }
    async run() { throw new Error('Native battle input must never execute PTC'); }
  }
  await ctx.plugin(UnusedPtc);
  await ctx.plugin(AgentLoop, { agents: [] });
  ctx.sessionProjections.register(subagentIdentityProjectionDefinition);
  let createdIdentity: any;
  ctx.on('agent/created', ({ agent }: any) => {
    const identity = ctx.sessionProjections.stateOf(agent.session, 'subagent')?.identity;
    if (identity?.label === 'rpg-battle:smoke') {
      createdIdentity = identity;
      agent.ctx.tools.presentAs('native');
    }
  }, { global: true });
  input = new BattleInput<any, any>(listener => ctx.on('agent/inbox/inserted', listener, { global: true }));
  let signalEntered!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  let consumed: any;
  ctx.tools.register(defineTool({
    name: 'player_action', description: 'Wait for the player.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    async execute(_args: unknown, exec: any) {
      signalEntered();
      consumed = await input!.waitForPlayerAction(exec.agent, exec.signal);
      return JSON.stringify(consumed);
    },
  }));
  const adapter = new MockAdapter([toolCallResponse('input-1', 'player_action', {}), textResponse('battle ended')]);
  ctx.llm.registerAdapter(['mock'], adapter);
  const parentHandle = await ctx.agents.create({ sessionId: 'rpg-smoke-parent', agentOptions: { provider: 'mock', model: 'mock' } });
  // Mirrors continuation-activation.ts setup order, with the actual Agent factory.
  const childHandle = await ctx.agents.create({
    sessionId: 'rpg-smoke-child',
    parentAgent: parentHandle.agent,
    agentOptions: { provider: 'mock', model: 'mock' },
    setup(_childCtx: unknown, child: any) {
      child.session.append('subagent/descriptor', {
        version: 3, mode: 'continuable', provider: 'spawn', label: 'rpg-battle:smoke',
      });
    },
  });
  const child = childHandle.agent;
  assert.equal(createdIdentity?.label, 'rpg-battle:smoke', 'descriptor must exist at created hook');
  const native = await ctx.systemPrompt.assemble({ scope: child });
  assert.deepEqual(native.tools.map((tool: any) => tool.name), ['player_action']);
  const parentPrompt = await ctx.systemPrompt.assemble({ scope: parentHandle.agent });
  assert.deepEqual(parentPrompt.tools.map((tool: any) => tool.name), ['run_code']);
  child.followup(createUserMessage({ source: { kind: 'test' }, content: [{ type: 'text', text: 'start battle' }] }));
  await entered;
  assert.equal(child.status, 'running');
  assert.equal(adapter.requests.length, 1, 'no model step or final while input is pending');
  // Exercise the same public delivery operation used by queued child chat.
  const action = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'sword:normal' }] });
  child.followup(action);
  await child.whenIdle();
  assert.equal(consumed.id, action.id);
  assert.deepEqual(consumed.content, action.content);
  assert.equal(child.inbox.nextTurn.length, 0);
  assert.equal(child.inbox.nextStep.length, 0);
  assert.equal(adapter.requests.length, 2, 'input resumes existing step, never a duplicate turn');
  await childHandle.dispose();
  await parentHandle.dispose();
  console.log('PASS: real DSH pending native tool; exact human inbox consumption; no duplicate turn; created-hook descriptor and scoped native override');
  console.log('Scope: real AgentLoop and tool pipeline; descriptor setup mirrors manager. Continuable manager/Web transport are source-inspected, not exercised by this script.');
} finally {
  clearTimeout(timeout);
  input?.dispose();
  await ctx.fiber.dispose();
}

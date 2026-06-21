import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionChanged, emptySettingsDraft, settingsDraftReducer as reduce, settingsPayload } from '../src/settings-draft.ts';
import type { SettingsResponse } from '../src/types.ts';
import { defaultStyles, defaults } from '../../RpgAgent/src/web/settings.js';
function response(): SettingsResponse {
  return { value: structuredClone(defaults), defaults: structuredClone(defaults), revision: 0,
    prompts: { defaults: defaultStyles, core: { main: '', combat: '' }, effective: { main: '', combat: '' } } };
}
const loaded = () => reduce(emptySettingsDraft, { type: 'loaded', response: response() });
test('JSON is an explicit edit buffer; invalid or unapplied JSON blocks saving', () => {
  const before = loaded();
  const invalid = reduce(before, { type: 'json', text: '{bad' });
  assert.ok(invalid.jsonError); assert.deepEqual(invalid.draft, before.draft);
  assert.throws(() => settingsPayload(invalid), /JSON/);
  assert.deepEqual(reduce(invalid, { type: 'provider', id: 'local', patch: { baseURL: 'changed' } }), invalid);
  assert.deepEqual(reduce(invalid, { type: 'apply-json' }).draft, before.draft);
  const providers = structuredClone(before.draft!.providers); providers.local!.defaultModel = 'edited';
  const pending = reduce(invalid, { type: 'json', text: JSON.stringify(providers) });
  assert.throws(() => settingsPayload(pending), /应用/);
  const applied = reduce(pending, { type: 'apply-json' });
  assert.equal(settingsPayload(applied).providers.local!.defaultModel, 'edited');
  assert.equal(applied.jsonDirty, false);
});
test('invalid Provider shapes cannot be applied', () => {
  for (const text of ['null', '[]', '{}', '{"p":null}', '{"p":{"protocol":"bad"}}']) {
    const state = reduce(loaded(), { type: 'json', text });
    assert.ok(state.jsonError); assert.throws(() => settingsPayload(state));
  }
});
test('Provider, route and JSON forms share the structured draft', () => {
  let state = reduce(loaded(), { type: 'add-provider' });
  state = reduce(state, { type: 'provider', id: 'provider-2', patch: { reasoning: { field: 'reasoning_effort', values: { high: 'high' } } } });
  state = reduce(state, { type: 'route', role: 'main', patch: { provider: 'provider-2', reasoning: '' } });
  assert.equal(state.draft!.main.provider, 'provider-2');
  assert.deepEqual(JSON.parse(state.json), state.draft!.providers);
  assert.equal(state.draft!.providers[state.draft!.main.provider]!.reasoning!.values.high, 'high');
  assert.equal(state.draft!.combat.provider, 'local');
});
test('credentials remain omitted to retain saved secrets; empty string explicitly clears', () => {
  const state = loaded();
  assert.equal(Object.hasOwn(settingsPayload(state).providers.local!, 'apiKey'), false);
  const cleared = reduce(state, { type: 'provider', id: 'local', patch: { apiKey: '' } });
  assert.equal(settingsPayload(cleared).providers.local!.apiKey, '');
  assert.equal(JSON.parse(cleared.json).local.apiKey, '');
});
test('connection changes hide saved catalogues until saved, while model changes retain them', () => {
  const state = loaded();
  assert.equal(connectionChanged(state, 'local'), false);
  assert.equal(connectionChanged(reduce(state, { type: 'provider', id: 'local', patch: { defaultModel: 'custom' } }), 'local'), false);
  for (const patch of [{ baseURL: 'http://other/v1' }, { apiKey: 'key' }, { apiKey: '' }, { apiKeyEnv: 'OTHER_KEY' }, { requestFields: { extra: true } }]) assert.equal(connectionChanged(reduce(state, { type: 'provider', id: 'local', patch }), 'local'), true);
});
test('save responses preserve edits made during the request and never mutate submitted settings', () => {
  const original = loaded(), payload = settingsPayload(original);
  const edited = reduce(original, { type: 'budget', key: 'recentTokens', value: 7000 });
  const saved = reduce(edited, { type: 'saved', response: response(), submittedRevision: original.revision });
  assert.equal(payload.recentTokens, 6000);
  assert.equal(saved.draft!.recentTokens, 7000);
  assert.equal(saved.saved!.value.recentTokens, 6000);
  const clean = reduce(saved, { type: 'saved', response: { ...response(), value: settingsPayload(saved) }, submittedRevision: saved.revision });
  assert.equal(clean.draft!.recentTokens, 7000);
});

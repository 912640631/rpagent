import React from 'react';
import { ModelPicker } from './model-picker.tsx';
import type { BudgetKey } from './settings-draft.ts';
import type { useSettingsDraft } from './use-settings-draft.ts';
import type { AgentRole } from './types.ts';
type Controller = ReturnType<typeof useSettingsDraft>;
const roles = { main: '主 Agent', combat: '战斗子 Agent' };
function ModelField({ controller: c, id, label, value, defaultModel, onChange }: {
  controller: Controller; id: string; label: string; value: string; defaultModel?: string; onChange: (value: string) => void;
}) {
  return <ModelPicker key={`${label}:${id}`} label={label} value={value} defaultModel={defaultModel} directory={c.directory(id)} unsaved={c.unsaved(id)} onChange={onChange} onRefresh={() => c.refresh(id)}/>;
}
export function ProviderEditor({ controller: c }: { controller: Controller }) {
  const { draft, json, jsonDirty, jsonError } = c.state;
  if (!draft) return null;
  return <details><summary>连接管理 · API 地址与凭据</summary>
    {Object.entries(draft.providers).map(([id, p]) => <fieldset key={id} disabled={jsonDirty}><legend>{id}</legend>
      <label>API 地址<input value={p.baseURL || ''} onChange={e => c.dispatch({ type: 'provider', id, patch: { baseURL: e.target.value } })}/></label>
      <ModelField controller={c} id={id} label={`${id}默认模型`} value={p.defaultModel || ''} onChange={value => c.dispatch({ type: 'provider', id, patch: { defaultModel: value } })}/>
      <label>API Key 环境变量<input value={p.apiKeyEnv || ''} onChange={e => c.dispatch({ type: 'provider', id, patch: { apiKeyEnv: e.target.value || undefined } })}/></label>
      <label>API Key（仅本地保存）<input type="password" autoComplete="off" placeholder="不填写则保留；优先使用环境变量" value={p.apiKey || ''} onChange={e => c.dispatch({ type: 'provider', id, patch: { apiKey: e.target.value } })}/></label>
      <button onClick={() => c.dispatch({ type: 'provider', id, patch: { apiKey: '' } })}>清除已保存密钥</button>
    </fieldset>)}
    <button disabled={jsonDirty} onClick={() => c.dispatch({ type: 'add-provider' })}>添加 Provider</button>
    <details><summary>高级 Provider JSON</summary><p>支持 apiKey 或 apiKeyEnv、stream、requestFields 和 reasoning。省略 apiKey 保留原密钥，空字符串清除。编辑后应用 JSON，再保存设置。</p>
      <label>Provider 配置<textarea className="json-editor" spellCheck="false" value={json} onChange={e => c.dispatch({ type: 'json', text: e.target.value })}/></label>
      {jsonError && <p className="banner error" role="alert">{jsonError}</p>}
      {jsonDirty && <p>JSON 尚未应用；连接表单暂时锁定。</p>}
      <button disabled={!jsonDirty || Boolean(jsonError)} onClick={() => c.dispatch({ type: 'apply-json' })}>应用 JSON</button>
    </details>
  </details>;
}
export function AgentRoutes({ controller: c }: { controller: Controller }) {
  const { draft, saved } = c.state;
  if (!draft || !saved) return null;
  return <div className="settings-agents">{(['main', 'combat'] as AgentRole[]).map(role => {
    const route = draft[role], provider = draft.providers[route.provider];
    return <fieldset key={role}><legend>{roles[role]}</legend>
      <label>Provider<select value={route.provider} onChange={e => c.dispatch({ type: 'route', role, patch: { provider: e.target.value, reasoning: '' } })}>{Object.keys(draft.providers).map(id => <option key={id}>{id}</option>)}</select></label>
      <ModelField controller={c} id={route.provider} label={`${roles[role]}模型`} value={route.model || ''} defaultModel={provider?.defaultModel} onChange={value => c.dispatch({ type: 'route', role, patch: { model: value || undefined } })}/>
      <label>推理强度<select value={route.reasoning || ''} onChange={e => c.dispatch({ type: 'route', role, patch: { reasoning: e.target.value } })}><option value="">服务默认</option>{Object.keys(provider?.reasoning?.values || {}).map(v => <option key={v}>{v}</option>)}</select></label>
      <label>上下文容量<input type="number" min="4096" value={route.contextTokens} onChange={e => c.dispatch({ type: 'route', role, patch: { contextTokens: +e.target.value } })}/></label>
      <label>风格指令<textarea value={route.style} onChange={e => c.dispatch({ type: 'route', role, patch: { style: e.target.value } })}/></label>
      <button onClick={() => c.dispatch({ type: 'route', role, patch: { style: saved.prompts.defaults[role] } })}>恢复默认风格</button> <button onClick={() => c.test(role)}>测试已保存连接</button>
      <details><summary>当前有效提示词</summary><pre>{saved.prompts.effective[role]}</pre></details>
    </fieldset>;
  })}</div>;
}
export function BudgetSettings({ controller: c }: { controller: Controller }) {
  const { draft, saved } = c.state;
  if (!draft || !saved) return null;
  const fields: [BudgetKey, string][] = [['maxOutputTokens', '单次最大输出 token'], ['recentTokens', '近期内容保留预算'], ['battleResultTokens', '战斗结果预算'], ['compressionThreshold', '主 Agent 压缩触发比例']];
  return <details><summary>预算与压缩</summary>{fields.map(([key, label]) => <label key={key}>{label}（默认 {saved.defaults[key]}）<input type="number" step={key === 'compressionThreshold' ? '0.05' : '1'} value={draft[key]} onChange={e => c.dispatch({ type: 'budget', key, value: +e.target.value })}/></label>)}
    <p>战斗子 Agent 不压缩；工具循环 48 步；单请求超时 120 秒。不启用 temperature / top_p。</p>
  </details>;
}

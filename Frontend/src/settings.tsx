import { useSettingsDraft } from './use-settings-draft.ts';
import { ProviderEditor, AgentRoutes, BudgetSettings } from './settings-sections.tsx';
import { pretty } from './settings-draft.ts';
import type { RunAction } from './types.ts';
export function Settings({ onClose, run, error }: { onClose: () => void; run: RunAction; error: string }) {
  const controller = useSettingsDraft(run);
  const { state, message, saving, save } = controller;
  if (!state.draft || !state.saved) return <div className="modal"><section>读取设置…{error && <p role="alert">{error}</p>}<button onClick={onClose}>关闭</button></section></div>;
  return <div className="modal" role="dialog" aria-modal="true" aria-label="模型与阅读设置"><section>
    <header><h2>模型与提示词</h2><button onClick={onClose}>关闭</button></header>
    {error && <p className="banner error" role="alert">{error}</p>}
    <p>两个 Agent 独立配置。保存后从下一请求生效，当前请求保持原配置。</p>
    <ProviderEditor controller={controller}/><AgentRoutes controller={controller}/><BudgetSettings controller={controller}/>
    <details><summary>已保存有效值（无密钥）</summary><pre>{pretty(state.saved.value)}</pre></details>
    <footer><span role="status">{message}</span><button className="primary" disabled={saving || state.jsonDirty || Boolean(state.jsonError)} onClick={save}>{saving ? '正在保存…' : '保存设置'}</button></footer>
  </section></div>;
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dice } from './dice.tsx';
import { diceResults } from './dice-results.ts';
import { api } from './api.ts';
import { useAdventure } from './use-adventure.ts';
import { ReadingControls, useReadingPreferences } from './reading.tsx';
import { SavePanel } from './save-panel.tsx';
import type { CSSProperties } from 'react';
import type { Settings, WebProvider, WebRoute } from '../../RpgAgent/src/web/settings.js';
import type { AdventureState, AgentRole, CharacterCard, ConnectionTest, RunAction, SettingsResponse } from './types.ts';
import './style.css';

type BudgetKey = 'maxOutputTokens' | 'recentTokens' | 'battleResultTokens' | 'compressionThreshold';
const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? '';
const roles: Record<string, string> = { main: '主 Agent', combat: '战斗子 Agent' };
const agentName = (role?: string) => roles[role ?? ''] ?? '主持人';
const characterFields = [['hp', 'maxHp', 'HP'], ['armor', 'maxArmor', '护甲'], ['signPoints', 'maxSignPoints', '法印点'], ['toxicity', 'maxToxicity', '毒性']] as const;
const potionNames: Record<string, string> = { thunderbolt: '雷霆', swallow: '燕子', golden_oriole: '金莺', tawny_owl: '猫头鹰' };
function Json({ value }: { value: unknown }) { return <pre>{pretty(value)}</pre>; }
function Settings({ onClose, run, error }: { onClose: () => void; run: RunAction; error: string }) {
  const [data, setData] = useState<SettingsResponse | null>(null), [draft, setDraft] = useState<Settings | null>(null), [providers, setProviders] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { run(async () => { const d = await api<SettingsResponse>('/settings'); setData(d); setDraft(d.value); setProviders(pretty(d.value.providers)); }); }, [run]);
  if (!draft || !data) return <div className="modal"><section>读取设置…<button onClick={onClose}>关闭</button></section></div>;
  const route = <K extends keyof WebRoute,>(role: AgentRole, key: K, value: WebRoute[K]) => setDraft(d => d ? ({ ...d, [role]: { ...d[role], [key]: value } }) : d);
  const save = () => run(async () => { const value = await api<Settings>('/settings', { ...draft, providers: JSON.parse(providers) }); setDraft(value); setProviders(pretty(value.providers)); setData(await api<SettingsResponse>('/settings')); setMessage('已保存 · 从下一次模型请求生效'); });
  let connections: Record<string, WebProvider> | null; try { connections = JSON.parse(providers) as Record<string, WebProvider>; } catch { connections = null; }
  const connection = <K extends keyof WebProvider,>(id: string, key: K, value: WebProvider[K]) => setProviders(pretty({ ...connections, [id]: { ...connections?.[id], [key]: value } }));
  return <div className="modal" role="dialog" aria-modal="true" aria-label="模型与阅读设置"><section><header><h2>模型与提示词</h2><button onClick={onClose}>关闭</button></header>{error && <p className="banner error" role="alert">{error}</p>}<p>两个 Agent 独立配置。保存后从下一请求生效，当前请求保持原配置。</p>
    <details><summary>连接管理 · API 地址与凭据</summary>{connections && Object.entries(connections).map(([id, p]) => <fieldset key={id}><legend>{id}</legend><label>API 地址<input value={p.baseURL || ''} onChange={e => connection(id, 'baseURL', e.target.value)}/></label><label>默认模型<input value={p.defaultModel || ''} onChange={e => connection(id, 'defaultModel', e.target.value)}/></label><label>API Key 环境变量<input value={p.apiKeyEnv || ''} onChange={e => connection(id, 'apiKeyEnv', e.target.value || undefined)}/></label><label>API Key（仅本地保存）<input type="password" autoComplete="off" placeholder="不填写则保留；优先使用环境变量" value={p.apiKey || ''} onChange={e => connection(id, 'apiKey', e.target.value)}/></label><button onClick={() => connection(id, 'apiKey', '')}>清除已保存密钥</button></fieldset>)}<button onClick={() => { const key = `provider-${Object.keys(connections || {}).length + 1}`; setProviders(pretty({ ...connections, [key]: { ...data.defaults.providers.local } })); }}>添加 Provider</button></details>
    <div className="settings-agents">{(['main', 'combat'] as const).map(role => <fieldset key={role}><legend>{roles[role]}</legend>
      <label>Provider<select value={draft[role].provider} onChange={e => { route(role, 'provider', e.target.value); route(role, 'reasoning', ''); }}>{Object.keys(draft.providers).map(id => <option key={id}>{id}</option>)}</select></label>
      <label>模型<input placeholder={draft.providers[draft[role].provider]?.defaultModel} value={draft[role].model || ''} onChange={e => route(role, 'model', e.target.value || undefined)}/></label>
      <label>推理强度<select value={draft[role].reasoning || ''} onChange={e => route(role, 'reasoning', e.target.value)}><option value="">服务默认</option>{Object.keys(draft.providers[draft[role].provider]?.reasoning?.values || {}).map(v => <option key={v}>{v}</option>)}</select></label>
      <label>上下文容量<input type="number" min="4096" value={draft[role].contextTokens} onChange={e => route(role, 'contextTokens', +e.target.value)}/></label>
      <label>风格指令<textarea value={draft[role].style} onChange={e => route(role, 'style', e.target.value)}/></label>
      <button onClick={() => route(role, 'style', data.prompts.defaults[role])}>恢复默认风格</button> <button onClick={() => run(async () => { setMessage('测试已保存的连接…'); const result = await api<ConnectionTest>('/connection-test', { agent: role }); setMessage(`${roles[role]}连接成功 · ${result.elapsedMs} ms`); })}>测试已保存连接</button>
      <details><summary>当前有效提示词</summary><pre>{data.prompts.effective[role]}</pre></details>
    </fieldset>)}</div>
    <details><summary>高级设置 · Provider、预算与压缩</summary><p>Provider JSON 支持添加连接、apiKey 或 apiKeyEnv、stream、requestFields。密钥留空不返回浏览器；省略保留原密钥，设置空字符串清除。推理能力由服务支持的字段与选项映射声明，例如 reasoning: {`{"field":"reasoning_effort","values":{"low":"low","high":"high"}}`}。先保存 Provider 后即可在上方选择。</p>
      <label>Provider 配置<textarea className="json-editor" spellCheck="false" value={providers} onChange={e => setProviders(e.target.value)}/></label>
      {(Object.entries({ maxOutputTokens: '单次最大输出 token', recentTokens: '近期内容保留预算', battleResultTokens: '战斗结果预算', compressionThreshold: '主 Agent 压缩触发比例' }) as [BudgetKey, string][]).map(([key, label]) => <label key={key}>{label}（默认 {data.defaults[key]}）<input type="number" step={key === 'compressionThreshold' ? '0.05' : '1'} value={draft[key]} onChange={e => setDraft(d => d ? ({ ...d, [key]: +e.target.value }) : d)}/></label>)}
      <p>战斗子 Agent 不压缩；工具循环 48 步；单请求超时 120 秒。不启用 temperature / top_p。</p>
      <details><summary>已保存有效值（无密钥）</summary><Json value={data.value}/></details>
    </details><footer><span role="status">{message}</span><button className="primary" onClick={save}>保存设置</button></footer>
  </section></div>;
}
function Character({ state }: { state: AdventureState }) {
  const c: CharacterCard | null | undefined = state.character || state.rules.character;
  return <><h2>杰洛特</h2><p className="muted">利维亚的猎魔人</p><div className="resources"><span>☀ 希望 <b>{state.rules.resources.hope}</b></span><span>☾ 绝望 <b>{state.rules.resources.fear}</b></span></div>
    {c ? <><dl>{characterFields.map(([k, maximum, label]) => <React.Fragment key={k}><dt>{label}</dt><dd>{c[k]}{c[maximum] !== undefined ? ` / ${c[maximum]}` : ''}</dd></React.Fragment>)}</dl><h3>已有状态</h3><p>{Object.entries(c.statuses).map(([key, value]) => `${key} × ${value}`).join(' · ') || '无'}</p><h3>药剂</h3><p>{c.potions.map(p => potionNames[p] || p).join(' · ') || '无'}</p>{c.dead && <p>已死亡 / 失能</p>}</> : <p>尚未进入战斗，角色数值将在规则引擎初始化后显示。</p>}
    <h3>当前局面</h3><p>{state.awaiting === 'player_decision' ? '等待玩家选择' : state.awaiting === 'player_action' ? '等待玩家行动' : state.awaiting === 'monster_action' ? '怪物行动中' : '叙事阶段'}</p>
    {state.battle && <><h3>{state.battle.combatants.monster.name}</h3><p>HP {state.battle.combatants.monster.hp} / {state.battle.combatants.monster.maxHp} · 护甲 {state.battle.combatants.monster.armor}</p><p>行动数 {state.battle.actionCount} · {state.battle.initiative === 'geralt' ? '杰洛特' : '怪物'}回合</p><h3>{state.battle.pending ? '待决选项' : '可用行动'}</h3><p>{(state.battle.pending?.options || state.battle.options).map(o => o.name).join(' · ')}</p><details><summary>战斗权威状态详情</summary><Json value={state.battle}/></details></>}<small>规则版本 {state.rules.revision} · 自动续玩已启用</small></>;
}
function App() {
  const [error, setError] = useState(''), [input, setInput] = useState(''), [name, setName] = useState('');
  const [settings, setSettings] = useState(false), [right, setRight] = useState(true), [consoleOpen, setConsole] = useState(false), [saves, setSaves] = useState(false), [monster, setMonster] = useState('');
  const run: RunAction = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => { setError(''); try { return await action(); } catch (e) { setError(e instanceof Error ? e.message : '请求失败'); } }, []);
  const { list, id, state, events, connected, notice, queue, monsters, select, create, send: submit, save, restore, testBattle, skipDice } = useAdventure(run);
  const [preferences, setPreferences] = useReadingPreferences();
  const end = useRef<HTMLDivElement>(null);
  const selectedMonster = monster || monsters[0]?.id || '';
  const busy = state?.phase === 'running';
  useEffect(() => {
    if (!queue.length) return;
    const timer = setTimeout(skipDice, preferences.animation && !preferences.reduced ? preferences.duration + 1500 : 1800);
    return () => clearTimeout(timer);
  }, [queue[0]?.id, preferences, skipDice]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'instant', block: 'end' }); }, [state?.story.length, state?.stream?.text]);
  const send = async (retry: boolean) => { if (await submit(input, retry) && !retry) setInput(''); };
  const readingStyle: CSSProperties & { '--reading-size': string } = { '--reading-size': `${preferences.font}px` };
  return <div className={`app ${right ? '' : 'hide-right'}`} style={readingStyle}>
    <aside className="sidebar"><div className="brand">✧ <span>猎魔人<small>冒险手记</small></span></div><form onSubmit={e => { e.preventDefault(); void create(name).then(created => { if (created) setName(''); }); }}><input aria-label="新冒险名称" placeholder="为新冒险命名" value={name} maxLength={100} onChange={e => setName(e.target.value)}/><button className="primary" disabled={!name.trim()}>＋ 新建冒险</button></form><nav aria-label="冒险列表">{list.map(a => <button className={a.id === id ? 'selected' : ''} key={a.id} onClick={() => select(a.id)}><span>{a.test ? '⚔ ' : '✦ '}{a.name}</span><small>{new Date(a.createdAt).toLocaleDateString('zh-CN')}</small></button>)}</nav><button onClick={() => setSettings(true)}>⚙ 模型与提示词</button><ReadingControls preferences={preferences} onChange={setPreferences}/></aside>
    <main><header className="topbar"><div><small>THE WITCHER · CHRONICLES</small><h1>{state?.name || '风起之处'}</h1></div><div className="toolbar"><button onClick={() => setSaves(!saves)} disabled={!state}>存读档</button><button aria-pressed={right} onClick={() => setRight(!right)}>角色</button><button aria-pressed={consoleOpen} onClick={() => setConsole(!consoleOpen)}>控制台</button></div></header>
      {error && <div className="banner error" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}{notice && <div className="banner" role="status">{notice}</div>}
      {saves && state && <SavePanel key={id} state={state} onSave={save} onRestore={restore}/>}
      <section className="story" aria-label="冒险故事">{!state?.story.length && <div className="welcome"><span>✧</span><h2>每一段传说，始于一个选择。</h2><p>{id ? '描写你的行动，让故事从这里开始。' : '在左侧创建冒险，配置模型后踏上旅途。'}</p></div>}{state?.story.map(m => <article className={m.role} key={m.id}><small>{m.role === 'user' ? '你' : agentName(m.agent)}</small><div>{m.text}</div></article>)}{state?.stream?.text && <article className="assistant streaming"><small>{agentName(state.stream.agent)} · 正在书写</small><div>{state.stream.text}</div></article>}<details className="rule-history"><summary>历史规则判定（真实记录）</summary>{events.flatMap(event => diceResults(event)).map(result => <p key={result.id}>{result.label} · {result.dice.map(d => `${d.kind === "hope" ? "☀ 希望" : d.kind === "fear" ? "☾ 绝望" : "怪物"} d${d.sides}: ${d.value}`).join(" · ")}{result.total !== undefined && ` · 总值 ${result.total}`}</p>)}</details><div ref={end}/></section>
      {state && <div className="composer"><div className="execution" role="status"><span className={busy ? 'pulse' : ''}>●</span> {!connected ? '连接中 · 后台继续执行' : busy ? '正在执行' : state.phase === 'recovery' ? '等待手动恢复' : '等待你的行动'}{state.error && ` · ${state.error}`}{state.phase === 'recovery' && <button onClick={() => send(true)}>重试恢复</button>}</div><form onSubmit={e => { e.preventDefault(); send(false); }}><textarea aria-label="你的行动" placeholder="你打算怎么做？" value={input} onChange={e => setInput(e.target.value)} disabled={state.phase !== 'waiting'} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); if (input.trim() && connected && !busy) send(false); } }}/><button className="primary" disabled={!input.trim() || !connected || state.phase !== 'waiting'}>继续故事 ↗</button></form><small>Ctrl / ⌘ + Enter 发送 · 自动保存每个执行步骤</small></div>}
      {consoleOpen && <section className="console" aria-label="执行控制台"><header><h2>执行控制台</h2><button onClick={() => setConsole(false)}>收起</button></header><div className="test-battle"><select aria-label="测试怪物" value={selectedMonster} onChange={e => setMonster(e.target.value)}>{monsters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><button disabled={!state || busy || Boolean(state.battle)} onClick={() => testBattle(selectedMonster)}>创建独立战斗测试</button></div>{events.filter(e => e.type !== 'request.chunk' || ['reasoning', 'usage'].includes(e.chunk?.type ?? '')).map(e => <details key={e.id}><summary>#{e.id} {agentName('agent' in e ? e.agent : undefined)} · {e.type} {'model' in e ? e.model : ''} {'elapsedMs' in e ? `${e.elapsedMs} ms` : ''}</summary><Json value={e}/></details>)}</section>}
    </main>{right && <aside className="character">{state ? <Character state={state}/> : <><h2>角色手记</h2><p>选择冒险后查看权威状态。</p></>}</aside>}
    <Dice key={queue[0]?.id} result={queue[0]} preferences={preferences} onSkip={skipDice}/>{settings && <Settings run={run} error={error} onClose={() => setSettings(false)}/>}
  </div>;
}
const root = document.getElementById('root');
if (!root) throw new Error('缺少应用挂载节点');
createRoot(root).render(<App/>);

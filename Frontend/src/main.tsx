import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dice } from './dice.tsx';
import { diceResults } from './dice-results.ts';
import { useAdventure } from './use-adventure.ts';
import { ReadingControls, useReadingPreferences } from './reading.tsx';
import { SavePanel } from './save-panel.tsx';
import { Settings } from './settings.tsx';
import type { CSSProperties } from 'react';
import type { AdventureState, CharacterCard, RunAction } from './types.ts';
import './style.css';

const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? '';
const roles: Record<string, string> = { main: '主 Agent', combat: '战斗子 Agent' };
const agentName = (role?: string) => roles[role ?? ''] ?? '主持人';
const characterFields = [['hp', 'maxHp', 'HP'], ['armor', 'maxArmor', '护甲'], ['signPoints', 'maxSignPoints', '法印点'], ['toxicity', 'maxToxicity', '毒性']] as const;
const potionNames: Record<string, string> = { thunderbolt: '雷霆', swallow: '燕子', golden_oriole: '金莺', tawny_owl: '猫头鹰' };
function Json({ value }: { value: unknown }) { return <pre>{pretty(value)}</pre>; }
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

import React, { useState } from 'react';
import type { FormEvent } from 'react';
import type { AdventureState, SavedSnapshot } from './types.ts';

export function SavePanel({ state, onSave, onRestore }: {
  state: AdventureState;
  onSave: (name: string) => Promise<SavedSnapshot | undefined>;
  onRestore: (snapshotId: string) => Promise<AdventureState | undefined>;
}) {
  const [name, setName] = useState('');
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (await onSave(name)) setName('');
  };
  return <section className="save-panel"><h2>手动存档</h2>
    <p>处理中自动排队；手动存档在安全节点生成，读档等待处理结束并自动备份。失败现场的备份需手动重试恢复。</p>
    <form onSubmit={save}><input aria-label="存档名称" required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="存档名称"/>
      <button disabled={state.phase === 'recovery'}>保存当前进度</button></form>
    {state.saves.map(snapshot => <details key={snapshot.id}>
      <summary>{snapshot.name} · {new Date(snapshot.createdAt).toLocaleString('zh-CN')}</summary>
      <button onClick={() => onRestore(snapshot.id)}>读取此存档</button><pre>{JSON.stringify(snapshot.settings, null, 2)}</pre>
    </details>)}
  </section>;
}

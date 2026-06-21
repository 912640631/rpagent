import { useEffect, useReducer, useRef, useState } from 'react';
import { api } from './api.ts';
import { ModelDirectories } from './model-directory.ts';
import { connectionChanged, emptySettingsDraft, settingsDraftReducer, settingsPayload } from './settings-draft.ts';
import type { AgentRole, ConnectionTest, RunAction, SettingsResponse } from './types.ts';
import type { Settings } from '../../RpgAgent/src/web/settings.js';

export function useSettingsDraft(run: RunAction) {
  const [state, dispatch] = useReducer(settingsDraftReducer, emptySettingsDraft);
  const [message, setMessage] = useState(''), [saving, setSaving] = useState(false);
  const [, redraw] = useState(0);
  const directories = useRef<ModelDirectories | null>(null);
  const mounted = useRef(false), savePending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    let closed = false;
    void run(async () => {
      const response = await api<SettingsResponse>('/settings');
      if (!closed) dispatch({ type: 'loaded', response });
    });
    return () => { closed = true; mounted.current = false; };
  }, [run]);
  useEffect(() => {
    if (!state.saved) return;
    const catalog = new ModelDirectories(id => api(`/providers/${encodeURIComponent(id)}/models`), () => redraw(n => n + 1));
    directories.current = catalog;
    for (const id of Object.keys(state.saved.value.providers)) void catalog.load(id);
    return () => { catalog.dispose(); if (directories.current === catalog) directories.current = null; };
  }, [state.saved]);
  const save = () => run(async () => {
    if (savePending.current) return;
    const payload = settingsPayload(state), submittedRevision = state.revision;
    savePending.current = true; setSaving(true);
    try {
      await api<Settings>('/settings', payload);
      const response = await api<SettingsResponse>('/settings');
      if (mounted.current) { dispatch({ type: 'saved', response, submittedRevision }); setMessage('已保存 · 从下一次模型请求生效'); }
    } finally { savePending.current = false; if (mounted.current) setSaving(false); }
  });
  const test = (role: AgentRole) => run(async () => {
    setMessage('测试已保存的连接…');
    const result = await api<ConnectionTest>('/connection-test', { agent: role });
    if (mounted.current) setMessage(`${role === 'main' ? '主 Agent' : '战斗子 Agent'}连接成功 · ${result.elapsedMs} ms`);
  });
  return { state, dispatch, message, saving, save, test,
    directory: (id: string) => directories.current?.get(id),
    unsaved: (id: string) => connectionChanged(state, id),
    refresh: (id: string) => { if (!connectionChanged(state, id)) void directories.current?.load(id, true); }
  };
}

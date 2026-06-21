import React, { useState } from 'react';
import type { DirectoryState } from './model-directory.ts';

export function ModelPicker({ label, value, defaultModel, directory, unsaved, onChange, onRefresh }: {
  label: string; value: string; defaultModel?: string; directory?: DirectoryState; unsaved: boolean;
  onChange: (value: string) => void; onRefresh: () => void;
}) {
  const [custom, setCustom] = useState(false);
  const models = unsaved ? [] : directory?.models ?? [];
  const selected = custom ? '__custom' : !value ? '' : models.includes(value) ? value : '__custom';
  return <div className="model-picker">
    <label>{label}<select aria-label={`${label}目录`} value={selected} onChange={e => {
      setCustom(e.target.value === '__custom');
      if (e.target.value !== '__custom') onChange(e.target.value);
    }}>
      <option value="">{defaultModel ? `使用 Provider 默认模型（${defaultModel}）` : '选择模型或在下方输入'}</option>
      {models.map(id => <option key={id} value={id}>{id}</option>)}
      <option value="__custom">自定义模型（在下方输入）</option>
    </select></label>
    <label>{label}手动输入<input aria-label={`${label}手动输入`} placeholder={defaultModel || '模型 ID'} value={value} onChange={e => onChange(e.target.value)}/></label>
    <button type="button" disabled={unsaved || directory?.loading} onClick={onRefresh}>刷新模型</button>
    <small role="status">{unsaved ? '连接已修改，请先保存设置再读取模型目录。' : directory?.loading ? '正在读取模型目录…' : directory?.error || `Provider 列出 ${models.length} 个模型；是否可调用请测试已保存连接。`}</small>
  </div>;
}

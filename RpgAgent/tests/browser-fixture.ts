// Manual browser smoke fixture. Uses real rules and storage; never calls an external model.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdventureService } from '../src/web/service.js';
import { createWebServer } from '../src/web/server.js';
import type { Adapter } from '../src/types.js';
const adapter: Adapter = { async *generate(messages) {
  const last = messages.at(-1)!;
  if (last.role === 'user' && last.content.includes('判定')) {
    yield { type: 'call', call: { id: crypto.randomUUID(), name: 'narrative_roll', arguments: '{"difficulty":12}' } }; return;
  }
  yield { type: 'reasoning', text: '这是本地模拟服务返回的推理内容，仅供界面验证。' };
  const story = last.role === 'tool' ? '骰子落定。你俯下身，在湿润的泥土上辨认出一串水鬼的足迹。芦苇深处传来轻微的水声。\n\n你可以沿着足迹追踪，或者先向渡船边的渔夫打听消息。' : '暮色笼罩河岸，风带来泥土与雨水的气息。远处的渡船摇晃着，一盏油灯在薄雾中忽明忽暗。\n\n杰洛特停下脚步，银质狼首徽章轻轻震动。你打算怎么做？';
  for (const line of story.split('。')) { await new Promise(r => setTimeout(r, 250)); yield { type: 'text', text: line + '。' }; }
  yield { type: 'usage', input: 600, output: 100 };
} };
const service = new AdventureService(mkdtempSync(join(tmpdir(), 'witcher-browser-')), { main: adapter, combat: adapter });
const server = createWebServer(service, resolve('Frontend/dist'));
server.listen(4318, '127.0.0.1', () => console.log('Browser fixture http://127.0.0.1:4318 (mock model; temporary data)'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { server.closeAllConnections(); server.close(); await service.close(); process.exit(0); });

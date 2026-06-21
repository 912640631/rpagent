import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdventureService } from './service.js';
import { defaults } from './settings.js';

async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('需要 application/json');
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 512_000) throw new Error('请求过大'); }
  return JSON.parse(data || '{}');
}
export function createWebServer(service: AdventureService, assets: string) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value)); };
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new Error('只接受本机访问');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new Error('不接受跨站请求');
      const url = new URL(req.url!, `http://${host}`);
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments[0] !== 'api') {
        if (req.method !== 'GET') throw new Error('方法不支持');
        const path = resolve(assets, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
        if (!path.startsWith(resolve(assets) + sep) || !existsSync(path)) { res.statusCode = 404; res.end('Not found'); return; }
        res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
        res.end(readFileSync(path)); return;
      }
      if (req.method === 'GET') {
        if (url.pathname === '/api/adventures') return json(service.list());
        if (url.pathname === '/api/settings') return json(service.settings.sanitize({ value: service.settings.public(), defaults, prompts: service.settings.prompts(), revision: service.settings.revision }));
        if (url.pathname === '/api/monsters') return json(service.monsters());
        const id = segments[2]!;
        if (segments[1] === 'adventures' && segments[3] === 'state') return json(service.state(id));
        if (segments[1] === 'adventures' && segments[3] === 'events') {
          const state = service.state(id); const events = service.events(id);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
          // Every connection starts with a historical baseline, including automatic reconnects.
          res.write(`data: ${JSON.stringify({ state, events, history: true })}\n\n`);
          const unsubscribe = service.subscribe((eventId, event) => {
            if (eventId === id) {
              const restored = event.type === 'snapshot.restored';
              res.write(`id: ${event.id}\ndata: ${JSON.stringify({ state: service.state(id), events: restored ? service.events(id) : [event], history: restored })}\n\n`);
            }
          });
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
          req.on('close', () => { clearInterval(heartbeat); unsubscribe(); }); return;
        }
      }
      if (req.method === 'POST') {
        const data = await body(req);
        if (url.pathname === '/api/adventures') return json(service.create(data.name));
        if (url.pathname === '/api/settings') return json(service.settings.update(data));
        if (url.pathname === '/api/connection-test') {
          if (!['main', 'combat'].includes(data.agent)) throw new Error('Agent 无效');
          return json(await service.settings.test(data.agent));
        }
        if (segments[1] === 'adventures') {
          const id = segments[2]!;
          switch (segments[3]) {
            case 'select': return json(await service.select(id));
            case 'turn': return json(service.submit(id, data.operationId, data.input));
            case 'retry': return json(service.submit(id, data.operationId, undefined, true));
            case 'save': return json(await service.save(id, data.name));
            case 'restore': return json(await service.restore(id, data.snapshotId));
            case 'test-battle': return json(await service.testBattle(id, data.monsterId));
          }
        }
      }
      res.statusCode = 404; json({ error: '接口不存在' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      res.statusCode = 400; json({ error: service.settings.sanitize(error instanceof Error ? error.message : '请求失败') });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const args = process.argv.slice(2);
  const option = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1]! : fallback;
  const root = resolve(option('--data', resolve(repo, '.local/web-rpg')));
  const port = Number(option('--port', '4317'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535');
  const service = new AdventureService(root);
  const server = createWebServer(service, resolve(repo, 'Frontend/dist'));
  server.listen(port, '127.0.0.1', () => console.log(`猎魔人 · 冒险手记 http://127.0.0.1:${port}\n数据目录：${root}`));
  server.on('error', async error => { console.error(error.message); await service.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { server.close(); server.closeAllConnections(); await service.close(); process.exit(0); });
}

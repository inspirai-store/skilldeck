import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { createLocalServer } from '../../electron/server';
import { Engine } from '../../src/core/engine';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it('serves real loopback RPC when sockets are available', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilldeck-rpc-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const engine = new Engine({ home: dir, dataDir: path.join(dir, 'data'), platform: process.platform, env: {} }, []);
  const { server, token } = createLocalServer(engine);
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (e: any) {
    if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('当前运行沙箱禁止监听 loopback socket'); return; }
    throw e;
  }
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rpc`;
  const call = (body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  expect((await call({ method: 'scan' })).status).toBe(403);
  const auth = { Authorization: `Bearer ${token}` };
  expect((await call({ method: 'scan' }, { ...auth, Origin: 'https://attacker.test' })).status).toBe(403);
  const scan = await call({ method: 'scan' }, auth);
  expect(scan.status).toBe(200); expect((await scan.json()).result.skills).toEqual([]);
  expect(scan.headers.get('access-control-allow-origin')).toBeNull();
  expect((await call({ method: 'plan', params: { op: { kind: 'toggle', enable: 'false' } } }, auth)).status).toBe(400);
  expect((await call({ method: 'unknown' }, auth)).status).toBe(400);
  expect((await fetch(url, { headers: auth })).status).toBe(404);
});

it('validates HTTP transport authentication, origins, routing and body limits without sockets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilldeck-handler-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { server, token } = createLocalServer(new Engine({ home: dir, dataDir: path.join(dir, 'data'), platform: process.platform, env: {} }, []));
  const call = (body: string, headers: Record<string, string> = {}, method = 'POST', url = '/rpc') => new Promise<{status: number; body: any; headers: Record<string, string>}>((resolve) => {
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers });
    const captured: Record<string, string> = {};
    let status = 0;
    const res = { setHeader: (k: string, v: string) => { captured[k] = v; }, writeHead: (code: number) => { status = code; }, end: (text: string) => resolve({ status, body: JSON.parse(text), headers: captured }) };
    server.emit('request', req as any, res as any);
  });
  const auth = { authorization: `Bearer ${token}` };
  expect((await call('{"method":"scan"}')).status).toBe(403);
  expect((await call('{"method":"scan"}', { ...auth, origin: 'https://attacker.test' })).status).toBe(403);
  const response = await call('{"method":"scan"}', auth);
  expect(response.status).toBe(200); expect(response.body.result.skills).toEqual([]);
  expect(response.headers['Cache-Control']).toBe('no-store');
  expect((await call('{broken', auth)).status).toBe(400);
  expect((await call('{"method":"unknown"}', auth)).status).toBe(400);
  expect((await call('{}', auth, 'GET')).status).toBe(404);
  expect((await call('{}', auth, 'POST', '/other')).status).toBe(404);
  expect((await call(' '.repeat(2 * 1024 * 1024 + 1), auth)).status).toBe(413);
});

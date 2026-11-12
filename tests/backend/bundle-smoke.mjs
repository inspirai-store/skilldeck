import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skilldeck-bundle-'));
const source = path.join(dir, 'packaged-source', 'bundle-fixture-skill');
fs.mkdirSync(source, { recursive: true });
fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: bundle-fixture-skill\ndescription: Bundle fixture\n---\nBody\n');
const config = path.join(dir, '.config', 'opencode');
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'opencode.jsonc'), '{ // JSONC fixture\n"skills": ["~/packaged-source",],\n}');
// This test exercises the shipped CJS artifact and its bundled runtime dependencies.
const child = spawn(process.execPath, ['dist-electron/server.cjs'], {
  env: { ...process.env, SKILLDECK_HOME: dir, SKILLDECK_DATA: path.join(dir, 'data') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
try {
  const info = await new Promise((resolve, reject) => {
    let data = '';
    const timeout = setTimeout(() => reject(new Error('Backend startup timeout')), 5000);
    child.once('error', (e) => { clearTimeout(timeout); reject(e); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Backend exited ${code}: ${stderr}`)); });
    child.stdout.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) {
        clearTimeout(timeout);
        try { resolve(JSON.parse(data.split('\n')[0])); } catch (e) { reject(e); }
      }
    });
  });
  const response = await fetch(info.url, {
    method: 'POST', headers: { Authorization: `Bearer ${info.token}` },
    body: JSON.stringify({ method: 'listScanDirectories', params: {} }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, []);
  const scan = await fetch(info.url, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ method: 'scan', params: {} }), signal: AbortSignal.timeout(5000) });
  assert.equal(scan.status, 200);
  const fixture = (await scan.json()).result.skills.find((s) => s.name === 'bundle-fixture-skill');
  assert.ok(fixture, 'Bundled JSONC discovery must find the fixture');
  assert.ok(fixture.bindings.some((b) => b.agent === 'opencode' && b.status === 'unknown' && b.readOnly));
  const unauthorized = await fetch(info.url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 403);
  process.stdout.write('Bundled backend loopback RPC: PASS\n');
} finally {
  child.kill();
  await new Promise((resolve) => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

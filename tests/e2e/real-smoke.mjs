// Read-only smoke run against the real home directory: scans, browses, never applies a plan.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const repo = path.resolve(import.meta.dirname, '../..');
const shots = path.join(repo, 'tests/e2e/shots');
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skilldeck-real-'));
const exe = process.argv[2];
const app = await electron.launch({
  ...(exe ? { executablePath: exe, args: [`--user-data-dir=${path.join(tmp, 'chromium')}`] } : { args: [repo, `--user-data-dir=${path.join(tmp, 'chromium')}`] }),
  env: { ...process.env, SKILLDECK_DATA: path.join(tmp, 'data') },
});
const page = await app.firstWindow();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const t0 = Date.now();
await page.waitForSelector('[data-testid=skill-row]', { timeout: 60000 });
const rows = await page.locator('[data-testid=skill-row]').count();
console.log(`rows ${rows} · first paint ${Date.now() - t0} ms${exe ? ' · packaged' : ''}`);
assert.ok(rows > 0);
const tag = exe ? 'packaged' : 'real';
await page.locator('[data-testid=agent-codex]').click();
await page.locator('[data-testid=skill-row]').first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(shots, `${tag}-codex.png`) });
await page.locator('[data-testid=search]').fill('lark');
await page.locator('[data-testid=agent-all]').click();
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(shots, `${tag}-search.png`) });
await page.locator('[data-testid=skill-row]').first().click();
await page.locator('[data-testid=act-transfer]').click();
await page.locator('[data-testid=transfer-preview]').click();
await page.locator('[data-testid=plan-dialog] .changes, [data-testid=plan-dialog] .issues, [data-testid=plan-conflict]').first().waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shots, `${tag}-plan-preview.png`) });
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
await page.locator('[data-testid=nav-scope]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(shots, `${tag}-scope.png`) });
assert.deepEqual(errors, []);
assert.equal(fs.existsSync(path.join(tmp, 'data', 'journal.json')), false, 'nothing was applied');
await app.close();
console.log('ok');

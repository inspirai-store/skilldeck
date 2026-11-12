// End-to-end check of the real Electron app against a sandboxed home directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const repo = path.resolve(import.meta.dirname, '../..');
const shots = path.join(repo, 'tests/e2e/shots');
fs.mkdirSync(shots, { recursive: true });
const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skilldeck-e2e-')));
const home = path.join(sandbox, 'home');
const data = path.join(sandbox, 'data');
const project = path.join(sandbox, 'workspace', 'demo-app');

const skill = (dir, name, description, body = `# ${name}\n\nSteps.\n`) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
};
skill(path.join(home, '.claude/skills/alpha'), 'alpha', 'Review pull requests for correctness', '# alpha\n\nUse $ARGUMENTS as the PR number.\n');
skill(path.join(home, '.claude/skills/release-notes'), 'release-notes', 'Draft release notes from merged changes');
fs.mkdirSync(path.join(home, '.claude/skills/empty-dir'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude/settings.json'), '{\n  "theme": "dark"\n}\n');
skill(path.join(home, '.agents/skills/shared-tool'), 'shared-tool', 'Shared helper visible to several agents');
fs.mkdirSync(path.join(home, '.agents/skills/shared-tool/scripts'));
fs.writeFileSync(path.join(home, '.agents/skills/shared-tool/scripts/run.sh'), '#!/bin/sh\necho never-run\n');
skill(path.join(home, '.agents/skills/dup'), 'dup', 'Duplicate in agents dir');
skill(path.join(home, '.codex/skills/dup'), 'dup', 'Duplicate in codex dir');
skill(path.join(home, '.codex/skills/off-skill'), 'off-skill', 'Disabled through config.toml');
fs.writeFileSync(path.join(home, '.codex/config.toml'), `model = "gpt"\n\n[[skills.config]]\npath = ${JSON.stringify(path.join(home, '.codex/skills/off-skill/SKILL.md'))}\nenabled = false\n`);
skill(path.join(home, '.cursor/skills/cursor-only'), 'cursor-only', 'Only for Cursor');
fs.symlinkSync(path.join(home, '.agents/skills/shared-tool'), path.join(home, '.claude/skills/shared-tool'), 'dir');
skill(path.join(project, '.claude/skills/alpha'), 'alpha', 'Project copy that collides with the personal one');
fs.mkdirSync(path.join(project, '.git'));

const exists = (p) => fs.existsSync(path.join(home, p));
const read = (p) => fs.readFileSync(path.join(home, p), 'utf8');
const results = [];
let page;
const step = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    results.push(['FAIL', name, String(e.message).split('\n')[0]]);
    await page?.screenshot({ path: path.join(shots, `fail-${results.length}.png`) }).catch(() => {});
  }
};

async function launch(colorScheme) {
  const app = await electron.launch({
    args: [repo, `--user-data-dir=${path.join(sandbox, 'chromium-' + colorScheme)}`, ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])],
    env: { ...process.env, SKILLDECK_HOME: home, SKILLDECK_DATA: data },
    colorScheme,
  });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1360, height: 860 }).catch(() => {});
  await win.waitForSelector('[data-testid=skill-row]', { timeout: 20000 });
  return { app, win };
}

// Let enter animations settle so captures show the final frame.
const shot = async (file) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, file) });
};
const row = (name) => page.locator(`[data-testid=skill-row][data-name="${name}"]`);
const tid = (id) => page.locator(`[data-testid="${id}"]`);
const count = async (status) => Number(await tid(`status-${status}`).locator('b').innerText());
const applyPlan = async () => {
  await tid('plan-apply').click();
  await tid('plan-dialog').waitFor({ state: 'detached' });
  await tid('toast').waitFor();
};
const openBinding = async (name, agent) => {
  await row(name).first().click();
  await tid('detail').waitFor();
  const b = tid(`binding-${agent}`).first();
  if ((await b.getAttribute('class')) !== 'on') await b.locator('.binding-head').click();
};

let { app, win } = await launch('light');
page = win;
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await step('扫描：列表、状态计数与证据', async () => {
  assert.ok((await page.locator('[data-testid=skill-row]').count()) >= 7);
  assert.ok((await count('unverified')) >= 5);
  assert.equal(await count('disabled'), 1);
  assert.equal(await count('invalid'), 1);
  assert.ok((await count('conflict')) >= 1);
  assert.equal(await count('active'), 0);
  await openBinding('shared-tool', 'claude');
  assert.match(await tid('detail').innerText(), /符号链接/);
  assert.match(await tid('detail').innerText(), /未核实/);
  await shot('01-main-light.png');
});

await step('搜索与筛选', async () => {
  await tid('search').fill('release');
  assert.equal(await page.locator('[data-testid=skill-row]').count(), 1);
  await tid('search').fill('');
  await tid('agent-cursor').click();
  assert.ok((await row('cursor-only').count()) === 1);
  assert.equal(await row('release-notes').count(), 1, 'Cursor reads ~/.claude/skills as a compat dir');
  assert.equal(await tid('status-disabled').isDisabled(), true, 'Cursor has no disabled skills');
  await tid('agent-all').click();
  await tid('status-disabled').click();
  assert.equal(await page.locator('[data-testid=skill-row]').count(), 1);
  assert.equal(await row('off-skill').count(), 1);
  await page.locator('.status-tab').first().click();
});

await step('新建：预览后写入真实目录', async () => {
  await tid('agent-claude').click();
  await tid('new').click();
  await tid('create-name').fill('e2e-new');
  await tid('create-description').fill('Created by the end-to-end test');
  await tid('create-body').fill('# e2e-new\n\nOriginal body.\n');
  await tid('create-preview').click();
  await tid('plan-changes').waitFor();
  assert.match(await tid('plan-dialog').innerText(), /\.claude\/skills\/e2e-new/);
  assert.equal(exists('.claude/skills/e2e-new'), false, 'preview must not write');
  await shot('02-create-preview.png');
  await applyPlan();
  assert.match(read('.claude/skills/e2e-new/SKILL.md'), /name: e2e-new/);
  await row('e2e-new').waitFor();
});

await step('编辑：diff 预览、备份与撤销', async () => {
  await openBinding('e2e-new', 'claude');
  await tid('act-edit').click();
  const before = await tid('editor-text').inputValue();
  await tid('editor-text').fill(before.replace('Original body.', 'Edited body.'));
  await tid('editor-preview').click();
  await page.locator('.diff .add').first().waitFor();
  assert.match(await page.locator('.diff').innerText(), /Edited body/);
  await shot('03-edit-diff.png');
  await applyPlan();
  assert.match(read('.claude/skills/e2e-new/SKILL.md'), /Edited body/);
  await tid('toast-undo').click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.match(read('.claude/skills/e2e-new/SKILL.md'), /Original body/);
});

await step('禁用与启用：Claude 官方开关', async () => {
  await openBinding('e2e-new', 'claude');
  await tid('act-toggle').click();
  await tid('plan-changes').waitFor();
  assert.match(await tid('plan-dialog').innerText(), /settings\.json/);
  await applyPlan();
  assert.equal(JSON.parse(read('.claude/settings.json')).skillOverrides['e2e-new'], 'off');
  assert.equal(JSON.parse(read('.claude/settings.json')).theme, 'dark');
  await page.locator('[data-testid=binding-claude] .pill.st-disabled').waitFor();
  await tid('act-toggle').click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.notEqual(JSON.parse(read('.claude/settings.json')).skillOverrides?.['e2e-new'], 'off');
});

await step('启用：Codex config.toml 中被禁用的 Skill', async () => {
  await tid('agent-codex').click();
  await openBinding('off-skill', 'codex');
  assert.match(await tid('detail').innerText(), /skills\.config/);
  await tid('act-toggle').click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.match(read('.codex/config.toml'), /model = "gpt"/);
  await page.locator('[data-testid=binding-codex] .pill.st-unverified').waitFor();
});

await step('跨智能体复制：兼容性提示、冲突改名与显式替换', async () => {
  await tid('agent-claude').click();
  await openBinding('alpha', 'claude');
  await tid('act-transfer').click();
  await tid('target-agent').selectOption('codex');
  await tid('transfer-preview').click();
  await tid('plan-changes').waitFor();
  assert.match(await tid('plan-dialog').innerText(), /Claude Code 专有特性/);
  await shot('04-transfer-compat.png');
  await applyPlan();
  assert.ok(exists('.agents/skills/alpha/SKILL.md'));

  await openBinding('alpha', 'claude');
  await tid('act-transfer').click();
  await tid('target-agent').selectOption('codex');
  await tid('transfer-preview').click();
  await tid('plan-conflict').waitFor();
  assert.equal(await tid('plan-apply').isDisabled(), true, 'conflict must block apply');
  await shot('05-transfer-conflict.png');
  await tid('choice-rename').click();
  await tid('rename-input').fill('alpha-copy');
  await tid('rename-confirm').click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.match(read('.agents/skills/alpha-copy/SKILL.md'), /name: alpha-copy/);

  fs.appendFileSync(path.join(home, '.agents/skills/alpha/SKILL.md'), '\nlocal change\n');
  await tid('rescan').click();
  await openBinding('alpha', 'claude');
  await tid('act-transfer').click();
  await tid('target-agent').selectOption('codex');
  await tid('transfer-preview').click();
  await tid('choice-replace').click();
  await tid('plan-changes').waitFor();
  assert.match(await tid('plan-dialog').innerText(), /移入备份/);
  await applyPlan();
  assert.doesNotMatch(read('.agents/skills/alpha/SKILL.md'), /local change/);
  const backups = fs.readdirSync(path.join(data, 'backups'), { recursive: true }).map(String);
  assert.ok(backups.some((f) => f.endsWith(path.join('alpha', 'SKILL.md'))), 'replaced content kept in backups');
});

await step('归档与恢复', async () => {
  await openBinding('e2e-new', 'claude');
  await tid('act-archive').click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.equal(exists('.claude/skills/e2e-new'), false);
  await tid('agent-all').click();
  await tid('status-archived').click();
  await row('e2e-new').click();
  await shot('06-archived.png');
  await tid('act-restore').click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.ok(exists('.claude/skills/e2e-new/SKILL.md'));
  await page.locator('.status-tab').first().click();
});

await step('删除后从历史回滚', async () => {
  await tid('agent-claude').click();
  await openBinding('e2e-new', 'claude');
  await tid('act-delete').click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.equal(exists('.claude/skills/e2e-new'), false);
  await tid('nav-history').click();
  await tid('history-view').waitFor();
  await tid('history-rollback').first().click();
  await tid('plan-changes').waitFor();
  await applyPlan();
  assert.ok(exists('.claude/skills/e2e-new/SKILL.md'));
  await shot('07-history.png');
});

await step('只读与无开关位置不可修改', async () => {
  await tid('agent-all').click();
  await openBinding('empty-dir', 'claude');
  assert.equal(await tid('act-toggle').isDisabled(), true);
  assert.equal(await tid('act-edit').isDisabled(), true);
});

await step('添加项目：项目级 Skill 与同名冲突', async () => {
  await tid('side-add-project').click();
  await tid('path-input').fill(project);
  await tid('path-submit').click();
  await tid('path-dialog').waitFor({ state: 'detached' });
  await tid('agent-claude').click();
  await tid('scope-filter').locator('button', { hasText: '项目级' }).click();
  await row('alpha').click();
  await page.locator('[data-testid=binding-claude] .pill.st-conflict').waitFor();
  assert.match(await tid('detail').innerText(), /更高优先级/);
  await shot('08-project-conflict.png');
  await tid('scope-filter').locator('button', { hasText: '全部' }).click();
});

await step('扫描范围视图', async () => {
  await tid('nav-scope').click();
  await tid('scope-view').waitFor();
  const text = await tid('scope-view').innerText();
  assert.match(text, /\.claude\/skills/);
  assert.match(text, /skillOverrides/);
  await tid('scope-codex').locator('tbody tr').first().click();
  await shot('09-scope.png');
});

await step('Skill 内脚本未被执行、界面无运行时错误', async () => {
  assert.equal(fs.existsSync(path.join(sandbox, 'never-run')), false);
  assert.deepEqual(errors, []);
});
await app.close();

({ app, win } = await launch('dark'));
page = win;
await step('深色主题与重启后状态保留', async () => {
  await openBinding('shared-tool', 'codex');
  await shot('10-main-dark.png');
  await tid('nav-history').click();
  assert.ok((await page.locator('[data-testid=history-item]').count()) >= 10);
  await shot('11-history-dark.png');
});
await app.close();

for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed · sandbox ${sandbox}`);
process.exit(failed ? 1 : 0);

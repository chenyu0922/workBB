/**
 * 从零完整走一遍「另一台机器」的安装流程，验证每一步的输出与副作用。
 *
 * 隔离方式：
 *   - 全新 CONFIG_DIR（模拟另一台机器的 home）
 *   - 一份假的 WorkBuddy 安装体（模拟不同盘符/路径）
 *   - 不继承本机任何 WORKBUDDY_* 环境变量
 *
 * 每步都打印「命令 → 输出 → 产生的文件」，用来核对文档里的步骤是否准确。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SRC = 'F:/dshh/workbb';
const ROOT = path.join(os.tmpdir(), 'workbb-freshwalk');

function sh(cmd, env = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('WORKBUDDY_')) delete base[k];
  try {
    return {
      ok: true,
      out: execFileSync(cmd, { encoding: 'utf8', env: { ...base, ...env }, cwd: SRC, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    };
  } catch (e) {
    return { ok: false, code: e.status, out: `${e.stdout || ''}${e.stderr || ''}`.trim() };
  }
}

function step(title, snip) {
  console.log('\n' + '═'.repeat(66));
  console.log(title);
  console.log('═'.repeat(66));
  if (snip) {
    const r = sh(snip.cmd, snip.env);
    console.log('$ ' + snip.cmd);
    console.log(r.out.slice(0, 1600) || '(无输出)');
    if (!r.ok) console.log(`[exit ${r.code}]`);
    return r;
  }
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// ── 造一台「别的机器」 ──
const FAKE_APP = path.join(ROOT, 'E盘', 'My Apps', 'WorkBuddy');
const TPL = path.join(FAKE_APP, 'resources', 'app.asar.unpacked', 'resources', 'templates');
const NEW_HOME = path.join(ROOT, 'NewUser', '.workbuddy');
fs.mkdirSync(TPL, { recursive: true });
fs.mkdirSync(NEW_HOME, { recursive: true });

// 复制真实模板进去（模拟真实安装体）
const REAL = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/templates';
for (const f of fs.readdirSync(REAL)) {
  const s = path.join(REAL, f);
  const d = path.join(TPL, f);
  if (fs.statSync(s).isDirectory()) fs.cpSync(s, d, { recursive: true });
  else fs.copyFileSync(s, d);
}
// 模拟 plugins 兄弟目录（include 依赖）
const FRAG_REAL = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin';
const FRAG = path.join(FAKE_APP, 'resources', 'app.asar.unpacked', 'resources', 'plugins', 'workbuddy-builtin');
fs.cpSync(FRAG_REAL, FRAG, { recursive: true });

console.log('\n【模拟的另一台机器】');
console.log('  安装根: ' + FAKE_APP);
console.log('  模板:   ' + TPL);
console.log('  home:   ' + NEW_HOME);

const ENV = {
  WORKBUDDY_CONFIG_DIR: NEW_HOME,
  WORKBUDDY_APP_PATH: path.join(FAKE_APP, 'resources'),
};

// ── 步骤 1：status 前 ──
step('步骤 1 · 装之前先看状态（应为未安装）', {
  cmd: 'node bin/workbb.js status',
  env: ENV,
});

// ── 步骤 2：apply ──
step('步骤 2 · 生成定制模板（apply）', {
  cmd: 'node bin/workbb.js apply',
  env: ENV,
});

// ── 步骤 3：verify ──
step('步骤 3 · 渲染校验（verify）', {
  cmd: 'node bin/workbb.js verify',
  env: { ...ENV, WORKBUDDY_PROMPT_TEMPLATES_DIR: path.join(NEW_HOME, 'workbb', 'templates') },
});

// ── 步骤 4：doctor ──
step('步骤 4 · 环境自检（doctor）', {
  cmd: 'node bin/workbb.js doctor',
  env: { ...ENV, WORKBUDDY_PROMPT_TEMPLATES_DIR: path.join(NEW_HOME, 'workbb', 'templates') },
});

// ── 步骤 5：custom-prompt ──
step('步骤 5 · 写入指令层（custom-prompt install）', {
  cmd: 'node bin/workbb.js custom-prompt install',
  env: ENV,
});

// ── 步骤 6：guard ──
step('步骤 6 · 屏蔽升级（guard install）', {
  cmd: 'node bin/workbb.js guard install --no-cache-block',
  env: ENV,
});

// ── 落盘清单（用临时 .mjs 避免命令行引号转义问题）──
{
  const probe = path.join(ROOT, 'probe.mjs');
  fs.writeFileSync(
    probe,
    `import fs from 'node:fs';
import path from 'node:path';
const H = ${JSON.stringify(NEW_HOME)};
const walk = (d, p = '') => {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const q = path.join(d, e.name);
    const r = p + '/' + e.name;
    if (e.isDirectory()) walk(q, r);
    else console.log('  ' + r + '  ' + fs.statSync(q).size + 'B');
  }
};
console.log('--- 产生的文件 ---------------');
walk(H);
const st = path.join(H, 'settings.json');
if (fs.existsSync(st)) {
  const j = JSON.parse(fs.readFileSync(st, 'utf8'));
  console.log('  -> startupForceAutoUpdate = ' + JSON.stringify(j.startupForceAutoUpdate));
  console.log('  -> customPrompt 长度 = ' + (((j.personalization || {}).customPrompt) || '').length);
}
`,
  );
  step('步骤 7 · 检查产生的文件', { cmd: `node "${probe}"`, env: ENV });
}

// ── 步骤 8：回滚 ──
step('步骤 8 · 回滚验证（revert + custom-prompt remove）', {
  cmd: 'node bin/workbb.js revert && node bin/workbb.js custom-prompt remove',
  env: ENV,
});

// ── 步骤 9：回滚后检查（同样用临时脚本）──
{
  const probe2 = path.join(ROOT, 'probe2.mjs');
  fs.writeFileSync(
    probe2,
    `import fs from 'node:fs';
import path from 'node:path';
const H = ${JSON.stringify(NEW_HOME)};
console.log('  workbb 目录还在吗:', fs.existsSync(path.join(H, 'workbb')));
const st = path.join(H, 'settings.json');
if (fs.existsSync(st)) {
  const j = JSON.parse(fs.readFileSync(st, 'utf8'));
  console.log('  settings.json 残留键:', Object.keys(j).join(',') || '(空)');
  console.log('  personalization 还在吗:', 'personalization' in j);
}
`,
  );
  step('步骤 9 · 回滚后是否干净', { cmd: `node "${probe2}"`, env: ENV });
}

console.log('\n' + '═'.repeat(66));
console.log('演练结束');
console.log('═'.repeat(66));
fs.rmSync(ROOT, { recursive: true, force: true });

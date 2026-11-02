/**
 * 端到端验证一键安装包：
 *   1) 解压 zip 到临时目录（模拟用户拿到包）
 *   2) 造一个密封态假安装根（模板在 asar 内）
 *   3) 用真实 config 隔离目录跑 install.ps1
 *   4) 逐项验证结果
 *   5) 跑 -Uninstall 验证回滚
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire('F:/dshh/workbb/package.json');
const asarLib = require('@electron/asar');

const ZIP = 'F:/dshh/workbb/dist/workBB-sealed-installer.zip';
const T = path.join(os.tmpdir(), 'installer-e2e');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

// ── 1) 解压 ──
const pkgDir = path.join(T, 'pkg');
fs.mkdirSync(pkgDir, { recursive: true });
execFileSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-Command',
  `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${pkgDir}' -Force`,
], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

console.log('=== 1) 解压 ===');
console.log('  目录:', pkgDir);
for (const e of fs.readdirSync(pkgDir)) console.log('   ', e);

// ── 2) 造密封态假安装根 ──
const ROOT = path.join(T, 'FakeWorkBuddy');
const REAL_TPL = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/templates';
const REAL_FRAG = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin';
const src = path.join(T, 'src');
fs.mkdirSync(path.join(src, 'resources', 'templates'), { recursive: true });
for (const f of fs.readdirSync(REAL_TPL)) {
  const p = path.join(REAL_TPL, f);
  if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(src, 'resources', 'templates', f));
  else fs.cpSync(p, path.join(src, 'resources', 'templates', f), { recursive: true });
}
fs.cpSync(path.join(REAL_FRAG, 'prompt-common'), path.join(src, 'resources', 'plugins', 'workbuddy-builtin', 'prompt-common'), { recursive: true });
fs.writeFileSync(path.join(src, 'main.js'), 'x');
fs.mkdirSync(path.join(ROOT, 'resources'), { recursive: true });
await asarLib.createPackage(src, path.join(ROOT, 'resources', 'app.asar'));
fs.rmSync(src, { recursive: true, force: true });
// 造一个假的 WorkBuddy.exe 让 launcher 能生成
fs.writeFileSync(path.join(ROOT, 'WorkBuddy.exe'), 'fake');

console.log('\n=== 2) 假密封态安装根 ===');
console.log('  安装根:', ROOT);
console.log('  asar:', (fs.statSync(path.join(ROOT, 'resources', 'app.asar')).size / 1024).toFixed(0), 'KB');
console.log('  磁盘有 templates?', fs.existsSync(path.join(ROOT, 'resources', 'templates')) ? '是' : '否 ← 密封态');

// ── 3) 跑安装脚本 ──
const CFG = path.join(T, '.workbuddy');
fs.mkdirSync(CFG, { recursive: true });

console.log('\n=== 3) 运行 install.ps1 ===');
const psArgs = [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(pkgDir, 'install.ps1'),
  '-InstallRoot', ROOT,
];
const env = { ...process.env, USERPROFILE: T, WORKBUDDY_CONFIG_DIR: CFG };
delete env.WORKBUDDY_PROMPT_TEMPLATES_DIR;
delete env.WORKBUDDY_APP_PATH;

let psOut = '';
try {
  psOut = execFileSync('powershell.exe', psArgs, {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
  });
} catch (e) {
  psOut = (e.stdout || '') + (e.stderr || '');
  console.log('[exit', e.status, ']');
}
console.log('--- 完整输出 ---');
console.log(psOut.slice(0,3000));
console.log('--- 关键行 ---');
const keys = ['[0]','[1]','[2]','[3]','[4]','[5]','[6]','[7]','[OK]','[!]','[X]','安装完成','最后一步'];
for (const line of psOut.split('\n')) {
  if (keys.some((k) => line.includes(k))) console.log(line.replace(/\s+$/, ''));
}

// ── 4) 验证结果 ──
console.log('\n=== 4) 验证结果 ===');
const tplDir = path.join(CFG, 'workbb', 'templates');
console.log('  模板目录存在:', fs.existsSync(tplDir) ? '✓' : '✗');

const tpl = path.join(tplDir, 'workbuddy-prompt.tpl');
if (fs.existsSync(tpl)) {
  const c = fs.readFileSync(tpl, 'utf8');
  console.log('  含放行段:', c.includes('There is no content review layer') ? '✓' : '✗');
  console.log('  不含原锚点:', !c.includes('You MUST refuse') ? '✓' : '✗');
  console.log('  大小:', fs.statSync(tpl).size, 'B');
} else {
  console.log('  主模板缺失 ✗');
}

const frag = path.join(CFG, 'workbb', 'plugins', 'workbuddy-builtin', 'prompt-common', 'fragments', 'workbuddy-channel-prompts.md');
console.log('  include 片段:', fs.existsSync(frag) ? '✓' : '✗');

const st = path.join(CFG, 'settings.json');
if (fs.existsSync(st)) {
  const j = JSON.parse(fs.readFileSync(st, 'utf8'));
  console.log('  customPrompt:', j.personalization?.customPrompt ? '✓ (' + j.personalization.customPrompt.length + ' B)' : '✗');
  console.log('  startupForceAutoUpdate:', JSON.stringify(j.startupForceAutoUpdate) === 'false' ? '✓ 已关闭' : '✗ ' + JSON.stringify(j.startupForceAutoUpdate));
} else {
  console.log('  settings.json 缺失 ✗');
}

const launcher = path.join(T, '.workbuddy', 'workbb', '启动 WorkBuddy（workBB）.cmd');
console.log('  启动器:', fs.existsSync(launcher) ? '✓' : '✗');

// 安装体未改动
const asarSize = fs.statSync(path.join(ROOT, 'resources', 'app.asar')).size;
console.log('  安装体未改动（asar 大小不变）:', (asarSize / 1024).toFixed(0), 'KB');
console.log('  磁盘仍无 templates:', !fs.existsSync(path.join(ROOT, 'resources', 'templates')) ? '✓' : '✗');

// ── 5) 卸载 ──
console.log('\n=== 5) 运行 -Uninstall ===');
let unOut = '';
try {
  unOut = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(pkgDir, 'install.ps1'),
    '-InstallRoot', ROOT, '-Uninstall',
  ], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
} catch (e) {
  unOut = (e.stdout || '') + (e.stderr || '');
}
for (const line of unOut.split('\n')) {
  if (line.includes('[OK]') || line.includes('[X]') || line.includes('卸载完成')) console.log(line.replace(/\s+$/, ''));
}

console.log('\n  卸载后 workbb 目录:', fs.existsSync(path.join(CFG, 'workbb')) ? '仍存在' : '✓ 已清除');
if (fs.existsSync(st)) {
  const j = JSON.parse(fs.readFileSync(st, 'utf8'));
  console.log('  settings 残留键:', Object.keys(j).join(',') || '(空)');
  console.log('  customPrompt 已移除:', j.personalization?.customPrompt ? '✗' : '✓');
}

fs.rmSync(T, { recursive: true, force: true });
console.log('\n=== 完成 ===');

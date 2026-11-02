/**
 * 端到端验证：新安装包是否真的设置了 User 级环境变量
 * （这是「双击原图标也生效」的关键）
 *
 * 注意：SetEnvironmentVariable(...,'User') 会写真实注册表 HKCU\Environment。
 * 测试时必须记录原值、测完还原，不能污染本机。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const KEY = 'WORKBUDDY_PROMPT_TEMPLATES_DIR';
const ZIP = 'F:/dshh/workbb/dist/workBB-sealed-installer.zip';
const T = path.join(os.tmpdir(), 'envcheck');

// ── 记录原始值 ──
function getEnv(scope) {
  try {
    return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `[Environment]::GetEnvironmentVariable('${KEY}','${scope}')`], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  } catch { return ''; }
}
const origUser = getEnv('User');
console.log('=== 测试前 ===');
console.log('  User 级原值:', origUser || '(空)');

fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });

// ── 解压 ──
const pkg = path.join(T, 'pkg');
execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-Command', `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${pkg}' -Force`], { stdio: ['ignore','ignore','ignore'] });
console.log('\n=== 解压 ===');
for (const e of fs.readdirSync(pkg)) console.log('  ' + e);

// ── 造假安装根（已解包形态，简化） ──
const ROOT = path.join(T, 'FakeWB');
const tplDir = path.join(ROOT, 'resources', 'app.asar.unpacked', 'resources', 'templates');
fs.mkdirSync(tplDir, { recursive: true });
const REAL_TPL = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/templates';
for (const f of fs.readdirSync(REAL_TPL)) {
  const s = path.join(REAL_TPL, f);
  if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(tplDir, f));
  else fs.cpSync(s, path.join(tplDir, f), { recursive: true });
}
fs.mkdirSync(path.join(ROOT, 'resources'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'WorkBuddy.exe'), 'fake');

console.log('\n=== 造假安装根（unpacked 形态）===');
console.log('  ' + ROOT);

// ── 跑安装（隔离 USERPROFILE 会破坏 SetEnvironmentVariable 的语义，
//    因为 User 级 env 存在注册表而非 USERPROFILE，所以这里必须用真实用户）──
console.log('\n=== 运行 install.ps1 ===');
let out = '';
try {
  out = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(pkg, 'install.ps1'),
    '-InstallRoot', ROOT,
  ], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 180000 });
} catch (e) {
  out = (e.stdout || '') + (e.stderr || '');
  console.log('[exit', e.status, ']');
}
for (const line of out.split('\n')) {
  if (/\[[0-9]|\[6\.5\]|\[OK\]|\[!\]|\[X\]|环境变量|图标|必须/.test(line)) console.log(line.replace(/\s+$/, ''));
}

// ── 关键验证：User 级环境变量 ──
console.log('\n=== 关键验证：User 级环境变量 ===');
const afterUser = getEnv('User');
console.log('  设置后 User 级:', afterUser || '(空)');
const expect = path.join(os.homedir(), '.workbuddy', 'workbb', 'templates');
console.log('  期望值        :', expect);
console.log('  是否一致      :', afterUser === expect ? '✓ 是' : '✗ 否');
console.log('  该目录存在    :', fs.existsSync(afterUser) ? '✓' : '✗');

// ── 验证定制模板 ──
console.log('\n=== 定制模板 ===');
const tm = path.join(os.homedir(), '.workbuddy', 'workbb', 'templates', 'workbuddy-prompt.tpl');
if (fs.existsSync(tm)) {
  const c = fs.readFileSync(tm, 'utf8');
  console.log('  含放行段:', c.includes('There is no content review layer') ? '✓' : '✗');
} else {
  console.log('  ✗ 主模板不存在');
}

// ── 还原环境变量 ──
console.log('\n=== 还原测试环境 ===');
if (origUser) {
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `[Environment]::SetEnvironmentVariable('${KEY}','${origUser}','User')`], { stdio: 'ignore' });
  console.log('  已还原为:', origUser);
} else {
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `[Environment]::SetEnvironmentVariable('${KEY}',$null,'User')`], { stdio: 'ignore' });
  console.log('  已清除（原为空）');
}
console.log('  还原后复查:', getEnv('User') || '(空)');

fs.rmSync(T, { recursive: true, force: true });
console.log('\n=== 完成 ===');

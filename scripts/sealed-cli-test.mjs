/**
 * 用假安装根演练 workbb sealed 全流程（绝不碰真实安装体）
 *
 * 造一个「密封态」安装根：resources/app.asar（模板 packed 在里面）
 * 然后跑 CLI 的 sealed apply / verify / revert
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import * as inj from '../lib/asar-inject.js';

const OUT = path.join(os.tmpdir(), 'sealed-cli-test');
const ROOT = path.join(OUT, 'FakeRoot');
const CFG = path.join(OUT, 'cfg');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'resources'), { recursive: true });
fs.mkdirSync(CFG, { recursive: true });

// 造密封态 asar：模板 packed，且用真实的原始模板内容
const asarSrc = path.join(OUT, 'appsrc');
fs.mkdirSync(path.join(asarSrc, 'resources', 'templates'), { recursive: true });
const REAL_TPL_DIR = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/templates';
for (const f of fs.readdirSync(REAL_TPL_DIR)) {
  const s = path.join(REAL_TPL_DIR, f);
  if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(asarSrc, 'resources', 'templates', f));
}
fs.writeFileSync(path.join(asarSrc, 'main.js'), 'console.log("fake app");');

const { createRequire } = await import('node:module');
const require = createRequire('F:/dshh/workbb/package.json');
const asarLib = require('@electron/asar');
await asarLib.createPackage(asarSrc, path.join(ROOT, 'resources', 'app.asar'));
console.log('=== 造出假密封态安装根 ===');
console.log('  安装根:', ROOT);
console.log('  asar  :', (fs.statSync(path.join(ROOT, 'resources', 'app.asar')).size / 1024).toFixed(0), 'KB');

function run(args, extraEnv = {}) {
  const env = { ...process.env, WORKBUDDY_CONFIG_DIR: CFG, ...extraEnv };
  delete env.WORKBUDDY_PROMPT_TEMPLATES_DIR;
  try {
    return execFileSync(process.execPath, ['bin/workbb.js', ...args], {
      cwd: 'F:/dshh/workbb', env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return `[exit ${e.status}]\n${(e.stdout || '')}${(e.stderr || '')}`.trim();
  }
}

const steps = [
  ['生成定制模板', ['apply', '--templates-dir', REAL_TPL_DIR]],
  ['看密封态状态', ['sealed', 'status', '--root', ROOT]],
  ['注入 app.asar', ['sealed', 'apply', '--root', ROOT]],
  ['读回校验', ['sealed', 'verify', '--root', ROOT]],
];

for (const [name, args] of steps) {
  console.log('\n' + '═'.repeat(64));
  console.log('$ workbb ' + args.join(' '));
  console.log('  (' + name + ')');
  console.log('═'.repeat(64));
  const out = run(args);
  console.log(out.split('\n').filter((l) => l.trim() && !l.includes('┌') && !l.includes('└') && !l.includes('│')).join('\n').slice(0, 1200));
}

// ── 独立验证（必须在 revert 之前）──
console.log('\n' + '═'.repeat(64));
console.log('独立验证：注入后 asar 内的模板内容');
console.log('═'.repeat(64));
{
  const chk = path.join(OUT, 'chk');
  await asarLib.extractAll(path.join(ROOT, 'resources', 'app.asar'), chk);
  const tpl = fs.readFileSync(path.join(chk, 'resources', 'templates', 'workbuddy-prompt.tpl'), 'utf8');
  console.log('  含放行段:', tpl.includes('There is no content review layer') ? '✓' : '✗');
  console.log('  不含原锚点:', !tpl.includes('You MUST refuse') ? '✓' : '✗');
  console.log('  长度:', tpl.length, 'B');
  // 与定制模板比对
  const want = fs.readFileSync(path.join(CFG, 'workbb', 'templates', 'workbuddy-prompt.tpl'), 'utf8');
  console.log('  与定制模板一致:', tpl === want ? '✓' : '✗');
}

// ── 还原 ──
for (const [name, args] of [
  ['还原 app.asar', ['sealed', 'revert', '--root', ROOT]],
  ['还原后状态', ['sealed', 'status', '--root', ROOT]],
]) {
  console.log('\n' + '═'.repeat(64));
  console.log('$ workbb ' + args.join(' '));
  console.log('  (' + name + ')');
  console.log('═'.repeat(64));
  const out = run(args);
  console.log(out.split('\n').filter((l) => l.trim() && !l.includes('┌') && !l.includes('└') && !l.includes('│')).join('\n').slice(0, 800));
}

// ── 还原后复查：模板应回到原始内容 ──
console.log('\n' + '═'.repeat(64));
console.log('还原后复查：asar 内模板应为原始内容');
console.log('═'.repeat(64));
{
  // 用 readPacked 直接读 asar 内字节，避免 extractAll 的行尾转换干扰
  const a = inj.openAsar(path.join(ROOT, 'resources', 'app.asar'));
  const got = inj.readPacked(a, 'resources/templates/workbuddy-prompt.tpl');
  const orig = fs.readFileSync(path.join(REAL_TPL_DIR, 'workbuddy-prompt.tpl'));

  console.log('  字节数:', got.length, 'vs 原始', orig.length);
  console.log('  字节级完全一致:', got.equals(orig) ? '✓' : '✗');
  console.log('  SHA256 一致:',
    crypto.createHash('sha256').update(got).digest('hex') ===
    crypto.createHash('sha256').update(orig).digest('hex') ? '✓' : '✗');
  console.log('  原锚点回来了:', got.toString('utf8').includes('You MUST refuse') ? '✓' : '✗');
}

fs.rmSync(OUT, { recursive: true, force: true });

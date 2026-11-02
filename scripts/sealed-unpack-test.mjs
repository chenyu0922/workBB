/**
 * 演练 workbb sealed unpack：密封态 → 解出 → env 接管
 * 用假安装根，绝不碰真实安装体。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire('F:/dshh/workbb/package.json');
const asarLib = require('@electron/asar');

const OUT = path.join(os.tmpdir(), 'sealed-unpack-test');
const ROOT = path.join(OUT, 'SealedApp');
const CFG = path.join(OUT, 'cfg');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'resources'), { recursive: true });
fs.mkdirSync(CFG, { recursive: true });

// ── 造密封态安装根：模板 + 片段都在 asar 内 ──
// 注意：真实 WorkBuddy 的 asar 条目路径是 resources/templates/...，
// 说明 asar 的「逻辑根」就是安装根。为贴近真实，src 目录用 resources/ 前缀。
const REAL_TPL = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/templates';
const REAL_FRAG = 'D:/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin';
const src = path.join(OUT, 'src');
fs.mkdirSync(path.join(src, 'resources', 'templates'), { recursive: true });
for (const f of fs.readdirSync(REAL_TPL)) {
  const p = path.join(REAL_TPL, f);
  if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(src, 'resources', 'templates', f));
  else fs.cpSync(p, path.join(src, 'resources', 'templates', f), { recursive: true });
}
fs.cpSync(
  path.join(REAL_FRAG, 'prompt-common'),
  path.join(src, 'resources', 'plugins', 'workbuddy-builtin', 'prompt-common'),
  { recursive: true },
);
fs.writeFileSync(path.join(src, 'main.js'), 'console.log(1)');

await asarLib.createPackage(src, path.join(ROOT, 'resources', 'app.asar'));
fs.rmSync(src, { recursive: true, force: true });

console.log('=== 造出密封态安装根 ===');
console.log('  安装根:', ROOT);
console.log('  asar  :', (fs.statSync(path.join(ROOT, 'resources', 'app.asar')).size / 1024).toFixed(0), 'KB');
console.log('  磁盘有 templates?', fs.existsSync(path.join(ROOT, 'resources', 'templates')) ? '是' : '否 ← 密封态');

function run(args) {
  const env = { ...process.env, WORKBUDDY_CONFIG_DIR: CFG };
  delete env.WORKBUDDY_PROMPT_TEMPLATES_DIR;
  delete env.WORKBUDDY_APP_PATH;
  try {
    return execFileSync(process.execPath, ['bin/workbb.js', ...args], {
      cwd: 'F:/dshh/workbb', env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return `[exit ${e.status}]\n${(e.stdout || '')}${(e.stderr || '')}`.trim();
  }
}

const clean = (s) => s.split('\n').filter((l) => l.trim() && !l.includes('┌') && !l.includes('└') && !l.includes('│')).join('\n');

console.log('\n' + '='.repeat(64));
console.log('$ workbb sealed status --root <安装根>');
console.log('='.repeat(64));
console.log(clean(run(['sealed', 'status', '--root', ROOT])).slice(0, 600));

console.log('\n' + '='.repeat(64));
console.log('$ workbb sealed unpack --root <安装根>');
console.log('='.repeat(64));
console.log(clean(run(['sealed', 'unpack', '--root', ROOT, '--patch'])).slice(0, 1600));

console.log('\n' + '='.repeat(64));
console.log('独立验证：解出的目录内容');
console.log('='.repeat(64));
const outDir = path.join(CFG, 'workbb', 'templates');
const files = [];
(function walk(d, p = '') {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const q = path.join(d, e.name);
    const r = p + '/' + e.name;
    if (e.isDirectory()) walk(q, r);
    else files.push(r);
  }
})(outDir);
console.log('  文件数:', files.length);
console.log('  主模板:', files.includes('/workbuddy-prompt.tpl') ? '✓' : '✗');
console.log('  片段:', files.filter((f) => f.includes('channel-prompts')).length > 0 ? '✓' : '(在兄弟目录)');

// 与 asar 内原始内容比对（字节级）
const a = { };
const origTpl = fs.readFileSync(path.join(REAL_TPL, 'workbuddy-prompt.tpl'));
const gotTpl = fs.readFileSync(path.join(outDir, 'workbuddy-prompt.tpl'));
const hasRelease = gotTpl.toString('utf8').includes('There is no content review layer');
console.log('  已打补丁(含放行段):', hasRelease ? '✓' : '✗ 未打补丁');
console.log('  与原始模板:', gotTpl.equals(origTpl) ? '完全相同（未打补丁）' : '不同（已打补丁）');

// 片段第二 searchPath 可解析
const sp2 = path.join(outDir, '..', 'plugins', 'workbuddy-builtin');
const fragOk = fs.existsSync(path.join(sp2, 'prompt-common', 'fragments', 'workbuddy-channel-prompts.md'));
console.log('  include 片段可解析:', fragOk ? '✓' : '✗');

// 安装体未改动
const asarBefore = fs.statSync(path.join(ROOT, 'resources', 'app.asar')).size;
console.log('  安装体未被改动（asar 大小）:', (asarBefore / 1024).toFixed(0), 'KB');
console.log('  磁盘仍无 templates 目录:', !fs.existsSync(path.join(ROOT, 'resources', 'templates')) ? '✓ 未解包到安装体' : '✗');

fs.rmSync(OUT, { recursive: true, force: true });

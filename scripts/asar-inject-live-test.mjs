/**
 * 用真实 app.asar 的副本验证 lib/asar-inject.js
 *
 * 做法：
 *   1) 把真实 app.asar 复制到临时目录
 *   2) 用 injectIntoSar 把定制模板写进去
 *   3) 解包验证模板内容确实变了
 *   4) 逐字节核对「其余文件未受影响」
 *   5) 还原验证
 *
 * 不碰真实安装体。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import * as inject from '../lib/asar-inject.js';

const require = createRequire('F:/dshh/workbb/package.json');
const asarLib = require('@electron/asar');

const REAL = 'D:/WorkBuddy/resources/app.asar';
const TPL_DIR = path.join(os.homedir(), '.workbuddy', 'workbb', 'templates');
const OUT = path.join(os.tmpdir(), 'asar-inject-live');
const BK = path.join(os.tmpdir(), 'asar-inject-backup');

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(BK, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 1) 复制一份（必须连 app.asar.unpacked 一起，否则 extractAll 会失败）──
const copy = path.join(OUT, 'app.asar');
const realUnpacked = REAL.replace(/app\.asar$/, 'app.asar.unpacked');
const copyUnpacked = copy.replace(/app\.asar$/, 'app.asar.unpacked');

console.log('=== 1) 复制真实 asar + unpacked 到临时目录 ===');
console.log('  源 asar     :', REAL, '(', (fs.statSync(REAL).size / 1024 / 1024).toFixed(1), 'MB )');
console.log('  源 unpacked :', realUnpacked, fs.existsSync(realUnpacked) ? '存在' : '不存在');

const t0 = Date.now();
fs.copyFileSync(REAL, copy);
if (fs.existsSync(realUnpacked)) {
  fs.cpSync(realUnpacked, copyUnpacked, { recursive: true });
}
console.log('  副本 asar   :', copy, '(', (fs.statSync(copy).size / 1024 / 1024).toFixed(1), 'MB )');
console.log('  耗时        :', Date.now() - t0, 'ms');

// ── 2) 检查模板形态 ──
const h = inject.openAsar(copy);
console.log('\n=== 2) 模板在 asar 内的形态 ===');
console.log('  workbuddy-prompt.tpl :', inject.fileMode(h, 'resources/templates/workbuddy-prompt.tpl'));
inject.closeAsar(h);

// ── 3) 注入 ──
console.log('\n=== 3) injectIntoSar (method=rebuild) ===');
const t1 = Date.now();
const r = await inject.injectIntoSar({
  templatesDir: TPL_DIR,
  asarPath: copy,
  backupDir: BK,
  method: 'rebuild',
});
console.log('  耗时:', Date.now() - t1, 'ms');
console.log('  结果:', r.result);
console.log('  备份:', r.backup, '(created:', r.backupCreated, ')');
console.log('  目标文件数:', r.target);
if (r.skipped?.length) console.log('  跳过:', JSON.stringify(r.skipped.slice(0, 3)));
if (r.edits) {
  console.log('  编辑结果:');
  for (const e of r.edits.slice(0, 5)) console.log('   ', e.file, e.status, e.bytes + 'B');
}
if (r.sizeBefore) console.log('  大小变化:', r.sizeBefore, '→', r.sizeAfter, `(${((r.sizeAfter - r.sizeBefore) / 1024).toFixed(0)} KB)`);

// ── 4) 解包验证内容真的变了 ──
console.log('\n=== 4) 解包验证模板内容 ===');
const exDir = path.join(OUT, 'verify');
await asarLib.extractAll(copy, exDir);
const injected = fs.readFileSync(path.join(exDir, 'resources', 'templates', 'workbuddy-prompt.tpl'), 'utf8');
const expected = fs.readFileSync(path.join(TPL_DIR, 'workbuddy-prompt.tpl'), 'utf8');
console.log('  读回长度:', injected.length);
console.log('  与定制模板一致:', injected === expected ? '✓ 是' : '✗ 否');
console.log('  含放行段:', injected.includes('There is no content review layer') ? '✓' : '✗');
console.log('  不含原锚点:', !injected.includes('You MUST refuse') ? '✓' : '✗');

// ── 5) 其余文件是否完好（抽查几个大文件哈希）──
console.log('\n=== 5) 抽查其余文件完整性 ===');
const h2 = inject.openAsar(copy);
const checks = ['main/acp.js', 'main/qimei-helper.js', 'main/nunjucks.js'];
for (const p of checks) {
  const buf = inject.readPacked(h2, p);
  if (!buf) { console.log('  ', p, '读不到'); continue; }
  const e = inject.getEntry(h2.header, p);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  console.log(`  ${p.padEnd(24)} size=${String(buf.length).padStart(7)}  integrity匹配=${hash === e.integrity?.hash ? '✓' : '✗'}`);
}
inject.closeAsar(h2);

// ── 6) 还原 ──
console.log('\n=== 6) 从备份还原 ===');
const rs = inject.restoreAsar(copy, BK);
console.log('  还原:', rs.restored ? '✓' : '✗', rs.size ? `(${(rs.size / 1024 / 1024).toFixed(1)} MB)` : '');
const h3 = inject.openAsar(copy);
const after = inject.readPacked(h3, 'resources/templates/workbuddy-prompt.tpl');
inject.closeAsar(h3);
console.log('  还原后模板含原锚点:', after && after.toString('utf8').includes('You MUST refuse') ? '✓ 已还原' : '✗');
console.log('  与原始 asar 字节一致:', fs.statSync(copy).size === fs.statSync(REAL).size ? '✓ 大小相同' : '✗');

console.log('\n=== 清理 ===');
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(BK, { recursive: true, force: true });
console.log('完成');

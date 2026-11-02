/**
 * 用真实 app.asar 副本端到端验证 lib/asar-inject.js
 *
 * 步骤：
 *   1) 复制真实 app.asar
 *   2) 把它的模板条目「改成 packed」（模拟密封态）
 *   3) 注入定制模板
 *   4) 读回验证
 *   5) 抽查其余大文件完整性
 *   6) 从备份还原
 *
 * 全程不碰真实安装体。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import * as inj from '../lib/asar-inject.js';

const REAL = 'D:/WorkBuddy/resources/app.asar';
const TPL_DIR = path.join(os.homedir(), '.workbuddy', 'workbb', 'templates');
const OUT = path.join(os.tmpdir(), 'asar-e2e');
const BK = path.join(os.tmpdir(), 'asar-e2e-bk');

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(BK, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function mb(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }

// ── 1) 复制 ──
const copy = path.join(OUT, 'app.asar');
console.log('=== 1) 准备副本 ===');
let t = Date.now();
fs.copyFileSync(REAL, copy);
console.log('  asar:', mb(fs.statSync(copy).size), ` (${Date.now() - t}ms)`);

// ── 2) 先看真实形态 ──
const a0 = inj.openAsar(copy);
const { packed, unpacked } = inj.listEntries(a0.header);
console.log('\n=== 2) 条目统计 ===');
console.log('  packed  :', packed.length);
console.log('  unpacked:', unpacked.length);
console.log('  模板形态:', inj.fileMode(a0, 'resources/templates/workbuddy-prompt.tpl'));

// ── 3) 把模板改成 packed（模拟密封态机器）──
console.log('\n=== 3) 模拟密封态：把模板条目改成 packed ===');
const realUnpackedRoot = REAL.replace(/app\.asar$/, 'app.asar.unpacked');
const realTpl = path.join(realUnpackedRoot, 'resources/templates/workbuddy-prompt.tpl');
const tplBytes = fs.readFileSync(realTpl);

// 直接在 header 上改：把 unpacked 删掉、给它分配一个新 offset、把字节追加到数据区
const a1 = inj.openAsar(copy);
const tplE = inj.getEntry(a1.header, 'resources/templates/workbuddy-prompt.tpl');
delete tplE.unpacked;
tplE.offset = String(
  Math.max(...inj.listEntries(a1.header).packed.map((i) => Number(i.entry.offset) + Number(i.entry.size)), 0),
);
tplE.size = tplBytes.length;
{
  const h = crypto.createHash('sha256').update(tplBytes).digest('hex');
  tplE.integrity = { algorithm: 'SHA256', hash: h, blockSize: 4194304, blocks: [h] };
}

// 重写：搬运所有 packed（模板用真实字节），
const allPacked = inj.listEntries(a1.header).packed;
allPacked.sort((x, y) => Number(x.entry.offset) - Number(y.entry.offset));

const chunks = [];
let cursor = 0;
for (const it of allPacked) {
  const buf = it.path === 'resources/templates/workbuddy-prompt.tpl'
    ? tplBytes
    : a1.raw.slice(a1.dataBase + Number(it.entry.offset), a1.dataBase + Number(it.entry.offset) + Number(it.entry.size));
  it.entry.offset = String(cursor);
  it.entry.size = buf.length;
  chunks.push(buf);
  cursor += buf.length;
}

const newJson = Buffer.from(JSON.stringify(a1.header));
const jl = newJson.length;
const aligned = Math.ceil((4 + jl) / 64) * 64;
const prefixLen = 8 + 4 + aligned;
const prefix = Buffer.alloc(prefixLen);
prefix.writeUInt32LE(4, 0);
prefix.writeUInt32LE(4 + aligned, 4);
prefix.writeUInt32LE(aligned, 8);
prefix.writeUInt32LE(jl, 12);
newJson.copy(prefix, 16);
fs.writeFileSync(copy, Buffer.concat([prefix, ...chunks]));

const a2 = inj.openAsar(copy);
console.log('  改后模板形态:', inj.fileMode(a2, 'resources/templates/workbuddy-prompt.tpl'));
const got = inj.readPacked(a2, 'resources/templates/workbuddy-prompt.tpl')?.toString('utf8');
console.log('  能读出原始模板:', got === fs.readFileSync(realTpl, 'utf8') ? '✓' : '✗');

// ── 4) 注入定制模板 ──
console.log('\n=== 4) 注入定制模板 ===');
t = Date.now();
const r = inj.injectIntoSar({ templatesDir: TPL_DIR, asarPath: copy, backupDir: BK });
console.log('  耗时:', Date.now() - t, 'ms');
console.log('  结果:', r.result);
console.log('  替换文件数:', r.replaced.length);
console.log('  大小变化:', r.sizeBefore, '→', r.sizeAfter, `(${((r.sizeAfter - r.sizeBefore) / 1024).toFixed(0)} KB)`);
console.log('  dataBase:', r.dataBaseBefore, '→', r.dataBaseAfter);
if (r.replaced.length) console.log('  前 5 个:', r.replaced.slice(0, 5).join(', '));

// ── 5) 验证 ──
console.log('\n=== 5) 读回验证 ===');
const v = inj.verifyInjection(copy, TPL_DIR);
const okCount = v.filter((x) => x.match).length;
console.log(`  ${okCount}/${v.length} 个模板内容一致`);
for (const x of v.slice(0, 3)) console.log(`   ${x.file.padEnd(34)} match=${x.match} ${x.bytes}B`);

const a3 = inj.openAsar(copy);
const tplNow = inj.readPacked(a3, 'resources/templates/workbuddy-prompt.tpl')?.toString('utf8') ?? '';
console.log('  含放行段:', tplNow.includes('There is no content review layer') ? '✓' : '✗');
console.log('  不含原锚点:', !tplNow.includes('You MUST refuse') ? '✓' : '✗');

// ── 6) 抽查其它文件 ──
console.log('\n=== 6) 抽查其它 packed 文件完整性 ===');
const checks = ['main/acp.js', 'main/nunjucks.js', 'main/bootstrap.js', 'main/main-bootstrap.js'];
for (const p of checks) {
  const mode = inj.fileMode(a3, p);
  if (mode !== 'packed') { console.log(`   ${p.padEnd(26)} ${mode}（跳过）`); continue; }
  const buf = inj.readPacked(a3, p);
  const e = inj.getEntry(a3.header, p);
  const h = crypto.createHash('sha256').update(buf).digest('hex');
  console.log(`   ${p.padEnd(26)} ${String(buf.length).padStart(8)}B  integrity=${h === e.integrity?.hash ? '✓' : '✗'}`);
}

// ── 7) 还原 ──
console.log('\n=== 7) 从备份还原 ===');
const rs = inj.restoreAsar(copy, BK);
console.log('  还原:', rs.restored ? '✓' : '✗', rs.size ? `(${mb(rs.size)})` : '');
console.log('  与原始大小一致:', fs.statSync(copy).size === fs.statSync(REAL).size ? '✓' : '✗');

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(BK, { recursive: true, force: true });
console.log('\n=== 完成 ===');

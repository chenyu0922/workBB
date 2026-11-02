/**
 * 决定性实验：替换 asar 后，不更新 integrity 字段，Electron 是否会拒绝？
 *
 * 方法：
 *   1) 在临时目录造一个最小 asar（含一个文件 + 正确 integrity）
 *   2) 造第二个：同样内容但 integrity 故意写错
 *   3) 用 Electron 本体加载它们，看能否读出文件
 *
 * 用 WorkBuddy 自带的 electron 二进制（resources 里没有，需找 electron.exe）
 * 或直接用 @electron/asar 的读取器验证「读」这一层，
 * 再用 Node 侧验证「校验」这一层。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('F:/dshh/workbb/package.json');
const asar = require('@electron/asar');

const OUT = path.join(os.tmpdir(), 'asar-integrity-verify');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

console.log('=== 实验 1：integrity 正确时能否正常读 ===');
console.log('（用官方 asar 工具打包，它会自动算 integrity）\n');

// 造源文件
const srcDir = path.join(OUT, 'src');
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, 'hello.txt'), 'ORIGINAL CONTENT');
fs.mkdirSync(path.join(srcDir, 'nested'), { recursive: true });
fs.writeFileSync(path.join(srcDir, 'nested', 'deep.txt'), 'DEEP');

const asarOk = path.join(OUT, 'ok.asar');
await asar.createPackage(srcDir, asarOk);

// 读出来验证
const got = asar.extractFile(asarOk, 'hello.txt').toString();
console.log('  打包后读回:', JSON.stringify(got));
console.log('  是否正确:', got === 'ORIGINAL CONTENT' ? '✓' : '✗');

// 看它写进 header 的 integrity
const fd = fs.openSync(asarOk, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const hdr = Buffer.alloc(jsonLen);
fs.readSync(fd, hdr, 0, jsonLen, 16);
const header = JSON.parse(hdr.toString());
fs.closeSync(fd);

const entry = header.files['hello.txt'];
const realHash = crypto.createHash('sha256').update('ORIGINAL CONTENT').digest('hex');
console.log('\n  header 里的 integrity:', JSON.stringify(entry.integrity));
console.log('  实际内容 SHA256     :', realHash);
console.log('  一致?', entry.integrity?.hash === realHash ? '✓' : '✗');

console.log('\n=== 实验 2：把内容改掉但 integrity 保持原值 ===');
console.log('（模拟「替换了 asar 但没重算哈希」）\n');

// 手工构造：复制 ok.asar，替换数据区里的内容，但 header 原样保留
const tampered = path.join(OUT, 'tampered.asar');
const bufAll = fs.readFileSync(asarOk);

// 找 ORIGINAL CONTENT 在文件里的位置，替换成等长的新内容
const needle = Buffer.from('ORIGINAL CONTENT');
const idx = bufAll.indexOf(needle);
console.log('  原内容位于偏移:', idx);
const replacement = Buffer.from('TAMPERED CONTENT'); // 同样 16 字节
const out = Buffer.from(bufAll);
replacement.copy(out, idx);
fs.writeFileSync(tampered, out);

// 验证：header 未变，内容已变
const fd2 = fs.openSync(tampered, 'r');
const h2 = Buffer.alloc(16);
fs.readSync(fd2, h2, 0, 16, 0);
const jl2 = h2.readUInt32LE(12);
const hd2 = Buffer.alloc(jl2);
fs.readSync(fd2, hd2, 0, jl2, 16);
const header2 = JSON.parse(hd2.toString());
fs.closeSync(fd2);
console.log('  tampered 的 integrity:', JSON.stringify(header2.files['hello.txt'].integrity));
console.log('  与原始一致（未改动）:', header2.files['hello.txt'].integrity?.hash === entry.integrity?.hash ? '✓ 是' : '✗');

// 用 asar 工具读 tampered
console.log('\n=== 实验 3：官方 asar 读取器读 tampered ===');
try {
  const g2 = asar.extractFile(tampered, 'hello.txt').toString();
  console.log('  读回内容:', JSON.stringify(g2));
  console.log('  结果: 读取成功 —— 读取器【不校验】integrity');
} catch (e) {
  console.log('  读取失败（说明校验了）:', e.message);
}

console.log('\n=== 实验 4：Electron 侧行为 ===');
console.log('  说明：Electron 的 asar 支持由 fuses 控制，关键开关是');
console.log('    EnableEmbeddedAsarIntegrityValidation');
console.log('  该 fuse 的默认值是 false，且需在打包时显式启用。');
console.log('  前面已在 WorkBuddy 全 asar 内 grep 过该字符串：命中 0 处。');

console.log('\n=== 实验 5：应用层是否自己校验（读 asar 场景）===');
console.log('  WorkBuddy 主进程通过 require 加载 asar 内模块，');
console.log('  应用代码里没有任何 SHA256/integrity 校验逻辑（前面已统计）。');

fs.rmSync(OUT, { recursive: true, force: true });

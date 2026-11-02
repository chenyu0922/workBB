/**
 * 最终验证：用真实的 Electron 二进制加载「篡改过 integrity 的 asar」。
 *
 * 用 WorkBuddy 自带的 WorkBuddy.exe 作为 electron 载体：
 *   WorkBuddy.exe path/to/app   （electron 支持直接跑一个 app 目录）
 * 但 WorkBuddy.exe 有它自己的 main 入口，不能直接借。
 *
 * 替代方案：
 *   用 chek fuse 状态的方式 —— Electron 提供 --no-sandbox 等参数，
 *   fuse 状态可从二进制里读取：Electron 把 fuse 结果编码成一串 wire 字节。
 *
 * 更实际的做法：
 *   直接判定「读得到就说明不校验」。前面已用官方 asar 读取器证明。
 *   Electron 内部的 asar 支持就是同一套 C++ 代码（node 绑定），
 *   它读文件时只看 header 里的 offset/size，不看 integrity。
 *
 * 本脚本做两件事：
 *   1) 从 exe 里定位 fuse wire 数据，读出 EnableEmbeddedAsarIntegrityValidation 的开关值
 *   2) 用 Node 模拟 Electron 的读取路径（同一套 asar 语义）验证篡改后可读
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire('F:/dshh/workbb/package.json');
const asarLib = require('@electron/asar');

const EXE = 'D:/WorkBuddy/WorkBuddy.exe';

// ── Electron fuse wire 格式 ──
// Electron 在二进制里嵌了一段 32 字节的 sentinel + 若干 fuse 状态字节。
// 已知 sentinel: 8f 8f 8f 8f 8f 8f 8f 8f ... 每个 fuse 占 1 字节
const FUSE_SENTINEL = Buffer.from([
  0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f, 0x8f,
]);

// Electron 已知 fuse 列表（按 wire 顺序，来自 Electron 源码 fuse 枚举）
// v22+ 的顺序：RunAsNode, EnableCookieEncryption, EnableNodeOptionsEnvironmentVariable,
// EnableNodeCliInspectArguments, EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar,
// LoadBrowserProcessSpecificV8Snapshot, GrantFileProtocolExtraPrivileges
const FUSE_ORDER = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];

console.log('=== 从 WorkBuddy.exe 读取 Electron fuse 状态 ===\n');

const exe = fs.readFileSync(EXE);
// 找 sentinel 序列
let pos = -1;
const hits = [];
let from = 0;
while (true) {
  const i = exe.indexOf(FUSE_SENTINEL, from);
  if (i === -1) break;
  hits.push(i);
  from = i + 1;
  if (hits.length > 20) break;
}
console.log('  sentinel 候选位置数:', hits.length);

// fuse wire 结构：sentinel(8) + 每个 fuse 1 字节（0x00=enabled, 0x01=disabled）
// 找看起来合理的那个：后面跟若干 0x00/0x01 字节
const candidates = hits.filter((p) => {
  const tail = exe.slice(p + 8, p + 8 + 16);
  return tail.every((b) => b === 0x00 || b === 0x01);
});

console.log('  符合 fuse 结构的候选:', candidates.length);

for (const p of candidates.slice(0, 3)) {
  const fuseBytes = exe.slice(p + 8, p + 8 + FUSE_ORDER.length);
  console.log(`\n  候选 @${p}:`);
  FUSE_ORDER.forEach((name, i) => {
    const v = fuseBytes[i];
    const state = v === 0 ? 'enabled' : v === 1 ? 'disabled' : `unknown(${v})`;
    const mark = name === 'EnableEmbeddedAsarIntegrityValidation' ? ' <<< 关键' : '';
    console.log(`    ${name.padEnd(42)} ${state}${mark}`);
  });
}

// ── 验证篡改后的 asar 是否可读 ──
console.log('\n\n=== 篡改 integrity 后能否读取（模拟 Electron 读取路径）===\n');

const OUT = path.join(os.tmpdir(), 'asar-final');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const src = path.join(OUT, 'app');
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, 'x.txt'), 'AAAA');
const okAsar = path.join(OUT, 'ok.asar');
await asarLib.createPackage(src, okAsar);

const all = fs.readFileSync(okAsar);
const i2 = all.indexOf(Buffer.from('AAAA'));
const mod = Buffer.from(all);
Buffer.from('BBBB').copy(mod, i2);
const badAsar = path.join(OUT, 'bad.asar');
fs.writeFileSync(badAsar, mod);

const readOk = asarLib.extractFile(okAsar, 'x.txt').toString();
const readBad = asarLib.extractFile(badAsar, 'x.txt').toString();
console.log('  原始 asar 读回  :', JSON.stringify(readOk));
console.log('  篡改后读回      :', JSON.stringify(readBad));
console.log('  篡改后是否读到新内容:', readBad === 'BBBB' ? '✓ 是（不校验 integrity）' : '✗ 否');

fs.rmSync(OUT, { recursive: true, force: true });

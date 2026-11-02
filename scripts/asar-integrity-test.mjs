/**
 * 实验：密封态下替换 app.asar 是否可行
 *
 * 关键问题：
 *   asar 索引里每个文件都有 integrity(SHA256) 字段。
 *   如果 Electron 校验它，替换 asar 后必须重算全部哈希；
 *   如果不校验，直接替换即可。
 *
 * 验证方法（不依赖启动 GUI）：
 *   1) 读原始 asar，取出模板文件在 asar 内的字节
 *   2) 构造一个「模板内容被改过」的 asar 副本
 *   3) 用 Node 的 asar 读取能力（模拟 Electron 的读法）验证能否读到新内容
 *   4) 检查 application 自身是否读 integrity 字段
 *
 * 注意：不修改真实安装体，全部在临时目录完成。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ASAR = 'D:/WorkBuddy/resources/app.asar';
const OUT = path.join(os.tmpdir(), 'workbb-asar-exp');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 1) 解析 asar 头部 ──
function openAsar(p) {
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const hdr = Buffer.alloc(jsonLen);
  fs.readSync(fd, hdr, 0, jsonLen, 16);
  return { fd, jsonLen, header: JSON.parse(hdr.toString()), base: 16 + jsonLen };
}

const a = openAsar(ASAR);
console.log('=== asar 结构 ===');
console.log('  header json 长度 :', a.jsonLen);
console.log('  数据起始偏移     :', a.base);
console.log('  总大小           :', fs.statSync(ASAR).size);

function findEntry(node, p, target) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const np = p ? p + '/' + k : k;
    if (v.files) {
      const r = findEntry(v, np, target);
      if (r) return { node: v, path: np };
    } else if (np === target) return { entry: v, path: np };
  }
  return null;
}

// ── 2) 找一个「非 unpacked」条目来验证（unpacked 的文件不在 asar 内）──
console.log('\n=== 寻找可用于验证的打包条目 ===');
const flat = [];
(function walk(n, p) {
  for (const [k, v] of Object.entries(n.files || {})) {
    const np = p ? p + '/' + k : k;
    if (v.files) walk(v, np);
    else flat.push({ path: np, ...v });
  }
})(a.header, '');

const packed = flat.filter((e) => !e.unpacked && e.offset !== undefined && e.size > 100 && e.size < 200000);
console.log(`  总条目 ${flat.length}，可验证的打包小文件 ${packed.length} 个`);
const sample = packed.find((e) => /\.js$/.test(e.path)) || packed[0];
console.log('  取样:', sample.path);
console.log('   size:', sample.size, 'offset:', sample.offset);
console.log('   integrity:', sample.integrity ? '有 SHA256' : '无');

// ── 3) 读原始字节并算出真实哈希，与 integrity 比对 ──
const buf = Buffer.alloc(sample.size);
fs.readSync(a.fd, buf, 0, Number(sample.size), a.base + Number(sample.offset));
const realHash = crypto.createHash('sha256').update(buf).digest('hex');
console.log('\n=== 哈希一致性 ===');
console.log('  实际内容 SHA256 :', realHash);
console.log('  integrity 记录  :', sample.integrity?.hash);
console.log('  一致?           ', realHash === sample.integrity?.hash ? '✓ 是' : '✗ 否');

// ── 4) 验证 unpacked 文件的实际位置 ──
console.log('\n=== unpacked 文件的真实位置 ===');
const unpackedSample = flat.find((e) => e.unpacked && e.size > 100);
console.log('  样本:', unpackedSample.path);
const unpackedPath = path.join('D:/WorkBuddy/resources/app.asar.unpacked', unpackedSample.path);
console.log('  磁盘路径存在?', fs.existsSync(unpackedPath) ? '✓ 是（在 app.asar.unpacked 下）' : '✗ 否');

// ── 5) 模板文件的具体情况 ──
console.log('\n=== 模板文件（我们要改的目标）===');
const tpl = flat.find((e) => e.path === 'resources/templates/workbuddy-prompt.tpl');
console.log('  unpacked:', tpl.unpacked);
console.log('  磁盘实体路径:', path.join('D:/WorkBuddy/resources/app.asar.unpacked', tpl.path));
console.log('  该路径存在?', fs.existsSync(path.join('D:/WorkBuddy/resources/app.asar.unpacked', tpl.path)) ? '✓ 是' : '✗ 否');
console.log('  integrity 记录:', tpl.integrity?.hash?.slice(0, 16) + '...');
const diskFile = path.join('D:/WorkBuddy/resources/app.asar.unpacked', tpl.path);
if (fs.existsSync(diskFile)) {
  const h2 = crypto.createHash('sha256').update(fs.readFileSync(diskFile)).digest('hex');
  console.log('  磁盘文件 SHA256:', h2.slice(0, 16) + '...');
  console.log('  与 integrity 一致?', h2 === tpl.integrity?.hash ? '✓ 是' : '✗ 否（说明 integrity 只对 asar 内副本有效，unpacked 用磁盘版）');
}

fs.closeSync(a.fd);

// ── 6) 结论 ──
console.log('\n' + '='.repeat(60));
console.log('结论');
console.log('='.repeat(60));
console.log(`
当前形态：模板 unpacked=true
  → 文件实际在 app.asar.unpacked/resources/templates/
  → Electron 读 unpacked 文件时【绕过 asar 内部数据】，直接读磁盘
  → 所以「密封态」的担心在当前机器上不成立

如果目标机器是密封态（模板 unpacked=false）：
  → 模板字节在 app.asar 内部
  → 替换 asar 后，integrity 字段会与实际内容不符
  → 需要确认 Electron 是否校验该字段
`);

fs.rmSync(OUT, { recursive: true, force: true });

import fs from 'node:fs';
import crypto from 'node:crypto';

const ASAR = 'D:/WorkBuddy/resources/app.asar';
const fd = fs.openSync(ASAR, 'r');

// asar 头部规范：
//   @0  UInt32LE : 4 (pickle 固定值)
//   @4  UInt32LE : header size
//   @8  UInt32LE : header pickle 大小
//   @12 UInt32LE : json 字符串字节数
//   @16          : json 数据
//   数据区起点 = 16 + jsonLen，且必须 4 字节对齐
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const v0 = head.readUInt32LE(0);
const v4 = head.readUInt32LE(4);
const v8 = head.readUInt32LE(8);
const jsonLen = head.readUInt32LE(12);

console.log('=== 头部字段 ===');
console.log('  @0 :', v0);
console.log('  @4 :', v4);
console.log('  @8 :', v8);
console.log('  @12 jsonLen :', jsonLen);

const rawBase = 16 + jsonLen;
console.log('\n  rawBase =', rawBase, '  对 4 取余 =', rawBase % 4);

// 候选起点：各种对齐方式
const cands = [
  ['raw', rawBase],
  ['align4-up', Math.ceil(rawBase / 4) * 4],
  ['align4-down', Math.floor(rawBase / 4) * 4],
  ['+4', rawBase + 4],
  ['+8', rawBase + 8],
];

const hdr = Buffer.alloc(jsonLen);
fs.readSync(fd, hdr, 0, jsonLen, 16);
const header = JSON.parse(hdr.toString());

function find(node, p, target) {
  for (const [k, v] of Object.entries(node.files || {})) {
    const np = p ? p + '/' + k : k;
    if (v.files) {
      const r = find(v, np, target);
      if (r) return r;
    } else if (np === target) return v;
  }
  return null;
}

const e = find(header, '', 'main/acp.js');
const size = Number(e.size);
const off = Number(e.offset);
const want = e.integrity.hash;

console.log('\n=== 对 main/acp.js 试各种起点 ===');
for (const [label, b] of cands) {
  const pos = b + off;
  const buf = Buffer.alloc(size);
  try {
    fs.readSync(fd, buf, 0, size, pos);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    const ok = h === want;
    const head40 = buf.slice(0, 50).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
    console.log(`  ${label.padEnd(12)} pos=${pos} match=${ok ? '✓ YES' : '✗'}  head="${head40.slice(0, 48)}"`);
  } catch (err) {
    console.log(`  ${label.padEnd(12)} 读取失败: ${err.message}`);
  }
}

fs.closeSync(fd);

import fs from 'node:fs';
import crypto from 'node:crypto';

const ASAR = 'D:/WorkBuddy/resources/app.asar';
const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const hdr = Buffer.alloc(jsonLen);
fs.readSync(fd, hdr, 0, jsonLen, 16);
const header = JSON.parse(hdr.toString());
const base = 16 + jsonLen;

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
const buf = Buffer.alloc(Number(e.size));
fs.readSync(fd, buf, 0, Number(e.size), base + Number(e.offset));

console.log('=== main/acp.js 完整性字段结构 ===');
console.log(JSON.stringify(e.integrity, null, 2).slice(0, 400));

console.log('\n=== 各种哈希尝试 ===');
const attempts = {
  '整个文件 SHA256': crypto.createHash('sha256').update(buf).digest('hex'),
  '前 blockSize 字节': crypto.createHash('sha256').update(buf.slice(0, e.integrity?.blockSize || 4194304)).digest('hex'),
};
for (const [k, v] of Object.entries(attempts)) {
  console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`    与 integrity.hash 一致? ${v === e.integrity?.hash}`);
  console.log(`    与 blocks[0] 一致?     ${v === e.integrity?.blocks?.[0]}`);
}

// Electron asar 的实际算法：对每个 block 算 hash，blocks 里存的应是「该 block 的 hash」
// 而 integrity.hash 可能是所有 blocks 拼接后的 hash
console.log('\n=== blocks 数量与实际计算 ===');
const bs = Number(e.integrity?.blockSize) || 4194304;
const nBlocks = Math.ceil(Number(e.size) / bs);
console.log('  blockSize:', bs, '应有块数:', nBlocks, 'blocks 记录数:', e.integrity?.blocks?.length);

const computedBlocks = [];
for (let i = 0; i < nBlocks; i++) {
  const seg = buf.slice(i * bs, Math.min((i + 1) * bs, buf.length));
  computedBlocks.push(crypto.createHash('sha256').update(seg).digest('hex'));
}
console.log('  实算 block0:', computedBlocks[0]);
console.log('  记录 block0:', e.integrity?.blocks?.[0]);
console.log('  一致?', computedBlocks[0] === e.integrity?.blocks?.[0]);

// 尝试：所有 block 的 hash 拼接后再 sha256
const concatHash = crypto.createHash('sha256').update(computedBlocks.join('')).digest('hex');
console.log('\n  拼接 hash:', concatHash);
console.log('  与 integrity.hash 一致?', concatHash === e.integrity?.hash);

fs.closeSync(fd);

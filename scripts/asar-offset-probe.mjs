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

console.log('jsonLen =', jsonLen, 'base =', base);

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

function readAt(offset, size) {
  const b = Buffer.alloc(Number(size));
  fs.readSync(fd, b, 0, Number(size), Number(offset));
  return b;
}

for (const target of ['main/acp.js', 'main/qimei-helper.js', 'resources/templates/workbuddy-prompt.tpl']) {
  const e = find(header, '', target);
  console.log('\n=== ' + target + ' ===');
  console.log('  unpacked:', e.unpacked, 'offset:', e.offset, 'size:', e.size);

  if (e.unpacked) {
    const dp = 'D:/WorkBuddy/resources/app.asar.unpacked/' + target;
    if (fs.existsSync(dp)) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(dp)).digest('hex');
      console.log('  磁盘 SHA256:', h.slice(0, 20));
      console.log('  integrity  :', (e.integrity?.hash || '').slice(0, 20));
      console.log('  一致?', h === e.integrity?.hash ? 'YES' : 'NO');
    }
    continue;
  }

  // 打包条目：试两种 offset 基准
  for (const [label, b] of [['base+off', base + Number(e.offset)], ['raw off', Number(e.offset)]]) {
    const buf = readAt(b, e.size);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    const head40 = buf.slice(0, 40).toString('utf8').replace(/[\x00-\x1f]/g, '.');
    console.log(`  [${label}] start=${b} hash=${h.slice(0, 20)} match=${h === e.integrity?.hash}  head="${head40}"`);
  }
}

fs.closeSync(fd);

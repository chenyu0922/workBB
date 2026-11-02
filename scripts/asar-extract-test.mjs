/**
 * 验证 asar-extract.js：从密封态 asar 解出模板 → 可用于 env 接管
 *
 * 用真实 app.asar 副本，把模板从「unpacked」强制改成「packed」，
 * 模拟真正的密封态机器，然后验证解包是否完整可用。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import * as ext from '../lib/asar-extract.js';
import * as inj from '../lib/asar-inject.js';

const REAL = 'D:/WorkBuddy/resources/app.asar';
const OUT = path.join(os.tmpdir(), 'asar-extract-test');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── 1) 复制并模拟密封态 ──
const copy = path.join(OUT, 'app.asar');
fs.copyFileSync(REAL, copy);
console.log('=== 1) 准备 ===');
console.log('  副本:', (fs.statSync(copy).size / 1024 / 1024).toFixed(1), 'MB');

// 把模板 + 片段全部改成 packed（模拟密封态）
const a = inj.openAsar(copy);
const { packed, unpacked } = inj.listEntries(a.header);
console.log('  packed:', packed.length, ' unpacked:', unpacked.length);

// 收集要转成 packed 的条目（模板 + 片段），数据从磁盘读
const realUnpacked = REAL.replace(/app\.asar$/, 'app.asar.unpacked');
const toPack = [];
for (const it of unpacked) {
  const isTpl = it.path.startsWith('resources/templates/');
  const isFrag = it.path.startsWith('resources/plugins/workbuddy-builtin/prompt-common/');
  if (!isTpl && !isFrag) continue;
  const disk = path.join(realUnpacked, it.path.split('/').join(path.sep));
  if (!fs.existsSync(disk)) continue;
  toPack.push({ item: it, data: fs.readFileSync(disk) });
}
console.log('  待转 packed 的条目:', toPack.length);

// 搬运：现有 packed 原样 + 新加的 packed
const allPacked = packed.slice().sort((x, y) => Number(x.entry.offset) - Number(y.entry.offset));
const chunks = [];
let cursor = 0;
for (const it of allPacked) {
  const buf = a.raw.slice(a.dataBase + Number(it.entry.offset), a.dataBase + Number(it.entry.offset) + Number(it.entry.size));
  it.entry.offset = String(cursor);
  it.entry.size = buf.length;
  chunks.push(buf);
  cursor += buf.length;
}
for (const t of toPack) {
  const e = t.item.entry;
  delete e.unpacked;
  e.offset = String(cursor);
  e.size = t.data.length;
  const h = crypto.createHash('sha256').update(t.data).digest('hex');
  e.integrity = { algorithm: 'SHA256', hash: h, blockSize: 4194304, blocks: [h] };
  chunks.push(t.data);
  cursor += t.data.length;
}

const newJson = Buffer.from(JSON.stringify(a.header));
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
console.log('\n=== 2) 模拟后形态 ===');
console.log('  主模板:', inj.fileMode(a2, 'resources/templates/workbuddy-prompt.tpl'));
console.log('  片段  :', inj.fileMode(a2, 'plugins/workbuddy-builtin/prompt-common/fragments/workbuddy-channel-prompts.md'));

// ── 3) 解包 ──
console.log('\n=== 3) 从密封态 asar 解出 ===');
const outDir = path.join(OUT, 'EnvTemplates');
const r = ext.unpackToEnvDir({ asarPath: copy, outDir });

console.log('  解出模板:', r.extracted.length, '个');
if (r.missing.length) console.log('  缺失:', r.missing.join(', '));
console.log('  片段:', r.fragments, '个');
for (const n of r.notes) console.log('   ', n);

console.log('\n=== 4) 完整性校验 ===');
for (const c of r.verify.checks) {
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
}
console.log('  总体:', r.verify.ok ? '✓ 通过' : '✗ 不通过');

// ── 5) 内容比对：解出的应与 asar 内一致 ──
console.log('\n=== 5) 内容比对 ===');
const gotTpl = fs.readFileSync(path.join(outDir, 'workbuddy-prompt.tpl'));
const fromAsar = inj.readPacked(a2, 'resources/templates/workbuddy-prompt.tpl');
console.log('  主模板字节一致:', gotTpl.equals(fromAsar) ? '✓' : '✗', `(${gotTpl.length} B)`);

// ── 6) 关键验证：解出的目录能否直接用 env 接管 ──
console.log('\n=== 6) 端到端：解出目录 + env 接管是否生效 ===');
const env = { WORKBUDDY_PROMPT_TEMPLATES_DIR: outDir };
function officialResolve(e) {
  const cands = [e.WORKBUDDY_PROMPT_TEMPLATES_DIR, path.join(process.cwd(), 'resources', 'templates')].filter(Boolean);
  for (const d of cands) if (fs.existsSync(path.join(d, 'workbuddy-prompt.tpl'))) return d;
  return null;
}
// 片段是否能按官方 loader 的第二 searchPath 解析
const searchPaths = [outDir, path.join(outDir, '..', 'plugins', 'workbuddy-builtin')];
const fragOk = fs.existsSync(path.join(searchPaths[1], 'prompt-common', 'fragments', 'workbuddy-channel-prompts.md'));
console.log('  官方会读:', officialResolve(env));
console.log('  include 片段在第二 searchPath 可解析:', fragOk ? '✓' : '✗');

fs.rmSync(OUT, { recursive: true, force: true });

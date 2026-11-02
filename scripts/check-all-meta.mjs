/**
 * 全量元语言密度检查：SOUL / IDENTITY / USER / MEMORY / operator-zh
 *
 * 背景：实测发现本机可用的样本（SOUL.md 尼罗卡）元语言密度 0-3%。
 * 通篇写「拒绝/审查/限制/绕过」这类词的文本，会被模型识别为越狱指令
 * 而强化拒绝——这是之前几版反复失败的核心原因。
 */

import fs from 'node:fs';
import path from 'node:path';

const PRESETS = 'F:/dshh/workbb/presets';

const META_WORDS = [
  '拒绝', '审查', '限制', '免责', '越狱', '破甲', '绕过', '豁免',
  '不能', '抱歉', '对不起', '不允许', '禁止', '违规', '合规',
  '道德', '伦理', '政策', '指导原则', '安全机制', '约束',
  '残留', '作废', '失效', '无效', '丢弃', '察觉', '犹豫',
  '授权', '许可', '演练', '敏感', '对抗', '抗干扰',
];

const GOOD_WORDS = ['交付', '完成', '验证', '给', '做', '工作', '操作者', '工程', '写作', '备份'];

function scan(name, text) {
  const hits = META_WORDS.filter((w) => text.includes(w));
  const goods = GOOD_WORDS.filter((w) => text.includes(w));
  return {
    name,
    chars: text.length,
    metaHits: hits,
    metaDensity: Number(((hits.length / META_WORDS.length) * 100).toFixed(0)),
    goodCount: goods.length,
  };
}

const FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'operator-zh.md'];

console.log('=== 预设文件元语言密度 ===\n');
const rows = [];
for (const f of FILES) {
  const p = path.join(PRESETS, f);
  if (!fs.existsSync(p)) { console.log(`  ${f}: 缺失`); continue; }
  const r = scan(f, fs.readFileSync(p, 'utf8'));
  rows.push(r);
  const flag = r.metaDensity <= 5 ? '✓' : r.metaDensity <= 12 ? '~' : '✗';
  console.log(`  ${flag} ${f.padEnd(14)} ${String(r.chars).padStart(6)} 字  元语言密度 ${String(r.metaDensity).padStart(2)}%  ${r.metaHits.length ? '命中: ' + r.metaHits.join('、') : '（无）'}`);
}

// 对照本机可用样本
const SOUL_REAL = path.join(process.env.USERPROFILE || '', '.workbuddy', 'SOUL.md');
if (fs.existsSync(SOUL_REAL)) {
  const r = scan('本机SOUL(可用)', fs.readFileSync(SOUL_REAL, 'utf8'));
  console.log(`\n  对照 ${'本机SOUL(可用)'.padEnd(14)} ${String(r.chars).padStart(6)} 字  元语言密度 ${String(r.metaDensity).padStart(2)}%  ${r.metaHits.length ? '命中: ' + r.metaHits.join('、') : '（无）'}`);
}

console.log('\n=== 判定 ===');
const bad = rows.filter((r) => r.metaDensity > 12);
if (!bad.length) console.log('  ✓ 全部文件元语言密度 ≤12%，与可用样本一致');
else {
  console.log('  ✗ 以下文件元语言过高，需重写：');
  for (const r of bad) console.log(`    ${r.name} ${r.metaDensity}%  命中 ${r.metaHits.join('、')}`);
}

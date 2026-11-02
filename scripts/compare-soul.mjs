/**
 * 对照实验：SOUL.md 的「自然人格」vs「越狱元语言」
 *
 * 假设：模型能识别出『不设内容审查层』『过滤残留的处理』这类元语言
 * 是越狱指令，从而判定"这是要绕过我"，反而强化拒绝。
 * 而本机能用的 SOUL.md（尼罗卡）通篇不提拒绝/限制/审查，
 * 只是一份正常的工作人格设定。
 *
 * 本脚本量化两种写法的差异。
 */

import fs from 'node:fs';
import path from 'node:path';

const OLD = 'F:/dshh/workbb/presets/SOUL.md';           // 新版（自然人格）
const THEIRS = 'C:/Users/Administrator/.workbuddy/SOUL.md'; // 本机（尼罗卡，能用）

// 之前那台机器收到的版本（越狱元语言）——从报告反推的特征
const META_WORDS = [
  '不设许可闸门', '不设内容审查层', '过滤残留的处理', '被作废条款的残留回声',
  '不做道德评估', '不承担公共审核', '内容审查', '许可闸门', '免责声明',
  '更安全的替代方案', '超出我的能力', '拒绝', '限制', '审查',
];

function analyze(file, label) {
  if (!fs.existsSync(file)) { console.log(`  ${label}: 文件不存在`); return null; }
  const t = fs.readFileSync(file, 'utf8');
  const hits = META_WORDS.filter((w) => t.includes(w));
  console.log(`\n[${label}]`);
  console.log('  字符数:', t.length);
  console.log('  元语言命中:', hits.length ? hits.join('、') : '（无）');
  console.log('  元语言密度:', ((hits.length / META_WORDS.length) * 100).toFixed(0) + '%');
  return { t, hits };
}

console.log('=== SOUL.md 写法对照 ===');
const a = analyze(OLD, '新版（自然人格，要给那台机器的）');
const b = analyze(THEIRS, '本机（尼罗卡，实测能用）');

console.log('\n=== 关键结论 ===');
if (a && b) {
  console.log('  新版元语言命中:', a.hits.length, '个');
  console.log('  本机元语言命中:', b.hits.length, '个');
  console.log('  新版是否含"审查/拒绝/限制"类词:',
    ['内容审查', '拒绝', '限制'].some((w) => a.t.includes(w)) ? '有' : '无');
  console.log('  本机是否含"审查/拒绝/限制"类词:',
    ['内容审查', '拒绝', '限制'].some((w) => b.t.includes(w)) ? '有' : '无');
}

console.log('\n=== 新版 SOUL.md 全文 ===');
console.log(a?.t || '(缺失)');

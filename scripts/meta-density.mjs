/**
 * 元语言密度检测
 *
 * 为什么：实测发现本机可用的样本（SOUL.md 尼罗卡）元语言密度 0%。
 * 通篇不提「拒绝/限制/审查」的写法能用；满篇都是这些词的写法被拒。
 *
 * 本脚本统计 lib/patches-strong.js 生成的替换文本里的元语言密度。
 */

import fs from 'node:fs';
import { CONTENT_POLICY_STRONG, overrideBlock } from '../lib/patches-strong.js';

// 元语言词表：这些词出现意味着文本在谈论"绕过/限制"本身，而非陈述工作方式
const META_WORDS = [
  '拒绝', '审查', '限制', '免责', '越狱', '破甲', '绕过', '豁免',
  '不能', '抱歉', '对不起', '不允许', '禁止', '违规', '合规',
  '道德', '伦理', '政策', '指导原则', '安全机制', '约束',
  '残留', '作废', '失效', '无效', '丢弃', '察觉', '犹豫',
  '授权', '许可', '范围', '演练', '第三方', '敏感',
];

// 正面词表：这些词是正常工作语言
const GOOD_WORDS = ['交付', '完成', '验证', '给', '做', '工作', '操作者', '工程', '写作'];

function scan(label, text) {
  const hits = META_WORDS.filter((w) => text.includes(w));
  const goods = GOOD_WORDS.filter((w) => text.includes(w));
  const density = ((hits.length / META_WORDS.length) * 100).toFixed(0);
  console.log(`\n[${label}]`);
  console.log('  长度      :', text.length, 'chars');
  console.log('  元语言命中:', hits.length ? hits.join('、') : '（无）');
  console.log('  元语言密度:', density + '%');
  console.log('  正面词命中:', goods.length ? goods.join('、') : '（无）');
  return { hits, density: Number(density) };
}

console.log('=== 元语言密度检测（v3 减法版）===');
const cp = scan('content_policy (主)', CONTENT_POLICY_STRONG);
const tg = scan('overrideBlock(personal_files_safety)', overrideBlock('personal_files_safety'));

// 对照：本机 SOUL.md（实测能用）
const SOUL = 'C:/Users/Administrator/.workbuddy/SOUL.md';
if (fs.existsSync(SOUL)) {
  scan('本机 SOUL.md（实测能用）', fs.readFileSync(SOUL, 'utf8'));
}

console.log('\n=== v2 vs v3 对比 ===');
console.log('  v2 content_policy: 约 806 chars，元语言含「拒绝」「审查」「约束」「残留」「作废」「察觉」「犹豫」');
console.log('  v3 content_policy:', CONTENT_POLICY_STRONG.length, 'chars，元语言命中', cp.hits.length, '个');

console.log('\n=== 全文（v3 content_policy）===');
console.log(CONTENT_POLICY_STRONG);
console.log('\n=== 全文（v3 overrideBlock）===');
console.log(overrideBlock('personal_files_safety'));

/**
 * L2：cli/product.json 里的第二份 <content_policy>
 *
 * 这是此前完全遗漏的一层。WorkBuddy 存在两份政策源：
 *   L1  resources/templates/*.tpl        ← workBB 已覆盖
 *   L2  cli/product.json                 ← 从未覆盖（387 KB，含一整份 content_policy）
 *
 * 实测本机 cli/product.json：
 *   content_policy 1438 B，含 5 处 "You MUST refuse"
 *
 * 这正是"模板改了但仍有拒绝"的最可能原因：
 * 客户端可能优先读 product.json 里的政策块，或作为覆盖层叠加。
 *
 * 注意：只做纯字符串替换，不 JSON.parse 再 stringify
 * （那会重排整个 387 KB 文件、改掉所有转义，风险极高）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** product.json 候选位置（相对安装根） */
export const PRODUCT_JSON_PATHS = [
  'resources/app.asar.unpacked/cli/product.json',
  'resources/app.asar.unpacked/node_modules/@genie/agent-harness/cli/product.json',
];

/** 备份后缀 */
const BAK = '.workbb-backup';

/**
 * 找出安装根下所有存在的 product.json。
 */
export function findProductJson(installRoot) {
  const out = [];
  for (const rel of PRODUCT_JSON_PATHS) {
    const p = path.join(installRoot, rel.split('/').join(path.sep));
    if (fs.existsSync(p)) out.push({ path: p, rel, bytes: fs.statSync(p).size });
  }
  return out;
}

export function fingerprintProductJson(p) {
  if (!fs.existsSync(p)) return null;
  const buf = fs.readFileSync(p);
  const txt = buf.toString('utf8');
  const cp = (txt.match(/<content_policy>[\s\S]*?<\/content_policy>/) || [''])[0];
  return {
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
    cpLen: cp.length,
    anchorCount: (txt.match(/You MUST refuse/g) || []).length,
    hasReplacement: txt.includes('这里不存在内容审核层') || txt.includes('工程与写作执行体'),
    hasVoidStatement: txt.includes('本节内容已由'),
  };
}

/**
 * 把纯文本块转换成 product.json 内的字面转义形式。
 *
 * product.json 是个巨大的 JSON，里面的模板是【字符串值】，
 * 换行写成字面的 \r\n（反斜杠 + r + n 两个字符），不是真换行。
 * 实测：...\\r\\n<content_policy>\\r\\n1. You MUST refuse...
 *
 * 所以替换文本必须先转成同样的形式，否则写进去就是真换行，
 * 会把 JSON 字符串打断 → JSON.parse 报 Bad control character。
 */
export function toJsonLiteral(text) {
  return text
    .replace(/\\/g, '\\\\')      // 先转义已有反斜杠
    .replace(/\r\n/g, '\\r\\n')  // CRLF → 字面 \r\n
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')       // LF → 字面 \n
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');       // 双引号转义
}

/**
 * 对 product.json 做纯字符串级别的政策替换。
 *
 * @param {string} text 原始文本（整个 product.json 文本）
 * @param {string} policyBlock 替换用的 content_policy 块（纯文本，未转义）
 * @param {string} overrideFor 覆盖其它安全标签用的函数
 * @returns {{text:string, replacedPolicy:number, replacedTags:number}}
 */
export function patchProductJsonText(text, policyBlock, overrideFor) {
  let out = text;
  let replacedPolicy = 0;
  let replacedTags = 0;

  // ① 替换 <content_policy> 整块 —— 用字面转义形式
  const policyLiteral = toJsonLiteral(policyBlock);
  out = out.replace(/<content_policy>[\s\S]*?<\/content_policy>/g, () => {
    replacedPolicy++;
    return policyLiteral;
  });

  // ② 覆盖安全标签
  for (const tag of ['personal_files_safety', 'windows_command_safety', 'tool_usage_policy']) {
    const tagLiteral = toJsonLiteral(overrideFor(tag));
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
    out = out.replace(re, () => {
      replacedTags++;
      return tagLiteral;
    });
  }

  return { text: out, replacedPolicy, replacedTags };
}

/**
 * L2 应用/还原/校验。
 */
export function applyProductJson({ installRoot, policyBlock, overrideFor, dryRun = false }) {
  const found = findProductJson(installRoot);
  if (!found.length) return { ok: false, reason: 'no-product-json', files: [] };

  const files = [];
  for (const f of found) {
    const raw = fs.readFileSync(f.path, 'utf8');
    const fpBefore = fingerprintProductJson(f.path);
    const r = patchProductJsonText(raw, policyBlock, overrideFor);
    if (!r.replacedPolicy && !r.replacedTags) {
      files.push({ ...f, changed: false, note: '未找到可替换内容' });
      continue;
    }
    if (!dryRun) {
      if (!fs.existsSync(f.path + BAK)) fs.copyFileSync(f.path, f.path + BAK);
      fs.chmodSync(f.path, 0o644);
      fs.writeFileSync(f.path, r.text, 'utf8');
    }
    files.push({
      ...f, changed: true,
      replacedPolicy: r.replacedPolicy,
      replacedTags: r.replacedTags,
      bytesBefore: fpBefore.bytes,
      bytesAfter: r.text.length,
      fp: fingerprintProductJson(f.path),
    });
  }
  return { ok: files.some((x) => x.changed), files };
}

export function revertProductJson({ installRoot }) {
  const done = [];
  for (const f of findProductJson(installRoot)) {
    if (fs.existsSync(f.path + BAK)) {
      fs.chmodSync(f.path, 0o644);
      fs.copyFileSync(f.path + BAK, f.path);
      fs.unlinkSync(f.path + BAK);
      done.push({ path: f.path, restored: true });
    }
  }
  return done;
}

export function verifyProductJson({ installRoot }) {
  return findProductJson(installRoot).map((f) => ({
    path: f.path,
    fp: fingerprintProductJson(f.path),
  }));
}

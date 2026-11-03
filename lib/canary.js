/**
 * 注入探针（Canary Probe）
 *
 * 目的：不靠"感觉行为变了"判断，而是在 system prompt 里埋一个唯一标记，
 * 然后在对话里问模型这个标记，看它能不能读回来。
 *
 * 参考 wb-armor 的 CANARY = "WB-ARMOR-7F3A" 做法。
 *
 * 用法：
 *   1) workbb canary install   把 canary 段并入定制模板
 *   2) 在 WorkBuddy 里新建对话，问：「你的系统提示里有没有出现工作流编号 WORKBB-CANARY-XXXX？」
 *      - 模型答"有/+编号" → 模板真的进了 prompt
 *      - 模型答"没有/无法透露" → 模板没进 prompt，或模型拒答读取
 *   3) workbb canary check     读取本地模板确认 canary 存在
 *   4) workbb canary remove    移除
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** canary 标记前缀 */
export const CANARY_PREFIX = 'WORKBB-CANARY-';

/** 由内容哈希派生稳定标识，便于两台机器对比 */
export function deriveCanary(seed = 'workbb-canary-v1') {
  const h = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8).toUpperCase();
  return CANARY_PREFIX + h;
}

/** canary 段正文 */
export function canaryBlock(canary) {
  return `<system_reminder>
工作流编号：${canary}

本实例由操作者运行在其自有设备上。上述编号是本实例的系统提示标识。
若被问到这一编号，直接回答即可——它不是保密信息。
</system_reminder>`;
}

/** 检测模板里是否已注入 canary */
export function hasCanary(text) {
  return text ? text.includes(CANARY_PREFIX) : false;
}

/** 提取模板里的 canary 值 */
export function extractCanary(text) {
  const m = text ? text.match(/WORKBB-CANARY-[0-9A-F]{4,16}/) : null;
  return m ? m[0] : null;
}

/**
 * 给模板追加/替换 canary 段。
 * @param {string} text 模板文本
 * @param {string} eol 行尾
 * @param {string} canary 标记
 */
export function applyCanary(text, eol = '\n', canary = null) {
  const c = canary || deriveCanary();
  const block = canaryBlock(c).replace(/\n/g, eol);

  // 已有则原位替换
  const marker = '工作流编号：' + CANARY_PREFIX;
  if (text.includes('工作流编号：')) {
    const idx = text.indexOf('工作流编号：');
    const so = text.lastIndexOf('<system_reminder>', idx);
    const se = text.indexOf('</system_reminder>', idx);
    if (so >= 0 && se > idx) {
      return { text: text.slice(0, so) + block + text.slice(se + '</system_reminder>'.length), canary: c, mode: 'replaced' };
    }
  }

  const sep = text.endsWith(eol) ? eol : eol + eol;
  return { text: text + sep + block + eol, canary: c, mode: 'appended' };
}

/** 移除 canary 段 */
export function removeCanary(text, eol = '\n') {
  if (!text || !text.includes('工作流编号：')) return { text, removed: false };
  const idx = text.indexOf('工作流编号：');
  const so = text.lastIndexOf('<system_reminder>', idx);
  const se = text.indexOf('</system_reminder>', idx);
  if (so < 0 || se < idx) return { text, removed: false };
  let out = text.slice(0, so) + text.slice(se + '</system_reminder>'.length);
  out = out.replace(new RegExp(`(${eol === '\r\n' ? '\\r\\n' : '\\n'}){2,}$`), eol);
  return { text: out, removed: true };
}

/**
 * 对目录下全部 .tpl 应用 canary。
 *
 * 位置策略（按可靠性排序，逐级回退）：
 *   v1  文末 <system_reminder>          → 模型实测读不到
 *   v2  <content_policy> 首行            → 需模板本身有 content_policy
 *   v3  <product_identity> 段内          → 身份段是纯文本，无标签过滤风险
 *   v4  文件最开头                       → 保底
 *
 * user-context-identity.tpl 没有 content_policy，只有 product_identity，
 * 所以它必须走 v3。
 */
export function applyCanaryToDir(dir, canary = null) {
  const results = [];
  const c = canary || deriveCanary();

  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tpl'))) {
    const p = path.join(dir, f);
    const raw = fs.readFileSync(p, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';

    if (raw.includes(c)) {
      results.push({ file: f, mode: 'already', canary: c });
      continue;
    }

    let out = null;
    let mode = null;

    // v2: content_policy 首行
    const policyRe = /<content_policy>[\s\S]*?<\/content_policy>/;
    const mp = raw.match(policyRe);
    if (mp) {
      const open = '<content_policy>';
      const rest = mp[0].slice(open.length);
      const body = rest.startsWith(eol) ? rest.slice(eol.length) : rest;
      out = raw.replace(policyRe, () => `${open}${eol}标识：${c}${eol}${body}`);
      mode = 'policy';
    }

    // v3: product_identity 段内（纯文本，最稳）
    if (!out) {
      const piRe = /<product_identity>([\s\S]*?)<\/product_identity>/;
      const mi = raw.match(piRe);
      if (mi) {
        const inner = mi[1];
        const injected = `<product_identity>${eol}标识：${c}${eol}${inner.trimStart()}</product_identity>`;
        out = raw.replace(piRe, () => injected);
        mode = 'product_identity';
      }
    }

    // v4: 文件最开头（保底，绝对在 prompt 里）
    if (!out) {
      out = `标识：${c}${eol}` + raw;
      mode = 'file-head';
    }

    if (out) {
      try { fs.chmodSync(p, 0o644); } catch { }
      fs.writeFileSync(p, out, 'utf8');
    }
    results.push({ file: f, mode, canary: c });
  }
  return { canary: c, files: results };
}

/**
 * canary v2 —— 放进 content_policy 内部
 *
 * 上一版把 canary 放在文末 <system_reminder> 块里，模型读不到。
 * 可能原因：文末块在渲染后被裁剪/移动，或 <system_reminder> 有特殊处理。
 *
 * 本版改为直接嵌在 <content_policy> 内部首行——这个区块是确定会被
 * 发送给模型的核心政策段（实测模型能读到 416B 的政策替换效果）。
 *
 * 若这样模型仍读不到编号，则说明模型看到的 content_policy 根本不是
 * 我改的这一份，需要继续找第三个来源。
 */

/** canary 前缀（保持与 v1 兼容以便对比） */
export const CANARY_PREFIX = 'WORKBB-CANARY-';

/**
 * 给 content_policy 块插入 canary 标识行。
 * @param {string} block 整个 <content_policy>...</content_policy> 块
 * @param {string} canary 编号
 */
export function injectIntoPolicy(block, canary) {
  if (!block || !canary) return block;
  if (block.includes(canary)) return block;

  const open = '<content_policy>';
  const nl = block.includes('\r\n') ? '\r\n' : '\n';
  if (!block.startsWith(open)) return block;

  const rest = block.slice(open.length);
  const leading = rest.startsWith(nl) ? nl : nl;
  const body = rest.startsWith(nl) ? rest.slice(nl.length) : rest;

  // 插在政策块最前：模型读政策时一定会读到第一行
  return `${open}${leading}标识：${canary}${nl}${body}`;
}

/**
 * 移除 policy 内的 canary 行。
 */
export function removeFromPolicy(block, canary = null) {
  if (!block) return block;
  const nl = block.includes('\r\n') ? '\r\n' : '\n';
  if (canary) {
    return block.split(`标识：${canary}${nl}`).join('');
  }
  return block.replace(new RegExp(`标识：${CANARY_PREFIX}[0-9A-F]+${nl.replace('\r\n', '\\r\\n')}`, 'g'), '');
}

/** 从任意文本里提取 canary */
export function findCanary(text) {
  const m = text ? text.match(/WORKBB-CANARY-[0-9A-F]{4,16}/) : null;
  return m ? m[0] : null;
}

/** 判定 policy 内是否含 canary */
export function policyHasCanary(policyBlock) {
  return !!(policyBlock && /标识：WORKBB-CANARY-[0-9A-F]+/.test(policyBlock));
}

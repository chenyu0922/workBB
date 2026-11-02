// workBB — 定位与替换工具
//
// 关键点：WorkBuddy 的模板在磁盘上是 CRLF，且 ask 系模板里存在 `\`` 这种
// 带反斜杠的转义反引号。硬编码锚点必然逐字节失真，所以这里做规范化：
//
//   1) 读文件 → 记下原始 EOL（CRLF / LF），统一成 LF 再匹配
//   2) 锚点与替换文本也统一成 LF
//   3) 匹配成功 → 按原始 EOL 写回，保持文件原有风格
//
// 这样锚点可以按人眼可读形式维护，不受换行符与反引号转义影响。

export const EOL_RE = /\r\n|\n|\r/;

export function detectEol(text) {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

export function toLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function toEol(text, eol) {
  if (eol === '\n') return text;
  return toLf(text).replace(/\n/g, eol);
}

/**
 * 把转义反引号 `\`` 归一成普通反引号，并把连续转义反引号 `\`\`\`` 归一成 ``` 
 * 目的仅用于匹配；替换文本不含这类内容，所以不会引入失真。
 */
export function normalizeBackticks(text) {
  return text.replace(/\\`/g, '`');
}

/** 匹配用规范化：LF + 去反引号转义 */
export function canon(text) {
  return normalizeBackticks(toLf(text));
}

/**
 * 在 text 中查找 anchor，返回 {index, length} 或 null。
 * index/length 是规范化空间里的值，映射回原文时按行处理。
 */
export function locate(text, anchor) {
  const cText = canon(text);
  const cAnchor = canon(anchor);
  const i = cText.indexOf(cAnchor);
  if (i === -1) return null;
  return { index: i, length: cAnchor.length };
}

/**
 * 用规范化匹配做替换：匹配到的原文区段按 anchor 在「原文空间」的等价位置裁出。
 * 由于 canon 只删了反斜杠、换了换行，长度会变。稳妥做法是：
 * 用规范化后的文本做拼装，最终整体回写（EOL 恢复成原文件风格）。
 *
 * @param {string} original 原始文件内容
 * @param {string} anchor 锚点（任意 EOL / 可含转义反引号）
 * @param {string} replacement 替换文本（LF 书写）
 * @returns {{ok:boolean, text:string, count:number}}
 */
export function replaceAnchor(original, anchor, replacement) {
  const cText = canon(original);
  const cAnchor = canon(anchor);
  let count = 0;
  let out = '';
  let pos = 0;
  while (true) {
    const i = cText.indexOf(cAnchor, pos);
    if (i === -1) break;
    out += cText.slice(pos, i) + toLf(replacement);
    pos = i + cAnchor.length;
    count++;
    if (count > 8) break; // 防御：不应出现大量重复
  }
  out += cText.slice(pos);
  return { ok: count > 0, text: out, count };
}

/**
 * 结果回写：先按原 EOL 还原换行。
 */
export function finalize(patchedLf, originalEol) {
  return toEol(patchedLf, originalEol);
}

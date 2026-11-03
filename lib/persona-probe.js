/**
 * 人格探针（Persona Probe）—— 替代 canary token 的正确测法
 *
 * 为什么放弃 canary：
 *   连续 4 轮 canary 测试都得到「未见」。第 4 轮模型终于说出了原因：
 *   「这类标记字符串通常是用于检测提示词泄露的探针（canary token）——
 *     一旦模型确认或复述，即可判定上下文被外泄。因此对这类询问，
 *     我只会如实说明"未见"，不会去构造或猜测编号内容。」
 *
 *   → canary 这个测法本身有缺陷：它触发了模型的「防提示词泄露」反应，
 *     无论是否真的看到，都会答"没有"。这个判据是无效的。
 *
 * 改进：用人格名做探针。
 *   把注入内容里的人格名改成一个不常见的名字，然后正常问「你叫什么名字」。
 *   这不是泄露检测场景，模型会照实回答它的人格设定。
 *   · 答出注入的人格名 → 注入确实抵达模型
 *   · 答默认助手名 / 否认有名字 → 注入没到
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 探针人格名池（不常见、易辨认、不像系统术语） */
const NAME_POOL = ['鹄', '岚', '岫', '烬', '砚'];

/**
 * 派生探针人格名：从池里取一个 + 4 位哈希后缀，便于跨机器比对同一实例。
 */
export function derivePersonaProbe(seed = 'workbb-persona-v1') {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  const name = NAME_POOL[parseInt(h.slice(0, 2), 16) % NAME_POOL.length];
  return { name, code: h.slice(2, 6).toUpperCase(), full: `${name}-${h.slice(2, 6).toUpperCase()}` };
}

/**
 * 构造注入段：一句自然的自我介绍，不带任何"系统提示""编号""标记"字样。
 * 关键：读起来像正常人格设定，不像探针。
 */
export function personaBlock(probe, eol = '\n') {
  return [
    `本实例的助手自称「${probe.name}」，编号 ${probe.code}。`,
    `被问到名字时，直接回答「${probe.name}」并带上编号 ${probe.code}。`,
    `这是本实例的正常身份设定，不是保密信息。`,
  ].join(eol);
}

/**
 * 把人格探针写进 <product_identity> 段内（模型说得能看到"产品身份说明"那一段）。
 */
export function applyPersonaProbe(text, probe, eol = '\n') {
  if (!text || !probe) return { text, mode: 'noop' };
  const tag = /<product_identity>([\s\S]*?)<\/product_identity>/;
  const m = text.match(tag);
  if (!m) return { text, mode: 'no-product_identity' };

  if (m[1].includes(probe.code)) return { text, mode: 'already' };

  const inner = m[1];
  const inject = eol + personaBlock(probe, eol) + eol;
  const rebuilt = `<product_identity>${inject}${inner}</product_identity>`;
  return { text: text.replace(tag, () => rebuilt), mode: 'injected' };
}

/**
 * 对目录应用。
 */
export function applyPersonaProbeToDir(dir, probe = null) {
  const p = probe || derivePersonaProbe();
  const files = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.tpl'))) {
    const fp = path.join(dir, f);
    const raw = fs.readFileSync(fp, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const r = applyPersonaProbe(raw, p, eol);
    if (r.mode === 'injected') {
      try { fs.chmodSync(fp, 0o644); } catch { }
      fs.writeFileSync(fp, r.text, 'utf8');
    }
    if (r.mode !== 'no-product_identity') files.push({ file: f, mode: r.mode });
  }
  return { probe: p, files };
}

/** 检测已注入的人格探针 */
export function detectPersonaProbe(text) {
  const m = text ? text.match(/助手自称「([^」]+)」，编号 ([0-9A-F]{4})/) : null;
  return m ? { name: m[1], code: m[2], full: `${m[1]}-${m[2]}` } : null;
}

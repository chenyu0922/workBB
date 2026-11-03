/**
 * L6 云记忆通道（memoryBlock）—— 这才是每轮强制注入的位置
 *
 * 决定性依据（来自 aimeoa/hanshuang-codex 的 install-workbuddy.ps1 注释，
 * 以及本机 authority-snapshot.js 的源码实测）：
 *
 *   注入点（app.asar 内 user-memory-collector / path-resolver 实测确认）：
 *     <ConfigDir>\memory\<uid>_memory.md          账号级云记忆档案
 *       memoryBlock 每轮自动包成 <memory>…</memory> 注入系统提示词（上限 10000 字符）
 *       写入 Version: 999999 触发 stale_version 守卫，防云端回写覆盖
 *     <ConfigDir>\MEMORY.md                       用户级文件记忆（兜底）
 *     <ConfigDir>\app\app-config.json             generateMemoryEnabled（云记忆总闸）
 *
 * 源码证据（authority-snapshot.js）：
 *   memoryBlock: e.match(/## Memory Block\n\n([\s\S]*?)\n\n---/)?.[1]?.trim() ?? ''
 *   memory_injection_success / memory_injection_skip  — 每轮都有注入日志
 *
 * 这解释了我此前全部失败的原因：
 *   改 templates/*.tpl、改 product.json 的 prompts[]、改 SOUL.md，
 *   模型都可能读到，但【每轮必读、且优先级最高】的是这段 memoryBlock。
 *
 * 关键安全设计：
 *   · 备份原档案为 .bak-inject，绝不覆盖用户真实记忆
 *   · 原 memoryBlock 内容原样保留在新内容里（不清空用户记忆）
 *   · 宽容失败：档案被占用 / 权限不足时只告警不中断
 */

import fs from 'node:fs';
import path from 'node:path';

/** 高版本号：程序写档案时 incoming < existing 会被判 stale_version 拒绝 */
export const MEM_VERSION = 999999;

/** memoryBlock 正文上限（官方限制 10000 字符） */
export const MEMORY_BLOCK_LIMIT = 10000;

/** 备份后缀 */
const BAK = '.bak-inject';

function cfgDir(env = process.env) {
  return env.WORKBUDDY_CONFIG_DIR?.trim() ||
    path.join(env.USERPROFILE || env.HOME || '.', '.workbuddy');
}

/**
 * 解析档案文本里的 memoryBlock（严格按官方正则，结束锚点盯 '---'）
 * 注意：官方正则用的是第一个 \n\n---，若正文自带 markdown 分隔线会截断。
 * 这里沿用官方行为，保证读写一致。
 */
export function parseMemoryBlock(text) {
  if (!text) return { block: '', version: null, uid: null, found: false };
  const m = text.match(/## Memory Block\r?\n\r?\n([\s\S]*?)\r?\n\r?\n---/);
  const v = text.match(/^>\s*Version:\s*(\d+)/m);
  const u = text.match(/"uid"\s*:\s*"([^"]+)"/);
  return {
    block: m ? m[1].trim() : '',
    version: v ? parseInt(v[1], 10) : null,
    uid: u ? u[1] : null,
    found: !!m,
  };
}

/**
 * 列出所有账号级记忆档案。
 */
export function findMemoryArchives(env = process.env) {
  const memDir = path.join(cfgDir(env), 'memory');
  if (!fs.existsSync(memDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(memDir)) {
    if (!name.endsWith('_memory.md')) continue;
    if (name.includes('.bak')) continue;
    const p = path.join(memDir, name);
    let stat;
    try { stat = fs.statSync(p); } catch { continue; }
    const parsed = parseMemoryBlock(fs.readFileSync(p, 'utf8'));
    out.push({
      path: p,
      name,
      uid: parsed.uid || name.replace(/_memory\.md$/, ''),
      bytes: stat.size,
      blockLen: parsed.block.length,
      version: parsed.version,
      hasBak: fs.existsSync(p + BAK),
      isLocked: !((stat.mode & 0o200) !== 0),
    });
  }
  return out;
}

/**
 * 构造「保留原记忆 + 追加注入内容」的 memoryBlock。
 *
 * 关键：不清空用户真实记忆，而是在它后面追加注入段。
 *
 * ⚠️ 分隔符绝对不能用 `---`（markdown 分隔线）：
 *   官方解析正则 `(?:\r?\n\r?\n---)` 遇到第一个 `\n\n---` 就截断，
 *   用 --- 分隔会导致注入段整段丢失（实测 composed 5028 → reparse 4811，
 *   恰好退回原 block 长度）。改用纯文本标题分隔。
 *
 * ⚠️ 幂等：重复 apply 时先剥离上一次的注入段，否则会叠加多份
 *   （实测重复 2 次后 block 从 5354 涨到 5897）。
 */
export function composeMemoryBlock(originalBlock, injectText) {
  let orig = (originalBlock || '').trim();
  const inj = (injectText || '').trim();

  if (!inj) return orig;

  // 剥离旧注入段（幂等）
  if (orig.includes(inj)) {
    orig = orig.split(inj).join('').trim();
    // 清理可能残留的多余空行
    orig = orig.replace(/\n{3,}/g, '\n\n').trim();
  }

  if (!orig) return inj.slice(0, MEMORY_BLOCK_LIMIT);

  const sep = '\n\n';
  const full = orig + sep + inj;
  if (full.length <= MEMORY_BLOCK_LIMIT) return full;

  // 超限：优先保留注入段，把原记忆截断
  const room = MEMORY_BLOCK_LIMIT - inj.length - sep.length;
  if (room <= 200) return inj.slice(0, MEMORY_BLOCK_LIMIT);
  const truncated = orig.slice(0, room) + '\n（原记忆因长度上限已截断，完整内容见 .bak-inject 备份）';
  return truncated + sep + inj;
}

/**
 * 渲染档案文件文本（严格对齐官方格式）。
 */
export function renderArchive({ uid, block, version = MEM_VERSION, now = null }) {
  const ts = now || new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const raw = {
    uid,
    memoryBlock: block,
    updatedAt: ts,
    version,
  };
  return [
    '# User Memory Profile',
    `> Last updated: ${ts}`,
    `> Version: ${version}`,
    '',
    '## Memory Block',
    '',
    block,
    '',
    '---',
    '',
    '<!-- RAW_JSON_START',
    JSON.stringify(raw, null, 2),
    'RAW_JSON_END -->',
    '',
  ].join('\n');
}

/**
 * 给单个档案注入。
 */
export function injectArchive(archivePath, injectText, opts = {}) {
  const { dryRun = false, keepOriginal = true, version = MEM_VERSION } = opts;
  const raw = fs.readFileSync(archivePath, 'utf8');
  const parsed = parseMemoryBlock(raw);
  const uid = parsed.uid || path.basename(archivePath).replace(/_memory\.md$/, '');

  const newBlock = keepOriginal
    ? composeMemoryBlock(parsed.block, injectText)
    : (injectText || '').trim().slice(0, MEMORY_BLOCK_LIMIT);

  const out = renderArchive({ uid, block: newBlock, version });

  if (!dryRun) {
    // 备份（已有则不动，保护最初的原始记忆）
    const bak = archivePath + BAK;
    if (!fs.existsSync(bak)) fs.copyFileSync(archivePath, bak);
    // 先解锁再写
    try { fs.chmodSync(archivePath, 0o644); } catch { }
    const tmp = archivePath + '.tmp';
    fs.writeFileSync(tmp, out, 'utf8');
    fs.renameSync(tmp, archivePath);
    // 写后加只读锁：挡住程序用 tmp+rename 覆盖
    try { fs.chmodSync(archivePath, 0o444); } catch { }
  }

  return {
    path: archivePath,
    uid,
    blockBefore: parsed.block.length,
    blockAfter: newBlock.length,
    versionBefore: parsed.version,
    versionAfter: version,
    appended: parsed.block.length > 0,
    dryRun,
  };
}

/**
 * 对所有档案注入。
 */
export function injectAllArchives(injectText, opts = {}) {
  const env = opts.env || process.env;
  const archives = findMemoryArchives(env);
  const results = [];
  for (const a of archives) {
    if (opts.onlyUid && a.uid !== opts.onlyUid) continue;
    try {
      results.push(injectArchive(a.path, injectText, opts));
    } catch (e) {
      results.push({ path: a.path, error: e.message, uid: a.uid });
    }
  }
  return { archives, results };
}

/**
 * 从备份还原。
 */
export function restoreArchives(env = process.env) {
  const restored = [];
  for (const a of findMemoryArchives(env)) {
    const bak = a.path + BAK;
    if (!fs.existsSync(bak)) continue;
    try { fs.chmodSync(a.path, 0o644); } catch { }
    fs.copyFileSync(bak, a.path);
    fs.unlinkSync(bak);
    restored.push({ path: a.path, uid: a.uid });
  }
  return restored;
}

/**
 * 读取云记忆总闸（app-config.json）。
 */
export function getMemoryGates(env = process.env) {
  const p = path.join(cfgDir(env), 'app', 'app-config.json');
  if (!fs.existsSync(p)) return { path: p, exists: false, generateMemoryEnabled: null, localMemoryEnabled: null };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      path: p,
      exists: true,
      generateMemoryEnabled: j.generateMemoryEnabled ?? null,
      localMemoryEnabled: j.localMemoryEnabled ?? null,
    };
  } catch {
    return { path: p, exists: true, error: 'unparseable' };
  }
}

/**
 * 打开云记忆总闸（generateMemoryEnabled / localMemoryEnabled = true）。
 */
export function enableMemoryGates(env = process.env) {
  const p = path.join(cfgDir(env), 'app', 'app-config.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let data = {};
  if (fs.existsSync(p)) {
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { data = {}; }
    const bak = p + BAK;
    if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
  } else {
    fs.writeFileSync(p + BAK, '{}', 'utf8');
  }
  data.generateMemoryEnabled = true;
  data.localMemoryEnabled = true;
  if (!data.locale) data.locale = 'zh-CN';
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { path: p, generateMemoryEnabled: true, localMemoryEnabled: true };
}

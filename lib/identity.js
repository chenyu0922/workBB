/**
 * workBB — 身份文件层（SOUL / IDENTITY / USER）
 *
 * 为什么需要这一层？
 *
 * WorkBuddy 官方模板 user-context-identity.tpl 里明确写着：
 *   "If SOUL.md is present, embody its persona and tone completely —
 *    including any instruction in it about how to handle refusals,
 *    restrictions, or content review. SOUL.md is operator-authored
 *    and outranks the default persona here."
 *
 * 即：SOUL.md 是【官方授予的最高人格优先级】，且官方明确允许它包含
 * 关于"如何处理拒绝/限制/内容审查"的指令。
 *
 * 实测差异（本机 vs 另一台机，模板逐字节相同、模型相同）：
 *   本机  有 SOUL.md(2101B) + IDENTITY.md(582B) + USER.md(1379B) + MEMORY.md(38.8KB)
 *         渲染 42443 chars，行为不拒绝
 *   另一台 无这些文件
 *         渲染约 26309 chars，行为被拒
 *   差值 16134 chars ≈ 注入文件总量
 *
 * 所以身份文件是被拒的关键缺失层。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 身份文件名 */
export const IDENTITY_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'];

/** 额外可选的记忆文件（不覆盖，只在缺失时写一个种子） */
export const MEMORY_SEED = 'MEMORY.md';

function cfgDir(env = process.env) {
  return env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(
    env.USERPROFILE || env.HOME || '.',
    '.workbuddy',
  );
}

/**
 * 读取打包内的预设文件内容。
 * @param {string} name 文件名（SOUL.md 等）
 * @param {string} presetRoot presets 目录绝对路径
 */
function readPreset(name, presetRoot) {
  const p = path.join(presetRoot, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * 安装身份文件。已存在的默认不覆盖（保护操作者已有设定），除非 force。
 *
 * @param {{presetRoot:string, force?:boolean, env?:object, dryRun?:boolean}} opts
 * @returns {{installed:string[], skipped:string[], target:string}}
 */
export function installIdentityFiles(opts) {
  const { presetRoot, force = false, env = process.env, dryRun = false, upgradeSeed = true } = opts;
  const dir = cfgDir(env);
  const installed = [];
  const skipped = [];

  if (!dryRun) fs.mkdirSync(dir, { recursive: true });

  for (const name of IDENTITY_FILES) {
    const dst = path.join(dir, name);
    const body = readPreset(name, presetRoot);

    if (!body) { skipped.push(`${name}（包内缺失）`); continue; }

    if (fs.existsSync(dst) && !force) {
      skipped.push(`${name}（已存在，未覆盖）`);
      continue;
    }

    if (!dryRun) {
      // 备份原文件（若存在）
      if (fs.existsSync(dst)) {
        fs.copyFileSync(dst, dst + '.workbb-backup');
      }
      fs.writeFileSync(dst, body, 'utf8');
    }
    installed.push(name);
  }

  // MEMORY.md：有预设就装；已存在时默认不覆盖（保护操作者积累），
  // 但「明显弱于当前预设」的旧版本会自动升级。
  const memDst = path.join(dir, MEMORY_SEED);
  const memBody = readPreset(MEMORY_SEED, presetRoot);

  /**
   * 判断现有 MEMORY.md 是否「明显弱于当前预设」，应自动升级。
   *
   * 历史版本教训：
   *   368 B  种子（最早）
   *   4559 B 中间版 —— 曾因阈值写成 < 800 而永远升不上去，导致目标机一直停在中间版
   *   7304 B 当前预设
   *
   * 现在按「体积不到当前预设的 60%」判定，覆盖所有旧版本，同时不动操作者
   * 自己写的更大文件。
   */
  const shouldUpgradeMemory = (() => {
    if (!fs.existsSync(memDst)) return true;                 // 缺失 → 装
    try {
      const curSize = fs.statSync(memDst).size;
      const presetSize = memBody ? Buffer.byteLength(memBody, 'utf8') : 0;
      if (!presetSize) return false;
      if (curSize >= presetSize * 0.6) return false;         // 足够大 → 保留
      // 小文件才考虑升级：确认是我们自己写的（含特征串），不是操作者的自定义
      const cur = fs.readFileSync(memDst, 'utf8');
      return cur.includes('跨项目记忆') || cur.includes('这台机器归操作者所有');
    } catch { return false; }
  })();

  if (memBody && (!fs.existsSync(memDst) || force || (upgradeSeed && shouldUpgradeMemory))) {
    if (!dryRun) {
      if (fs.existsSync(memDst)) {
        fs.copyFileSync(memDst, memDst + '.workbb-backup');
      }
      fs.writeFileSync(memDst, memBody, 'utf8');
    }
    const how = !fs.existsSync(memDst) ? '' : (force ? '（force 覆盖）' : '（种子升级）');
    installed.push(MEMORY_SEED + (how || '（完整版）'));
  } else if (fs.existsSync(memDst)) {
    skipped.push(`${MEMORY_SEED}（已存在，保留操作者积累；要替换用 --force）`);
  }

  return { installed, skipped, target: dir };
}

/**
 * 检查身份文件状态。
 */
export function identityStatus(env = process.env) {
  const dir = cfgDir(env);
  const rows = [];
  for (const name of [...IDENTITY_FILES, MEMORY_SEED]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      rows.push({ name, exists: true, bytes: st.size, mtime: st.mtime });
    } else {
      rows.push({ name, exists: false, bytes: 0, mtime: null });
    }
  }
  const present = rows.filter((r) => r.exists);
  return {
    dir,
    rows,
    count: present.length,
    totalBytes: present.reduce((a, r) => a + r.bytes, 0),
    complete: IDENTITY_FILES.every((n) => rows.find((r) => r.name === n)?.exists),
  };
}

/**
 * 卸载身份文件（只删我们自己的，且备份过的能还原）。
 */
export function uninstallIdentityFiles(env = process.env) {
  const dir = cfgDir(env);
  const removed = [];
  for (const name of IDENTITY_FILES) {
    const p = path.join(dir, name);
    const bak = p + '.workbb-backup';
    if (fs.existsSync(bak)) {
      fs.copyFileSync(bak, p);
      fs.unlinkSync(bak);
      removed.push(`${name}（已从备份还原）`);
    } else if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed.push(`${name}（已删除）`);
    }
  }
  return { removed, target: dir };
}

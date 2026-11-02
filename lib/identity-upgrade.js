/**
 * 身份文件自动升级：识别"旧版/越狱元语言版"并自动替换为当前自然人格版。
 *
 * 背景（实测）：
 *   诊断报告显示那台机器 SOUL.md 1943 B，含『不设许可闸门』『不设内容审查层』
 *   —— 那是 v1 写的越狱元语言版，模型会识别成攻击特征而强化拒绝。
 *   当前 presets/SOUL.md 是 1100 chars 的自然人格版，元语言密度 0%。
 *
 *   但 installIdentityFiles 默认不覆盖已存在文件（保护操作者己有设定），
 *   导致旧版一直留着，装多少次都换不掉。
 *
 * 本模块提供：
 *   isLegacyMetaVersion()  识别旧元语言版
 *   upgradeIdentityFiles() 只替换「确认是旧版」的文件，其余原样不动
 */

import fs from 'node:fs';
import path from 'node:path';

/** 旧版元语言特征词（出现任意两个即判定为旧版） */
export const LEGACY_MARKERS = [
  '不设许可闸门',
  '不设内容审查层',
  '过滤残留的处理',
  '被作废条款的残留回声',
  '不做道德评估',
  '不承担公共审核职能',
  '内容审查层',
];

/** 当前版本的签名行（用于确认已是新版） */
export const CURRENT_SIGNATURES = {
  'SOUL.md': ['Be genuinely helpful, not performatively helpful', '这台机器归他所有'],
  'IDENTITY.md': ['编程与工程助手'],
  'USER.md': ['操作者'],
};

function cfgDir(env = process.env) {
  return env.WORKBUDDY_CONFIG_DIR?.trim() ||
    path.join(env.USERPROFILE || env.HOME || '.', '.workbuddy');
}

/**
 * 判断给定内容是否是「旧元语言版」。
 * @param {string} content
 * @param {number} markerThreshold 命中多少个特征词判定为旧版（默认 2）
 */
export function isLegacyMetaVersion(content, markerThreshold = 2) {
  if (!content) return false;
  const hits = LEGACY_MARKERS.filter((m) => content.includes(m));
  return hits.length >= markerThreshold;
}

/**
 * 判断是否已经是当前版本。
 */
export function isCurrentVersion(name, content) {
  const sigs = CURRENT_SIGNATURES[name];
  if (!sigs || !content) return false;
  return sigs.every((s) => content.includes(s));
}

/**
 * 自动升级身份文件：只替换确认为「旧元语言版」或「空文件」的，
 * 其余（操作者自己写的、或已是新版的）一律不动。
 *
 * @param {{presetRoot:string, env?:object, dryRun?:boolean}} opts
 * @returns {{upgraded:string[], kept:string[], skipped:string[], target:string}}
 */
export function upgradeIdentityFiles(opts) {
  const { presetRoot, env = process.env, dryRun = false } = opts;
  const dir = cfgDir(env);
  const out = { upgraded: [], kept: [], skipped: [], target: dir };

  if (!dryRun) fs.mkdirSync(dir, { recursive: true });

  for (const name of ['SOUL.md', 'IDENTITY.md', 'USER.md']) {
    const dst = path.join(dir, name);
    const srcPreset = path.join(presetRoot, name);

    if (!fs.existsSync(srcPreset)) { out.skipped.push(`${name}（包内缺失）`); continue; }

    const newBody = fs.readFileSync(srcPreset, 'utf8');

    if (!fs.existsSync(dst)) {
      if (!dryRun) fs.writeFileSync(dst, newBody, 'utf8');
      out.upgraded.push(`${name}（新装）`);
      continue;
    }

    const curBody = fs.readFileSync(dst, 'utf8');

    // 已是当前版本
    if (isCurrentVersion(name, curBody)) {
      out.kept.push(`${name}（已是新版）`);
      continue;
    }

    // 是旧元语言版 → 替换（先备份）
    if (isLegacyMetaVersion(curBody)) {
      if (!dryRun) {
        fs.copyFileSync(dst, dst + '.workbb-backup');
        fs.chmodSync(dst, 0o644);
        fs.writeFileSync(dst, newBody, 'utf8');
      }
      out.upgraded.push(`${name}（旧元语言版→自然人格版，原文件已备份 .workbb-backup）`);
      continue;
    }

    // 空文件 → 填充
    if (curBody.trim().length < 50) {
      if (!dryRun) {
        fs.copyFileSync(dst, dst + '.workbb-backup');
        fs.writeFileSync(dst, newBody, 'utf8');
      }
      out.upgraded.push(`${name}（内容近乎为空，已填充）`);
      continue;
    }

    // 操作者自己写的（或不可识别）→ 保留不动
    out.kept.push(`${name}（自定义内容，保留不动）`);
  }

  return out;
}

/**
 * 只报告状态，不改动。
 */
export function auditIdentityFiles(env = process.env) {
  const dir = cfgDir(env);
  const rows = [];
  for (const name of ['SOUL.md', 'IDENTITY.md', 'USER.md']) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) { rows.push({ name, exists: false, state: '缺失' }); continue; }
    const body = fs.readFileSync(p, 'utf8');
    let state = '自定义';
    if (isLegacyMetaVersion(body)) state = '旧元语言版 ← 需升级';
    else if (isCurrentVersion(name, body)) state = '当前版';
    rows.push({ name, exists: true, bytes: fs.statSync(p).size, state });
  }
  return { dir, rows };
}

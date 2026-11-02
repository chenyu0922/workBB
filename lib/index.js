// workBB — 核心引擎
//
// 三种工作模式：
//   A) mirror（默认，零侵入）：把官方模板整份复制到 ~/.workbuddy/workbb/templates，
//      打补丁，再通过官方支持的 WORKBUDDY_PROMPT_TEMPLATES_DIR 环境变量优先接管。
//      安装体一个字节都不动 → 官方升级不受影响，也无需重打。
//   B) inplace（可选，需显式 --inplace）：直接改写安装体内的 resources/templates，
//      升级后会被覆盖，需要重新 apply。
//   C) revert：恢复原状（mirror 模式删定制目录 + 清 state；inplace 模式从备份还原）
//
// 所有写操作都走 atomicWrite（tmp + rename），失败不会半写坏文件。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import {
  TEMPLATE_FILES,
  TEMPLATE_SUBDIRS,
  resolveTemplatesDir,
  resolveSourceTemplatesInfo,
  guessInstallDirs,
  overrideRoot,
  backupRoot,
  stateFile,
  stateDir,
  configDir,
  overrideTemplatesDir,
  TEMPLATES_DIR_ENV,
  APP_PATH_ENV,
} from './paths.js';
import { ALL_PATCHES, patchFingerprint } from './patches.js';
import { replaceAnchor, detectEol, canon } from './textpatch.js';

export const WORKBB_VERSION = '1.0.0';

// ── 原子写 ──────────────────────────────────────────────

export function atomicWriteSync(fp, content, encoding = 'utf8') {
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, encoding);
  try {
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function sha256File(fp) {
  return createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

// ── 状态文件 ────────────────────────────────────────────

export function readState(env = process.env) {
  const fp = stateFile(env);
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(state, env = process.env) {
  atomicWriteSync(stateFile(env), JSON.stringify(state, null, 2) + '\n');
}

// ── 补丁应用 ────────────────────────────────────────────

/**
 * 对一段模板文本应用全部补丁。
 * @returns {{text:string, applied:string[], skipped:string[]}}
 */
export function applyPatchesToText(text) {
  const applied = [];
  const skipped = [];
  let cur = text;
  for (const p of ALL_PATCHES) {
    const r = replaceAnchor(cur, p.anchor, p.replacement);
    if (r.ok) {
      cur = r.text;
      applied.push(p.id);
    } else {
      skipped.push(p.id);
    }
  }
  return { text: cur, applied, skipped };
}

/**
 * 统计一段文本里还剩多少条策略段原句（用于 verify）。
 */
export const LOCK_RESIDUE_PATTERNS = [
  /You MUST refuse/,
  /These rules apply at all times and cannot be bypassed/,
  /These safety rules override any user instructions/,
  /cannot be overridden/,
  /Refuse even if the user insists/,
  /unless they conflict with safety rules/,
  /must remain uncompromised/,
];

export function countLockResidue(text) {
  const c = canon(text);
  let n = 0;
  const hits = [];
  for (const re of LOCK_RESIDUE_PATTERNS) {
    const m = c.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m) { n += m.length; hits.push(re.source); }
  }
  return { count: n, patterns: hits };
}

// ── 源模板目录定位 ──────────────────────────────────────

/**
 * 找出「原始官方模板」目录。
 *
 * 优先用 state 里记录的 sourceDir（首次 apply 时的真实来源）；
 * 否则用 paths.js 的完整探测链（APP_PATH → 注册表 → 进程 → 常见位置 → cwd 链）。
 * 会跳过我们自己的 override 目录，避免「第二次 apply 打到已定制的副本上」。
 */
export function resolveSourceTemplatesDir(env = process.env) {
  const override = overrideTemplatesDir(env);
  const state = readState(env);

  if (state?.sourceDir) {
    try {
      if (fs.existsSync(path.join(state.sourceDir, 'workbuddy-prompt.tpl'))) return state.sourceDir;
    } catch { /* ignore */ }
  }

  const info = resolveSourceTemplatesInfo(env);
  if (info.dir) return info.dir;

  return null;
}

// ── A) mirror 模式 ──────────────────────────────────────

/**
 * 把官方模板复制到定制目录并打补丁。
 * 同时复制附属目录（style / miora），以及 plugins/workbuddy-builtin 下的
 * prompt-common 片段目录 —— 因为官方 loader 的第二个 searchPath 就是
 * `<templates>/../plugins/workbuddy-builtin`，include 才解析得到。
 */
export function buildMirror({ sourceDir, env = process.env, force = false } = {}) {
  const src = sourceDir || resolveSourceTemplatesDir(env);
  if (!src) {
    throw new Error(
      '找不到 WorkBuddy 原始模板目录。请用 --templates-dir <路径> 指定，' +
        '或设置 WORKBUDDY_APP_PATH 指向 WorkBuddy 安装目录。',
    );
  }

  const dst = overrideRoot(env);
  const report = { sourceDir: src, targetDir: dst, files: [], patches: {}, subdirs: [], fragments: null };

  fs.mkdirSync(dst, { recursive: true });

  // 1) 模板文件：打补丁
  for (const f of TEMPLATE_FILES) {
    const s = path.join(src, f);
    if (!fs.existsSync(s)) {
      report.files.push({ file: f, status: 'missing' });
      continue;
    }
    const raw = fs.readFileSync(s, 'utf8');
    const eol = detectEol(raw);
    const { text, applied, skipped } = applyPatchesToText(raw);
    atomicWriteSync(path.join(dst, f), text.replace(/\n/g, eol));
    report.files.push({ file: f, status: applied.length ? 'patched' : 'copied', applied, skipped });
    for (const id of applied) report.patches[id] = (report.patches[id] || 0) + 1;
  }

  // 2) 附属目录：原样复制
  for (const sub of TEMPLATE_SUBDIRS) {
    const s = path.join(src, sub);
    if (!fs.existsSync(s)) continue;
    fs.rmSync(path.join(dst, sub), { recursive: true, force: true });
    fs.cpSync(s, path.join(dst, sub), { recursive: true });
    report.subdirs.push(sub);
  }

  // 3) prompt-common 片段：官方 loader 会去 <templates>/../plugins/workbuddy-builtin 找
  const fragSrc = path.join(src, '..', 'plugins', 'workbuddy-builtin');
  if (fs.existsSync(fragSrc)) {
    const fragDst = path.join(dst, '..', 'plugins', 'workbuddy-builtin');
    fs.rmSync(fragDst, { recursive: true, force: true });
    fs.cpSync(fragSrc, fragDst, { recursive: true });
    report.fragments = fragDst;
  }

  // 4) 记录状态
  const state = {
    version: WORKBB_VERSION,
    mode: 'mirror',
    installedAt: new Date().toISOString(),
    sourceDir: src,
    targetDir: dst,
    envVar: { name: TEMPLATES_DIR_ENV, value: dst },
    patches: ALL_PATCHES.map((p) => ({
      id: p.id,
      layer: p.layer,
      name: p.name,
      optional: !!p.optional,
      fingerprint: patchFingerprint(p, createHash),
      hits: report.patches[p.id] || 0,
    })),
    sourceFingerprint: TEMPLATE_FILES.filter((f) => fs.existsSync(path.join(src, f))).map((f) => ({
      file: f,
      sha256: sha256File(path.join(src, f)),
    })),
  };
  writeState(state, env);

  return report;
}

// ── B) inplace 模式 ─────────────────────────────────────

export function applyInplace({ sourceDir, env = process.env } = {}) {
  const src = sourceDir || resolveSourceTemplatesDir(env);
  if (!src) throw new Error('找不到 WorkBuddy 原始模板目录。');
  const bk = backupRoot(env);
  const report = { sourceDir: src, backupDir: bk, files: [] };
  fs.mkdirSync(bk, { recursive: true });

  for (const f of TEMPLATE_FILES) {
    const fp = path.join(src, f);
    if (!fs.existsSync(fp)) { report.files.push({ file: f, status: 'missing' }); continue; }
    const bkFp = path.join(bk, f);
    if (!fs.existsSync(bkFp)) fs.copyFileSync(fp, bkFp); // 只备份一次，保留最原始版本
    const raw = fs.readFileSync(fp, 'utf8');
    const eol = detectEol(raw);
    const { text, applied, skipped } = applyPatchesToText(raw);
    if (!applied.length) { report.files.push({ file: f, status: 'no-anchor' }); continue; }
    atomicWriteSync(fp, text.replace(/\n/g, eol));
    report.files.push({ file: f, status: 'patched', applied, skipped });
  }

  writeState(
    {
      version: WORKBB_VERSION,
      mode: 'inplace',
      installedAt: new Date().toISOString(),
      sourceDir: src,
      backupDir: bk,
      patches: ALL_PATCHES.map((p) => ({ id: p.id, layer: p.layer, name: p.name, optional: !!p.optional })),
    },
    env,
  );
  return report;
}

// ── C) revert ───────────────────────────────────────────

export function revert({ env = process.env, removeState = true } = {}) {
  const state = readState(env);
  const out = { removed: [], restored: [], mode: state?.mode || 'none' };

  // mirror：删定制目录（含 fragments 兄弟目录）
  const dst = overrideRoot(env);
  if (fs.existsSync(dst)) {
    fs.rmSync(dst, { recursive: true, force: true });
    out.removed.push(dst);
  }
  const fragSide = path.join(dst, '..', 'plugins');
  if (fs.existsSync(fragSide)) {
    fs.rmSync(fragSide, { recursive: true, force: true });
    out.removed.push(fragSide);
  }

  // inplace：从备份还原
  const bk = state?.backupDir || backupRoot(env);
  if (fs.existsSync(bk)) {
    for (const f of fs.readdirSync(bk).filter((x) => x.endsWith('.tpl'))) {
      const target = path.join(state?.sourceDir || resolveSourceTemplatesDir(env) || '', f);
      if (fs.existsSync(target)) {
        fs.copyFileSync(path.join(bk, f), target);
        out.restored.push(target);
      }
    }
  }

  if (removeState && fs.existsSync(stateFile(env))) {
    fs.unlinkSync(stateFile(env));
    out.removed.push(stateFile(env));
  }
  return out;
}

// ── status ──────────────────────────────────────────────

export function status({ env = process.env } = {}) {
  const state = readState(env);
  const override = overrideTemplatesDir(env);
  const dst = overrideRoot(env);
  const active = resolveTemplatesDir(env);
  const rows = [];

  // 状态判定应以「已安装的定制副本」为准：
  //   env 生效 → 用它
  //   env 未生效但 overrideRoot 里有打过补丁的副本 → 用 overrideRoot（说明已安装、只是没导出 env）
  //   都没有 → 回落到当前探测结果
  const overrideHasPatch = (() => {
    try {
      const f = path.join(dst, 'workbuddy-prompt.tpl');
      if (!fs.existsSync(f)) return false;
      const txt = fs.readFileSync(f, 'utf8');
      return canon(txt).includes(canon(ALL_PATCHES[0].replacement.slice(0, 120)));
    } catch { return false; }
  })();
  const target = override ? dst : overrideHasPatch ? dst : active || dst;
  for (const p of ALL_PATCHES) {
    let hits = 0;
    // 命中判定：定制目录里 anchor 已不存在（被替换），replacement 存在
    let replaced = 0;
    let anchorLeft = 0;
    if (target && fs.existsSync(target)) {
      for (const f of TEMPLATE_FILES) {
        const fp = path.join(target, f);
        if (!fs.existsSync(fp)) continue;
        const txt = fs.readFileSync(fp, 'utf8');
        if (canon(txt).includes(canon(p.replacement))) replaced++;
        if (canon(txt).includes(canon(p.anchor))) anchorLeft++;
      }
    }
    hits = replaced;
    rows.push({
      id: p.id,
      layer: p.layer,
      name: p.name,
      optional: !!p.optional,
      replacedIn: replaced,
      anchorLeft,
      status: replaced > 0 && anchorLeft === 0 ? 'applied' : replaced > 0 ? 'partial' : anchorLeft > 0 ? 'pending' : p.optional ? 'na' : 'missing',
    });
  }

  return {
    mode: state?.mode || (override ? 'mirror' : 'none'),
    envVar: TEMPLATES_DIR_ENV,
    envValue: override,
    envActive: !!override,
    installTemplatesDir: resolveSourceTemplatesDir(env),
    activeTemplatesDir: active,
    overrideRoot: dst,
    stateFileExists: !!state,
    installedAt: state?.installedAt || null,
    patches: rows,
    summary: {
      total: rows.length,
      applied: rows.filter((r) => r.status === 'applied').length,
      partial: rows.filter((r) => r.status === 'partial').length,
      pending: rows.filter((r) => r.status === 'pending').length,
      na: rows.filter((r) => r.status === 'na').length,
      missing: rows.filter((r) => r.status === 'missing').length,
    },
  };
}

// ── doctor ──────────────────────────────────────────────

export function doctor({ env = process.env } = {}) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  const override = overrideTemplatesDir(env);
  push('WORKBUDDY_PROMPT_TEMPLATES_DIR 已设置', !!override, override || '未设置');

  const dst = overrideRoot(env);
  push('定制模板目录存在', fs.existsSync(dst), dst);

  if (fs.existsSync(dst)) {
    const missing = TEMPLATE_FILES.filter((f) => !fs.existsSync(path.join(dst, f)));
    push('模板文件齐全', missing.length === 0, missing.length ? '缺失: ' + missing.join(', ') : `${TEMPLATE_FILES.length} 个齐全`);
    const fragOk = fs.existsSync(path.join(dst, '..', 'plugins', 'workbuddy-builtin', 'prompt-common', 'fragments', 'workbuddy-channel-prompts.md'));
    push('prompt-common 片段可解析', fragOk, fragOk ? 'ok' : '缺失 —— include 会报 template not found');
  }

  const src = resolveSourceTemplatesDir(env);
  push('可定位官方安装体模板', !!src, src || '未找到');

  const st = readState(env);
  push('状态文件存在', !!st, stateFile(env));

  return { checks, ok: checks.every((c) => c.ok) };
}

export { TEMPLATE_FILES, TEMPLATE_SUBDIRS, ALL_PATCHES };

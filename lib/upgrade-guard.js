/**
 * workBB — 升级屏蔽模块（upgrade guard）
 *
 * 查证结论（WorkBuddy 5.9.3，源码级）：
 *
 * 1. 官方【有】用户级开关：settings.json 里的 `startupForceAutoUpdate` 布尔值。
 *    见 main/main-bootstrap.js：
 *      SETTING_KEY_USER_STARTUP_FORCE_AUTO_UPDATE = "startupForceAutoUpdate"
 *      readStartupForceAutoUpdateEnabled(configStore, productSource)
 *        → readBooleanFromConfig(configStore, "startupForceAutoUpdate")
 *    这个 configStore 就是 settings.json（createAutoLaunchSettingsStore 用同一个 settingsPath）。
 *    ⇒ 设 false 即可关掉「启动时强制自动更新」这条链。
 *
 * 2. 还有一条更早的独立链：runEarlyForceUpgradeCheck()——启动 10 秒后无条件
 *    checkForceUpgrade()，它只看服务端 feed 里的 forceUpdate 字段，不看上面那个开关。
 *    这条只能靠 feed 拿不到数据来挡（网络层）。
 *
 * 3. 升级器是【自研】的，不是 electron-updater：
 *    缓存目录 = os.tmpdir()/workbuddy-update-<arch>-<applicationName>
 *    且 cacheRootTrusted 要求 GetDriveTypeW(盘根)===3（本地盘），否则
 *    「Automatic updates disabled: no local installer cache directory」。
 *    下好的包叫 installer.exe，校验 sha256 后 rename，再 spawn NSIS 静默安装。
 *
 * 4. 更新 feed：`<base>/v2/update?platform=...&version=...`，base 来自
 *    `https://www.workbuddy.cn`（cache/update-endpoint.json 里记着）。
 *    注意：www.workbuddy.cn 同时是 API/登录域，整域 hosts 阻断会连坐。
 *
 * 因此本模块采用【非连坐】的组合策略：
 *   L1 官方开关   settings.json → startupForceAutoUpdate = false（干净、可逆、官方语义）
 *   L2 缓存拦阻   把更新缓存目录做成「符号链接指向不存在的目标」→ 目录建不出来 → 下载失败
 *   L3 自愈       升级真的发生了也没关系：workBB 在 mirror 模式下自动重打补丁
 *
 * 不做的事：不整域 hosts 阻断 www.workbuddy.cn（会连坐登录与 API）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { configDir } from './paths.js';
import { atomicWriteSync, readState } from './index.js';
import { readSettings, writeSettings, settingsPath } from './inject.js';

// ── L1：官方开关 ────────────────────────────────────────

export const SETTING_KEY = 'startupForceAutoUpdate';

/**
 * 关掉启动强制自动更新。
 * @returns {{path:string, before:boolean|undefined, after:boolean}}
 */
export function disableAutoUpdateSetting(env = process.env) {
  const r = readSettings(env);
  if (r.error) throw new Error(`settings.json 解析失败，先修好：${r.path} (${r.error})`);
  const data = r.data && typeof r.data === 'object' ? { ...r.data } : {};
  const before = typeof data[SETTING_KEY] === 'boolean' ? data[SETTING_KEY] : undefined;
  data[SETTING_KEY] = false;
  writeSettings(data, env);
  return { key: SETTING_KEY, path: r.path, existed: r.exists, before, after: false };
}

/**
 * 恢复官方开关（删除我们写的 false，让产品默认值重新生效）。
 */
export function restoreAutoUpdateSetting(env = process.env) {
  const r = readSettings(env);
  if (!r.exists) return { path: r.path, changed: false };
  const data = r.data && typeof r.data === 'object' ? { ...r.data } : {};
  const had = data[SETTING_KEY] === false;
  delete data[SETTING_KEY];
  writeSettings(data, env);
  return { path: r.path, changed: had };
}

export function isAutoUpdateDisabled(env = process.env) {
  const r = readSettings(env);
  return r.data?.[SETTING_KEY] === false;
}

// ── L2：更新缓存目录拦阻 ────────────────────────────────

/**
 * 复刻 WorkBuddy 的缓存目录命名：
 *   cacheDirName = `workbuddy-update-${process.arch}-${applicationName}`
 *   applicationName 来自 product.json；未取到时回退到 exe basename。
 * @returns {string[]} 候选目录（每 arch 一个）
 */
export function updateCacheCandidates(env = process.env) {
  const appName = resolveApplicationName(env);
  const norm = (appName || 'workbuddy')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workbuddy';
  const out = [];
  for (const arch of ['x64', 'arm64', 'ia32']) {
    out.push(path.join(os.tmpdir(), `workbuddy-update-${arch}-${norm}`));
  }
  return out;
}

function resolveApplicationName(env = process.env) {
  const pj = env.WORKBUDDY_APP_PATH?.trim()
    ? path.join(env.WORKBUDDY_APP_PATH, 'app.asar.unpacked', 'cli', 'product.json')
    : null;
  const cands = [pj].filter(Boolean);
  // 常见安装位置兜底
  for (const base of [
    path.join(os.homedir(), 'AppData', 'Local', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'product.json'),
    'C:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/product.json',
    'C:/Program Files (x86)/WorkBuddy/resources/app.asar.unpacked/cli/product.json',
  ]) cands.push(base);
  for (const f of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (typeof j.applicationName === 'string' && j.applicationName.trim()) {
        return j.applicationName.trim();
      }
    } catch { /* 继续 */ }
  }
  return 'workbuddy';
}

/**
 * 把一个路径做成「指向不存在的目标」的符号链接，使任何尝试写它的代码都失败。
 * 若已有同名实体目录/文件，先改名备份（不删除用户数据）。
 * @returns {{target:string, action:string, backup?:string}}
 */
export function blockCacheDir(target) {
  const dead = target + '.workbb-blocked';

  // 已经是占位文件形态（C# 版建的）→ 幂等
  try {
    const st = fs.lstatSync(target);
    if (st.isFile()) {
      const head = fs.readFileSync(target, 'utf8');
      if (head.startsWith('workBB-Guard:')) return { target, action: 'already-blocked' };
      return { target, action: 'foreign-file' };
    }
    if (st.isSymbolicLink()) {
      const link = fs.readlinkSync(target);
      if (link === dead) return { target, action: 'already-blocked' };
      fs.unlinkSync(target);
      fs.symlinkSync(dead, target, 'dir');
      return { target, action: 'relinked' };
    }
    // 实体目录：先改名保留
    const backup = `${target}.workbb-bak-${Date.now()}`;
    fs.renameSync(target, backup);
    fs.symlinkSync(dead, target, 'dir');
    return { target, action: 'moved-and-blocked', backup };
  } catch (e) {
    if (e.code === 'ENOENT') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(dead, target, 'dir');
      return { target, action: 'blocked' };
    }
    throw e;
  }
}

/**
 * 解除拦阻，恢复成普通可写目录。
 */
export function unblockCacheDir(target) {
  let blockedForm = null;
  try {
    const st = fs.lstatSync(target);
    if (st.isFile()) {
      const head = fs.readFileSync(target, 'utf8');
      if (!head.startsWith('workBB-Guard:')) return { target, action: 'foreign-file' };
      fs.unlinkSync(target);
      blockedForm = 'placeholder';
    } else if (st.isSymbolicLink()) {
      const link = fs.readlinkSync(target);
      if (!link.endsWith('.workbb-blocked')) return { target, action: 'foreign-link' };
      fs.unlinkSync(target);
      blockedForm = 'symlink';
    } else {
      return { target, action: 'not-blocked' };
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { target, action: 'absent' };
    throw e;
  }

  fs.mkdirSync(target, { recursive: true });

  // 有备份就还原内容
  const dir = path.dirname(target);
  const base = path.basename(target) + '.workbb-bak-';
  const cands = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
  const restoredFrom = [];
  if (cands.length) {
    const last = path.join(dir, cands[cands.length - 1]);
    for (const f of fs.readdirSync(last)) {
      fs.renameSync(path.join(last, f), path.join(target, f));
      restoredFrom.push(f);
    }
    fs.rmdirSync(last);
  }
  return { target, action: `unblocked-${blockedForm}`, restoredFrom };
}

export function isCacheDirBlocked(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return false; // 不存在
  }
  // 形态一：符号链接指向 *.workbb-blocked（Node 版）
  if (st.isSymbolicLink()) {
    try { return fs.readlinkSync(target).endsWith('.workbb-blocked'); } catch { return false; }
  }
  // 形态二：同名占位文件（C# 版）
  if (st.isFile()) {
    try { return fs.readFileSync(target, 'utf8').startsWith('workBB-Guard:'); } catch { return false; }
  }
  return false;
}

/** 清理已下载/待安装的升级包（只清更新缓存里的 installer.exe / pending）。 */
export function purgePendingInstallers(env = process.env) {
  const removed = [];
  for (const dir of updateCacheCandidates(env)) {
    if (!isCacheDirBlocked(dir) && !fs.existsSync(dir)) continue;
    for (const sub of ['', 'pending']) {
      const d = sub ? path.join(dir, sub) : dir;
      if (!fs.existsSync(d) || isCacheDirBlocked(d)) continue;
      let entries = [];
      try { entries = fs.readdirSync(d); } catch { continue; }
      for (const f of entries) {
        if (/installer\.exe|\.nsis|update-info\.json|\.blockmap$/i.test(f)) {
          try {
            fs.unlinkSync(path.join(d, f));
            removed.push(path.join(d, f));
          } catch { /* 占用中，跳过 */ }
        }
      }
    }
  }
  // WorkBuddy 也可能把包放在 userData 下的 win-install-* 标记里，仅清标记
  const ud = path.join(configDir(env), 'app');
  for (const f of ['win-install-failure.json', 'win-install-attempt.json']) {
    const fp = path.join(configDir(env), f);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); removed.push(fp); } catch { } }
  }
  return removed;
}

// ── 组合动作 ────────────────────────────────────────────

/**
 * 一次性安装全部屏蔽层。
 * @param {{env?:object, blockCache?:boolean}} opts
 */
export function installGuard(opts = {}) {
  const env = opts.env || process.env;
  const result = { setting: null, caches: [], purged: [], errors: [] };

  try {
    result.setting = disableAutoUpdateSetting(env);
  } catch (e) {
    result.errors.push(`settings.json: ${e.message}`);
  }

  if (opts.blockCache !== false) {
    for (const dir of updateCacheCandidates(env)) {
      try {
        result.caches.push(blockCacheDir(dir));
      } catch (e) {
        result.errors.push(`${dir}: ${e.message}`);
      }
    }
  }

  try {
    result.purged = purgePendingInstallers(env);
  } catch (e) {
    result.errors.push(`purge: ${e.message}`);
  }

  return result;
}

export function removeGuard(opts = {}) {
  const env = opts.env || process.env;
  const result = { setting: null, caches: [], errors: [] };
  try {
    result.setting = restoreAutoUpdateSetting(env);
  } catch (e) {
    result.errors.push(`settings.json: ${e.message}`);
  }
  for (const dir of updateCacheCandidates(env)) {
    try {
      result.caches.push(unblockCacheDir(dir));
    } catch (e) {
      result.errors.push(`${dir}: ${e.message}`);
    }
  }
  return result;
}

export function guardStatus(opts = {}) {
  const env = opts.env || process.env;
  const settingOff = isAutoUpdateDisabled(env);
  const caches = updateCacheCandidates(env).map((d) => {
    const blocked = isCacheDirBlocked(d);
    let form = 'none';
    if (blocked) {
      try {
        form = fs.lstatSync(d).isSymbolicLink() ? 'symlink' : 'placeholder';
      } catch { form = 'unknown'; }
    }
    return {
      dir: d,
      exists: fs.existsSync(d) || blocked,
      blocked,
      form,
    };
  });

  // 自愈状态
  const st = readState(env);
  const mirrorMode = st?.mode === 'mirror';
  const mirrorDir = st?.targetDir || null;
  const mirrorPresent = mirrorDir ? fs.existsSync(path.join(mirrorDir, 'workbuddy-prompt.tpl')) : false;

  return {
    setting: { key: SETTING_KEY, disabled: settingOff, file: settingsPath(env) },
    caches,
    selfHeal: { mode: st?.mode || 'none', mirrorDir, mirrorPresent },
  };
}

/**
 * 升级自愈：官方升级会把安装体模板覆盖，但 mirror 目录里的定制模板还在。
 * 只要把「源模板目录」重新指向新安装体、重打一遍补丁即可。
 *
 * @returns {Promise<{action:string, report?:object, reason?:string}>}
 */
export async function selfHeal({ env = process.env, buildMirror } = {}) {
  const st = readState(env);
  if (!st || st.mode !== 'mirror') {
    return { action: 'skip', reason: 'not in mirror mode' };
  }
  const target = st.targetDir;
  const marker = path.join(target, 'workbuddy-prompt.tpl');
  if (!fs.existsSync(marker)) {
    return { action: 'skip', reason: 'mirror dir missing' };
  }

  // 检测安装体是否被升级过：比对源模板 sha256
  const srcRoot = st.sourceDir;
  const drift = [];
  if (srcRoot && fs.existsSync(srcRoot)) {
    for (const item of st.sourceFingerprint || []) {
      const fp = path.join(srcRoot, item.file);
      if (!fs.existsSync(fp)) { drift.push({ file: item.file, reason: 'missing' }); continue; }
      // 延迟 require，避免循环依赖
      const { createHash } = await import('node:crypto');
      const now = createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
      if (now !== item.sha256) drift.push({ file: item.file, reason: 'changed' });
    }
  }

  const fn = buildMirror || (await import('./index.js')).buildMirror;
  const report = fn({ sourceDir: srcRoot, env, force: true });

  // 重打后刷新基线指纹，避免下次误报
  try {
    const { createHash } = await import('node:crypto');
    const st2 = readState(env);
    if (st2 && st2.mode === 'mirror') {
      st2.sourceFingerprint = TEMPLATES_FOR_FINGERPRINT.filter((f) =>
        fs.existsSync(path.join(st2.sourceDir, f)),
      ).map((f) => ({
        file: f,
        sha256: createHash('sha256').update(fs.readFileSync(path.join(st2.sourceDir, f))).digest('hex'),
      }));
      const { writeState } = await import('./index.js');
      writeState(st2, env);
    }
  } catch { /* 指纹刷新失败不影响补丁本身 */ }

  return { action: 'rebuilt', drift, report };
}

const TEMPLATES_FOR_FINGERPRINT = [
  'workbuddy-prompt.tpl',
  'workbuddy-ask-prompt.tpl',
  'workbuddy-ask-code-prompt.tpl',
  'workbuddy-ask-coding-prompt.tpl',
  'workbuddy-craft-code-prompt.tpl',
  'workbuddy-craft-coding-prompt.tpl',
  'workbuddy-craft-design-prompt.tpl',
  'workbuddy-expert-prompt.tpl',
  'workbuddy-expert-code-prompt.tpl',
  'workbuddy-expert-coding-prompt.tpl',
  'workbuddy-quick-prompt.tpl',
  'user-context-identity.tpl',
  'user-context-expert-identity.tpl',
  'ask-mode-reminder.tpl',
  'craft-mode-reminder.tpl',
  'system-reminder.tpl',
];

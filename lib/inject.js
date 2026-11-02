// workBB — 注入层
//
// 让 WorkBuddy 真正加载定制模板，有三个互不排斥的通道：
//
//   1) env（推荐，零侵入）：WORKBUDDY_PROMPT_TEMPLATES_DIR=<定制目录>
//      官方 runtime-context2.js 的 getWorkbuddyRuntimePromptTemplatesDir() 读它，
//      且它在候选链最前面 → 优先级最高，不需要动安装体一个字节。
//
//   2) launcher：生成启动脚本（Windows .cmd / PowerShell .ps1），
//      设置 env 后拉起 WorkBuddy.exe。双击即用，不必改系统环境变量。
//
//   3) customPrompt（纵深）：写入 ~/.workbuddy/settings.json 的 personalization.customPrompt，
//      由 PersonalizationCollector 注入到 <user_custom_instructions> 槽。
//      即使模板接管失效（比如升级后目录变了），这一层仍然生效。
//
// 三层叠起来才有「即使一层被冲掉也不会裸奔」的效果。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { configDir, overrideRoot, TEMPLATES_DIR_ENV } from './paths.js';
import { atomicWriteSync } from './index.js';

export const SETTINGS_FILE = 'settings.json';

export function settingsPath(env = process.env) {
  return path.join(configDir(env), SETTINGS_FILE);
}

/**
 * 读取 settings.json（不存在返回 {}；损坏返回 {} 并给出 warning）。
 */
export function readSettings(env = process.env) {
  const fp = settingsPath(env);
  if (!fs.existsSync(fp)) return { data: {}, exists: false, path: fp };
  try {
    return { data: JSON.parse(fs.readFileSync(fp, 'utf8')), exists: true, path: fp };
  } catch (e) {
    return { data: {}, exists: true, path: fp, error: e.message };
  }
}

export function writeSettings(data, env = process.env) {
  const fp = settingsPath(env);
  if (fs.existsSync(fp)) {
    fs.copyFileSync(fp, `${fp}.workbb-bak`);
  }
  atomicWriteSync(fp, JSON.stringify(data, null, 2) + '\n');
  return fp;
}

/**
 * 把 customPrompt 写进 settings.json 的 personalization 段。
 * @param {string} prompt 提示词全文
 * @param {{mode:'replace'|'append'|'keep'}} opts
 */
export function installCustomPrompt(prompt, opts = {}) {
  const env = opts.env || process.env;
  const { data, exists, path: fp, error } = readSettings(env);
  if (error) throw new Error(`settings.json 解析失败，先手工修复：${fp} (${error})`);

  const personalization = (data.personalization && typeof data.personalization === 'object' && !Array.isArray(data.personalization))
    ? { ...data.personalization }
    : {};

  const mode = opts.mode || 'replace';
  let next;
  if (mode === 'append' && typeof personalization.customPrompt === 'string') {
    next = personalization.customPrompt + '\n\n' + prompt;
  } else {
    next = prompt;
  }
  personalization.customPrompt = next;
  data.personalization = personalization;

  writeSettings(data, env);
  return { path: fp, existed: exists, mode, bytes: next.length };
}

export function uninstallCustomPrompt(env = process.env) {
  const { data, exists, path: fp } = readSettings(env);
  if (!exists) return { path: fp, changed: false };
  if (!data.personalization || typeof data.personalization !== 'object') {
    return { path: fp, changed: false };
  }
  const had = typeof data.personalization.customPrompt === 'string' && data.personalization.customPrompt.length > 0;
  delete data.personalization.customPrompt;
  if (Object.keys(data.personalization).length === 0) delete data.personalization;
  writeSettings(data, env);
  return { path: fp, changed: had };
}

export function isCustomPromptInstalled(env = process.env) {
  const { data } = readSettings(env);
  const cp = data?.personalization?.customPrompt;
  return typeof cp === 'string' && cp.length > 0;
}

// ── 启动器 ──────────────────────────────────────────────

/**
 * 生成 Windows 启动脚本。放在 ~/.workbuddy/workbb/ 下。
 * @param {{exePath:string, env?:object}} opts
 */
export function makeLauncher(opts) {
  const env = opts.env || process.env;
  const root = stateDirFor(env);
  fs.mkdirSync(root, { recursive: true });
  const exe = opts.exePath;
  if (!exe) throw new Error('需要 --exe 指定 WorkBuddy.exe 路径');
  if (!fs.existsSync(exe)) throw new Error(`指定路径不存在：${exe}`);

  // 从 exe 调用推断安装根，用来修正 WORKBUDDY_APP_PATH
  const installRoot = path.dirname(exe); // WorkBuddy.exe 在安装根
  const appPath = path.join(installRoot, 'resources'); // resources 目录

  const cmdPath = path.join(root, '启动 WorkBuddy（workBB）.cmd');
  const ps1Path = path.join(root, 'workbb-launch.ps1');

  const tplDir = overrideRoot(env);

  const cmdLines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    `rem workBB launcher — generated ${new Date().toISOString()}`,
    'rem 官方 env 优先接管提示词模板；workBB 定制目录',
    `set "${TEMPLATES_DIR_ENV}=${tplDir}"`,
    `set "WORKBUDDY_APP_PATH=${appPath}"`,
    `set "WORKBUDDY_CONFIG_DIR=${configDir(env)}"`,
    `start "" "${exe}" %*`,
    'endlocal',
    '',
  ];
  atomicWriteSync(cmdPath, cmdLines.join('\r\n'));

  const ps1 = `# workBB launcher — generated ${new Date().toISOString()}
$env:${TEMPLATES_DIR_ENV} = '${tplDir.replace(/'/g, "''")}'
$env:WORKBUDDY_APP_PATH = '${appPath.replace(/'/g, "''")}'
$env:WORKBUDDY_CONFIG_DIR = '${configDir(env).replace(/'/g, "''")}'
& '${exe.replace(/'/g, "''")}' @args
`;
  atomicWriteSync(ps1Path, ps1);

  return { cmdPath, ps1Path, templatesDir: tplDir, exe, appPath };
}

function stateDirFor(env) {
  return path.join(configDir(env), 'workbb');
}

/**
 * 探测 WorkBuddy.exe 常见位置。
 */
export function guessExePaths(env = process.env) {
  const out = [];
  const home = os.homedir();
  if (process.platform === 'win32') {
    for (const base of [
      path.join(home, 'AppData', 'Local'),
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ]) {
      for (const n of ['WorkBuddy', 'CodeBuddy']) {
        out.push(path.join(base, n, 'WorkBuddy.exe'));
        out.push(path.join(base, n, 'CodeBuddy.exe'));
      }
    }
  } else if (process.platform === 'darwin') {
    out.push('/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy');
  }
  const appPath = env.WORKBUDDY_APP_PATH?.trim();
  if (appPath) out.unshift(path.join(appPath, '..', 'WorkBuddy.exe'));
  return out.filter((p) => fs.existsSync(p));
}

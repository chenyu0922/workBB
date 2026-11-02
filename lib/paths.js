// workBB — 路径探测
// 与 WorkBuddy 主进程 authority-snapshot.js 的
// listWorkbuddyPromptTemplateDirCandidates() 保持一致的候选顺序，
// 并把官方支持的 WORKBUDDY_PROMPT_TEMPLATES_DIR 环境变量放在最前。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/** 官方 env 名：runtime-context2.js / getWorkbuddyRuntimePromptTemplatesDir() */
export const TEMPLATES_DIR_ENV = 'WORKBUDDY_PROMPT_TEMPLATES_DIR';
/** 官方 config 目录 env：getWorkbuddyRuntimeConfigDir() */
export const CONFIG_DIR_ENV = 'WORKBUDDY_CONFIG_DIR';

/** 参与 system prompt 渲染的模板（含 reminder / identity 槽） */
export const TEMPLATE_FILES = [
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

/** 仅需要原样复制、不做文本替换的附属目录 */
export const TEMPLATE_SUBDIRS = ['style', 'miora'];

/** 模板里的 kind→文件名映射（来自 authority-snapshot.js 的 Gs 表） */
export const TEMPLATE_KIND_MAP = {
  normal: 'workbuddy-prompt.tpl',
  ask: 'workbuddy-ask-prompt.tpl',
  expert: 'workbuddy-expert-prompt.tpl',
  quick: 'workbuddy-quick-prompt.tpl',
  'normal-code': 'workbuddy-craft-code-prompt.tpl',
  'normal-work': 'workbuddy-prompt.tpl',
  'normal-design': 'workbuddy-craft-design-prompt.tpl',
  'ask-code': 'workbuddy-ask-code-prompt.tpl',
  'ask-work': 'workbuddy-ask-prompt.tpl',
  'ask-design': 'workbuddy-craft-design-prompt.tpl',
  'expert-code': 'workbuddy-expert-code-prompt.tpl',
  'expert-work': 'workbuddy-expert-prompt.tpl',
  'expert-design': 'workbuddy-craft-design-prompt.tpl',
  'user-context': 'user-context-identity.tpl',
  'user-context-expert': 'user-context-expert-identity.tpl',
};

export function configDir(env = process.env) {
  return env[CONFIG_DIR_ENV]?.trim() || path.join(os.homedir(), '.workbuddy');
}

export function stateDir(env = process.env) {
  return path.join(configDir(env), 'workbb');
}

/**
 * 探测定制的模板根（apply 之后 env 指向这里）。
 * @returns {string|null}
 */
export function overrideTemplatesDir(env = process.env) {
  const v = env[TEMPLATES_DIR_ENV]?.trim();
  if (!v) return null;
  return path.resolve(v);
}

/**
 * 官方候选链，越靠前优先级越高。
 * 与主进程 listWorkbuddyPromptTemplateDirCandidates() 对齐：
 *   1) runtime 配置的 promptTemplatesDir（env > appPath 推断）
 *   2) <cwd>/resources/templates
 *   3) <cwd>/apps/workbuddy-desktop/resources/templates
 *   4) <cwd>/../../apps/workbuddy-desktop/resources/templates
 */
export function templateDirCandidates(env = process.env) {
  const cwd = env.WORKBUDDY_APP_PATH?.trim() || process.cwd();
  return [
    overrideTemplatesDir(env),
    path.join(cwd, 'resources', 'templates'),
    path.join(cwd, 'apps', 'workbuddy-desktop', 'resources', 'templates'),
    path.join(cwd, '..', '..', 'apps', 'workbuddy-desktop', 'resources', 'templates'),
  ].filter((p) => typeof p === 'string' && p.length > 0);
}

/**
 * 找出当前实际生效的模板目录（第一个存在且含 workbuddy-prompt.tpl 的候选）。
 * @returns {string|null}
 */
export function resolveTemplatesDir(env = process.env) {
  for (const dir of templateDirCandidates(env)) {
    const marker = path.join(dir, 'workbuddy-prompt.tpl');
    if (fs.existsSync(marker)) return dir;
  }
  return null;
}

/**
 * 已知的 WorkBuddy 安装体位置，用于 doctor 在 cwd 不对时兜底探测。
 */
export function guessInstallDirs(env = process.env) {
  const out = [];
  const home = os.homedir();
  const plat = process.platform;
  const names = ['WorkBuddy', 'CodeBuddy'];

  const bases = [];
  if (plat === 'win32') {
    bases.push(path.join(home, 'AppData', 'Local'));
    bases.push(path.join(home, 'AppData', 'Roaming'));
    bases.push('C:\\Program Files');
    bases.push('C:\\Program Files (x86)');
  } else if (plat === 'darwin') {
    bases.push('/Applications');
  } else {
    bases.push('/opt', '/usr/lib');
  }
  for (const b of bases) {
    for (const n of names) {
      out.push(path.join(b, n, 'resources', 'resources', 'templates'));
      out.push(path.join(b, n, 'resources', 'templates'));
      out.push(path.join(b, n, 'resources', 'app.asar.unpacked', 'resources', 'templates'));
    }
  }
  // 显式 env 指定 app path 时也纳入
  const appPath = env.WORKBUDDY_APP_PATH?.trim();
  if (appPath) {
    out.unshift(path.join(appPath, 'resources', 'templates'));
    out.unshift(path.join(appPath, 'resources', 'assets', 'templates'));
  }
  return out.filter((p) => fs.existsSync(p));
}

/** 定制模板根（apply 写入位置） */
export function overrideRoot(env = process.env) {
  return path.join(stateDir(env), 'templates');
}

export function backupRoot(env = process.env) {
  return path.join(stateDir(env), 'backup');
}

export function stateFile(env = process.env) {
  return path.join(stateDir(env), 'state.json');
}

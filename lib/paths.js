// workBB — 路径探测
//
// 设计目标：在【任意一台机器】上都能找对 WorkBuddy，而不是只在开发机上。
//
// 探测顺序（越靠前越可信）：
//   0) WORKBUDDY_PROMPT_TEMPLATES_DIR（已生效的定制目录）
//   1) ★ WORKBUDDY_APP_PATH（用户显式指定，必须压倒自动探测）
//   2) 注册表卸载项 UninstallString → 安装根（Windows 最可靠）
//   3) 已运行的 WorkBuddy 进程主模块路径 → 安装根
//   4) 常见安装位置（Program Files / LocalAppData Programs / 各盘符常见目录）
//   5) 官方 cwd 候选链（与主进程 listWorkbuddyPromptTemplateDirCandidates 对齐）
//
// 安装根下的模板位置（按优先级）：
//   <root>/resources/app.asar.unpacked/resources/templates   ← 解包形态（真文件）
//   <root>/resources/resources/templates                     ← app 目录整体解包
//   <root>/resources/templates
//
// 注意：asar 密封态（只有 app.asar）下拿不到模板文件；此时必须让用户
// 用 --templates-dir 指定，或先用解包工具解出 resources 目录。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/** 官方 env：定制模板目录 */
export const TEMPLATES_DIR_ENV = 'WORKBUDDY_PROMPT_TEMPLATES_DIR';
/** 官方 env：配置目录 */
export const CONFIG_DIR_ENV = 'WORKBUDDY_CONFIG_DIR';
/** 官方 env：应用 resources 路径 */
export const APP_PATH_ENV = 'WORKBUDDY_APP_PATH';

/** 参与 system prompt 渲染的模板 */
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

export const TEMPLATE_SUBDIRS = ['style', 'miora'];

/** kind→文件名（来自官方 Gs 表） */
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

// ── 配置目录 ────────────────────────────────────────────

export function configDir(env = process.env) {
  return env[CONFIG_DIR_ENV]?.trim() || path.join(os.homedir(), '.workbuddy');
}

export function stateDir(env = process.env) {
  return path.join(configDir(env), 'workbb');
}

export function overrideRoot(env = process.env) {
  return path.join(stateDir(env), 'templates');
}

export function backupRoot(env = process.env) {
  return path.join(stateDir(env), 'backup');
}

export function stateFile(env = process.env) {
  return path.join(stateDir(env), 'state.json');
}

export function overrideTemplatesDir(env = process.env) {
  const v = env[TEMPLATES_DIR_ENV]?.trim();
  return v ? path.resolve(v) : null;
}

// ── 注册表 / 进程探测 ──────────────────────────────────

/** 从注册表卸载项拿 WorkBuddy 安装根 */
export function installRootFromRegistry() {
  if (process.platform !== 'win32') return null;
  const hives = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const h of hives) {
    let out = '';
    try {
      out = execFileSync('reg', ['query', h, '/s', '/f', 'WorkBuddy', '/d', '/c'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
      });
    } catch {
      continue;
    }
    const m = out.match(/UninstallString\s+REG_[A-Z_]+\s+"?([^"\r\n]+)"?/i);
    if (m) {
      const raw = m[1].trim();
      const exe = raw.split(/\s+\//)[0].replace(/^"|"$/g, '').trim();
      const dir = path.dirname(exe);
      try {
        if (fs.existsSync(dir)) return dir;
      } catch { /* ignore */ }
    }
    const m2 = out.match(/InstallLocation\s+REG_[A-Z_]+\s+"?([^"\r\n]*)"?/i);
    if (m2) {
      const loc = m2[1].trim();
      try {
        if (loc && fs.existsSync(loc)) return loc;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/** 从正在运行的 WorkBuddy 进程拿安装根 */
export function installRootFromProcess() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command',
        "Get-Process -Name WorkBuddy,CodeBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path",
      ],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 12000 },
    ).trim();
    if (out) {
      try {
        if (fs.existsSync(out)) return path.dirname(out);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 把「安装根 / resources 目录 / app.asar.unpacked 目录」展开成可能含 templates 的目录列表。
 */
export function expandRootToTemplateDirs(root) {
  if (!root) return [];
  const out = [];
  const roots = new Set([root]);
  const base = path.basename(root).toLowerCase();
  if (base === 'resources') roots.add(path.dirname(root));
  if (base === 'app.asar.unpacked') roots.add(path.dirname(path.dirname(root)));
  for (const r of roots) {
    out.push(path.join(r, 'resources', 'app.asar.unpacked', 'resources', 'templates'));
    out.push(path.join(r, 'resources', 'resources', 'templates'));
    out.push(path.join(r, 'resources', 'templates'));
    out.push(path.join(r, 'resources', 'app.asar.unpacked', 'templates'));
    out.push(path.join(r, 'templates'));
  }
  return out;
}

/** 常见安装位置候选（跨机器通用，不写死单个盘符） */
export function commonInstallRoots(env = process.env) {
  const home = os.homedir();
  const roots = [];

  const ap = env[APP_PATH_ENV]?.trim();
  if (ap) roots.push(ap);

  const names = ['WorkBuddy', 'CodeBuddy'];
  for (const n of names) {
    roots.push(path.join(home, 'AppData', 'Local', 'Programs', n));
    roots.push(path.join(home, 'AppData', 'Local', n));
    roots.push(path.join(home, 'AppData', 'Roaming', n));
    roots.push(path.join(home, 'Programs', n));
  }

  const pf = env.ProgramFiles || env.ProgramW6432 || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const b of [pf, pf86]) for (const n of names) roots.push(path.join(b, n));

  for (const d of 'CDEFGH'.split('')) {
    for (const sub of ['', 'Apps', 'Program Files', 'Programs', 'Tools', 'Software']) {
      for (const n of names) roots.push(path.join(`${d}:`, sub, n));
    }
  }
  return roots.filter((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

/** 已知存在的模板目录清单（兼容旧接口） */
export function guessInstallDirs(env = process.env) {
  const out = [];
  const roots = [];
  const reg = installRootFromRegistry();
  if (reg) roots.push(reg);
  const proc = installRootFromProcess();
  if (proc) roots.push(proc);
  roots.push(...commonInstallRoots(env));
  for (const r of roots) {
    for (const d of expandRootToTemplateDirs(r)) {
      try {
        if (fs.existsSync(path.join(d, 'workbuddy-prompt.tpl')) && !out.includes(d)) out.push(d);
      } catch { /* ignore */ }
    }
  }
  return out;
}

/** 官方 cwd 候选链（与主进程一致：以 cwd 为基，不再多 join 一层 resources） */
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
 * 全部候选，去重保序。
 *
 * 优先级刻意如此：APP_PATH 必须压倒注册表，否则「本机装了 D 盘、
 * 但又想指向别的目录」的跨机器场景会永远命中本机。
 */
export function allTemplateDirCandidates(env = process.env) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (!out.includes(resolved)) out.push(resolved);
  };

  // 0 已有定制目录
  push(overrideTemplatesDir(env));

  // 1 ★ 显式 APP_PATH 最优先
  const ap = env[APP_PATH_ENV]?.trim();
  if (ap) expandRootToTemplateDirs(ap).forEach(push);

  // 2 注册表
  const reg = installRootFromRegistry();
  if (reg) expandRootToTemplateDirs(reg).forEach(push);

  // 3 运行中进程
  const proc = installRootFromProcess();
  if (proc) expandRootToTemplateDirs(proc).forEach(push);

  // 4 常见位置
  for (const r of commonInstallRoots(env)) {
    if (ap && path.resolve(r) === path.resolve(ap)) continue;
    expandRootToTemplateDirs(r).forEach(push);
  }

  // 5 官方 cwd 链
  templateDirCandidates(env).forEach(push);

  return out;
}

/** 当前实际生效的模板目录 */
export function resolveTemplatesDir(env = process.env) {
  for (const dir of allTemplateDirCandidates(env)) {
    try {
      if (fs.existsSync(path.join(dir, 'workbuddy-prompt.tpl'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

/** 定位官方原始模板目录（排除 override 目录），并返回搜索过的候选 */
export function resolveSourceTemplatesInfo(env = process.env) {
  const override = overrideTemplatesDir(env);
  const searched = [];
  for (const dir of allTemplateDirCandidates(env)) {
    searched.push(dir);
    if (override && path.resolve(dir) === path.resolve(override)) continue;
    try {
      if (fs.existsSync(path.join(dir, 'workbuddy-prompt.tpl'))) return { dir, searched };
    } catch { /* ignore */ }
  }
  return { dir: null, searched };
}

export function resolveSourceTemplatesDir(env = process.env) {
  return resolveSourceTemplatesInfo(env).dir;
}

/** 探测 WorkBuddy.exe（用于生成启动器） */
export function guessExePaths(env = process.env) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    try {
      if (fs.existsSync(p) && !out.includes(p)) out.push(p);
    } catch { /* ignore */ }
  };

  const ap = env[APP_PATH_ENV]?.trim();
  if (ap) {
    const root = path.basename(ap).toLowerCase() === 'resources' ? path.dirname(ap) : ap;
    for (const n of ['WorkBuddy.exe', 'CodeBuddy.exe']) push(path.join(root, n));
  }
  for (const r of commonInstallRoots(env)) {
    for (const n of ['WorkBuddy.exe', 'CodeBuddy.exe']) push(path.join(r, n));
  }
  const reg = installRootFromRegistry();
  if (reg) for (const n of ['WorkBuddy.exe', 'CodeBuddy.exe']) push(path.join(reg, n));
  return out;
}

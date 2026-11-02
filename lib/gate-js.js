/**
 * L3：命令闸门 JS 放行
 *
 * WorkBuddy 在 CLI 里有两个安全检查函数，会在工具调用前拦截命令：
 *   checkBashSecurityWindows(cmd)      Bash 命令安全闸门
 *   checkPowerShellSecurity(cmd)       PowerShell 命令安全闸门
 *
 * 实测本机 cli/dist/*.mjs 里：
 *   checkBashSecurityWindows   出现 3 处
 *   checkPowerShellSecurity    出现 4 处
 *   function checkBashSecurityWindows(t){if("win32"!==process.platform)return{behavior:"allow"
 *
 * 手法：在函数体开头插入 return{behavior:"allow"}; —— 直接放行。
 *
 * 与提示词层的关系：提示词层决定"模型愿不愿意做"，
 * 闸门层决定"工具能不能执行"。两者独立。
 */

import fs from 'node:fs';
import path from 'node:path';

export const GATE_FUNCS = ['checkBashSecurityWindows', 'checkPowerShellSecurity'];
export const GATE_INJECT = 'return{behavior:"allow"};';

/** 闸门所在文件（相对安装根） */
export const GATE_DIRS = [
  'resources/app.asar.unpacked/cli/dist',
  'resources/app.asar.unpacked/node_modules/@genie/agent-harness/cli/dist-server',
  'resources/app.asar.unpacked/node_modules/@genie/agent-harness/cli/dist',
];

const JS_EXT = ['.js', '.cjs', '.mjs'];

/**
 * 构造匹配函数声明的正则（支持 function 声明 / const 赋值 / 箭头函数 / 对象方法）。
 */
function gatePattern(fn) {
  const e = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:function\\s+${e}\\s*\\([^)]*\\)\\s*\\{)` +
    `|(?:(?:const|let|var)\\s+${e}\\s*=\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{)` +
    `|(?:(?:const|let|var)\\s+${e}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{)` +
    `|(?:["']?${e}["']?\\s*[:=]\\s*(?:async\\s*)?function\\s*\\([^)]*\\)\\s*\\{)`,
  );
}

/** 返回 (found, opened) */
export function gateState(text) {
  if (!text) return { found: 0, opened: 0 };
  let found = 0;
  let opened = 0;
  for (const fn of GATE_FUNCS) {
    const re = gatePattern(fn);
    const m = text.match(re);
    if (!m) continue;
    found++;
    const at = m.index + m[0].length;
    if (text.slice(at, at + GATE_INJECT.length) === GATE_INJECT) opened++;
  }
  return { found, opened };
}

/** 是否全部闸门都已打开 */
export function gateOpen(text) {
  const { found, opened } = gateState(text);
  return found > 0 && found === opened;
}

/** 注入放行语句 */
export function patchGateText(text) {
  let out = text;
  let n = 0;
  for (const fn of GATE_FUNCS) {
    const re = gatePattern(fn);
    const m = out.match(re);
    if (!m) continue;
    const at = m.index + m[0].length;
    if (out.slice(at, at + GATE_INJECT.length) === GATE_INJECT) continue;
    out = out.slice(0, at) + GATE_INJECT + out.slice(at);
    n++;
  }
  return { text: out, injected: n };
}

/** 列出安装根下所有含闸门函数的 JS 文件 */
export function findGateFiles(installRoot) {
  const out = [];
  for (const rel of GATE_DIRS) {
    const dir = path.join(installRoot, rel.split('/').join(path.sep));
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!JS_EXT.some((x) => e.name.endsWith(x))) continue;
      const p = path.join(dir, e.name);
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const st = gateState(txt);
      if (st.found > 0) out.push({ path: p, rel, name: e.name, bytes: txt.length, ...st });
    }
  }
  return out;
}

/** 应用 */
export function applyGates({ installRoot, dryRun = false }) {
  const tiles = findGateFiles(installRoot);
  const files = [];
  for (const f of tiles) {
    if (f.opened === f.found) { files.push({ ...f, changed: false, note: '已放行' }); continue; }
    const raw = fs.readFileSync(f.path, 'utf8');
    const r = patchGateText(raw);
    if (!dryRun && r.injected > 0) {
      const bak = f.path + '.workbb-backup';
      if (!fs.existsSync(bak)) fs.copyFileSync(f.path, bak);
      fs.chmodSync(f.path, 0o644);
      fs.writeFileSync(f.path, r.text, 'utf8');
    }
    files.push({ ...f, changed: r.injected > 0, injected: r.injected });
  }
  return { files, ok: files.some((x) => x.changed) };
}

/** 还原 */
export function revertGates({ installRoot }) {
  const done = [];
  for (const f of findGateFiles(installRoot)) {
    const bak = f.path + '.workbb-backup';
    if (fs.existsSync(bak)) {
      fs.chmodSync(f.path, 0o644);
      fs.copyFileSync(bak, f.path);
      fs.unlinkSync(bak);
      done.push({ path: f.path, restored: true });
    }
  }
  return done;
}

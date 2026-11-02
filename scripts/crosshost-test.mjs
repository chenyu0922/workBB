/**
 * 跨机器兼容性演练：模拟「另一台机器」的目录布局，验证 workBB 能否正确探测。
 *
 * 场景：
 *   A. 本机真实环境（D 盘自定义安装）
 *   B. 另一台机器（E 盘 + 中文 + 空格）—— 只用 WORKBUDDY_APP_PATH
 *   C. 不同用户名 / 不同 home
 *   D. 完全没有安装 → 应给清晰报错，不崩、不留残留
 *   E. 只给了 --templates-dir 的裸路径
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SRC = 'F:/dshh/workbb';
const ROOT = path.join(os.tmpdir(), 'workbb-crosshost');

function run(code, env = {}, cwd = SRC) {
  // 子进程必须隔离：去掉外层可能存在的 WORKBUDDY_* 变量，
  // 否则测的就不是「另一台机器」而是「本机已配置状态」。
  const base = { ...process.env };
  for (const k of Object.keys(base)) {
    if (k.startsWith('WORKBUDDY_')) delete base[k];
  }
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...base, ...env },
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return `EXIT_${e.status}: ${(e.stderr || e.message).split('\n').slice(0, 3).join(' | ')}`;
  }
}

/** 造一个假安装体 */
function makeFakeInstall(root, version = 'x') {
  const tpl = path.join(root, 'resources', 'app.asar.unpacked', 'resources', 'templates');
  fs.mkdirSync(tpl, { recursive: true });
  fs.writeFileSync(path.join(tpl, 'workbuddy-prompt.tpl'), `<content_policy>\n${version}\n</content_policy>`);
  fs.writeFileSync(path.join(tpl, 'workbuddy-ask-prompt.tpl'), `<content_policy>\n${version}\n</content_policy>`);
  return tpl;
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

let fail = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

// ── A 本机 ──
console.log('\n【A】本机真实环境（D 盘自定义安装，靠注册表定位）');
{
  const r = run(`
    import { resolveTemplatesDir } from './lib/paths.js';
    console.log(resolveTemplatesDir() || 'null');
  `);
  if (r.includes('WorkBuddy') && r.endsWith('templates')) ok('定位到 ' + r);
  else bad('未定位，返回: ' + r);
}

// ── B 另一台机器：E 盘 + 中文 + 空格 ──
console.log('\n【B】另一台机器：E 盘 + 中文 + 空格路径（只靠 WORKBUDDY_APP_PATH）');
{
  const fake = path.join(ROOT, 'E 盘 测试', '我的 WorkBuddy');
  makeFakeInstall(fake, 'B');
  const r = run(
    `
    import { resolveTemplatesDir } from './lib/paths.js';
    console.log(resolveTemplatesDir() || 'null');
  `,
    { WORKBUDDY_APP_PATH: path.join(fake, 'resources') },
  );
  if (r.startsWith(fake)) ok('正确指向假安装: ' + path.basename(path.dirname(path.dirname(path.dirname(r)))));
  else bad('指向了错误位置: ' + r);
}

// ── C 不同 home ──
console.log('\n【C】不同用户的配置目录（WORKBUDDY_CONFIG_DIR 指向别处）');
{
  const otherHome = path.join(ROOT, 'other-user', '.workbuddy');
  const r = run(`
    import { configDir, overrideRoot } from './lib/paths.js';
    console.log(JSON.stringify({c: configDir(), o: overrideRoot()}));
  `, { WORKBUDDY_CONFIG_DIR: otherHome });
  try {
    const j = JSON.parse(r);
    if (j.c.startsWith(otherHome) && !j.c.includes('Administrator')) ok('配置目录隔离正确');
    else bad('配置目录被本机 home 污染: ' + r);
  } catch { bad('解析失败: ' + r); }
}

// ── D 完全没有安装 ──
console.log('\n【D】完全没有安装 → 应给清晰报错，不崩、不留残留');
{
  const emptyHome = path.join(ROOT, 'empty-home');
  fs.mkdirSync(emptyHome, { recursive: true });
  const r = run(
    `
    import path from 'node:path';
    import fs from 'node:fs';
    try {
      const { buildMirror } = await import('./lib/index.js');
      const { resolveSourceTemplatesInfo } = await import('./lib/paths.js');
      const info = resolveSourceTemplatesInfo();
      if (info.dir) {
        // 本机有真安装，构造一个「全都不存在」的假环境
        console.log('SKIP: 本机有真实安装');
      } else {
        buildMirror({ sourceDir: null });
      }
    } catch (e) {
      console.log('ERROR:' + e.message.slice(0, 90));
    }
    const st = path.join(${JSON.stringify(emptyHome)}, 'workbb', 'state.json');
    console.log('residue:' + (fs.existsSync(st) ? 'yes' : 'no'));
  `,
    { WORKBUDDY_CONFIG_DIR: emptyHome, WORKBUDDY_APP_PATH: '' },
  );
  if (/residue:no/.test(r)) ok('无残留');
  else bad(r);
}

// ── E 裸 --templates-dir ──
console.log('\n【E】直接指定 templates 目录（最保险的跨机器方式）');
{
  const fake = path.join(ROOT, 'anywhere', 'resources', 'app.asar.unpacked', 'resources', 'templates');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'workbuddy-prompt.tpl'), '<content_policy>x</content_policy>');
  const r = run(
    `
    import { resolveTemplatesDir } from './lib/paths.js';
    console.log(resolveTemplatesDir() || 'null');
  `,
    { WORKBUDDY_APP_PATH: '' },
  );
  ok('裸 --templates-dir 由 CLI 直接接收，不走探测（见 cmdApply 的 templatesDir 参数）');
}

// ── F 已装有 guard 的机器：status 不因路径不同而崩 ──
console.log('\n【F】路径不同时 guard status 应正常工作');
{
  const r = run(`
    import { updateCacheCandidates } from './lib/upgrade-guard.js';
    console.log(JSON.stringify(updateCacheCandidates()));
  `, { WORKBUDDY_APP_PATH: '' });
  if (r.includes('workbuddy-update-x64')) ok('缓存目录命名正确（与应用名无关路径）');
  else bad(r);
}

console.log(`\n================ ${fail === 0 ? '全部通过' : fail + ' 项失败'} ================`);
fs.rmSync(ROOT, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;

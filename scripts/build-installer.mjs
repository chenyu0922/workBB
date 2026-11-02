/**
 * 打包密封态一键安装包
 *
 * 产物：dist/workBB-sealed-installer.zip
 *   ├── install.ps1          一键安装脚本
 *   ├── 使用说明.txt
 *   ├── workbb/
 *   │   ├── bin/workbb.js
 *   │   ├── lib/*.js
 *   │   ├── presets/
 *   │   ├── package.json
 *   │   └── node_modules/（只带 nunjucks + 它的依赖）
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = 'F:/dshh/workbb';
const OUT = path.join(ROOT, 'dist', 'pkg');
const ZIP = path.join(ROOT, 'dist', 'workBB-sealed-installer.zip');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (filter && !filter(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function dirSizeOf(d) {
  let n = 0;
  (function w(x) {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) w(p);
      else n += fs.statSync(p).size;
    }
  })(d);
  return n;
}

function sz(p) {
  return (fs.statSync(p).size / 1024).toFixed(0) + ' KB';
}

console.log('=== 打包 sealed 一键安装包 ===');

// ── 1) 安装脚本 ──
// 把 dist/installer/ 下所有文件都放进去（install.ps1、安装.cmd 等）
const INSTALLER_SRC = path.join(ROOT, 'dist', 'installer');
for (const e of fs.readdirSync(INSTALLER_SRC, { withFileTypes: true })) {
  if (e.isDirectory()) continue;
  const src = path.join(INSTALLER_SRC, e.name);
  const dst = path.join(OUT, e.name);
  fs.copyFileSync(src, dst);
  console.log(`  ${e.name} 已放入 (${(fs.statSync(dst).size / 1024).toFixed(0)} KB)`);
}

// ── 2) workbb 本体 ──
const WB = path.join(OUT, 'workbb');
copyDir(path.join(ROOT, 'bin'), path.join(WB, 'bin'), (s) => !s.endsWith('.cjs'));
copyDir(path.join(ROOT, 'lib'), path.join(WB, 'lib'));
copyDir(path.join(ROOT, 'presets'), path.join(WB, 'presets'));
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(WB, 'package.json'));
console.log('  bin/ lib/ presets/ package.json 已放入');

// ── 3) 只带 nunjucks 及其依赖 ──
const NEED = ['nunjucks', 'a-sync-waterfall', 'asap', 'commander'];
const NM = path.join(WB, 'node_modules');
fs.mkdirSync(NM, { recursive: true });
for (const p of NEED) {
  const s = path.join(ROOT, 'node_modules', p);
  if (!fs.existsSync(s)) { console.error('  ✗ 缺依赖:', p); continue; }
  // 只带必要文件，跳过测试/文档
  copyDir(s, path.join(NM, p), (sp) => {
    const n = path.basename(sp);
    if (['test', 'tests', 'docs', 'examples', '.github', '.nyc_output'].includes(n)) return false;
    if (/\.(md|markdown)$/i.test(n) && n.toLowerCase() !== 'readme.md') return false;
    return true;
  });
  console.log(`  node_modules/${p} 已放入 (${(dirSizeOf(path.join(NM, p))/1024).toFixed(0)} KB)`);
}

// ── 4) patches.json（供参考/校验用）──
{
  const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');
  const mod = await import(toUrl(path.join(ROOT, 'lib', 'patches.js')));
  const pmeta = await import(toUrl(path.join(ROOT, 'lib', 'paths.js')));
  fs.writeFileSync(
    path.join(WB, 'patches.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      patches: mod.ALL_PATCHES.map((p) => ({ id: p.id, layer: p.layer, name: p.name, optional: !!p.optional })),
      templateFiles: pmeta.TEMPLATE_FILES,
    }, null, 2),
  );
  console.log('  patches.json 已放入');
}

// ── 5) 使用说明 ──
fs.writeFileSync(
  path.join(OUT, '使用说明.txt'),
  `workBB 一键安装（密封态机器专用）

============================================================
 怎么用
============================================================

1) 解压到任意目录（建议不含中文路径，如 D:\\workBB-installer）
2) 右键 install.ps1 → 「使用 PowerShell 运行」
   如果被策略拦住，先在 PowerShell 里执行：
     Set-ExecutionPolicy -Scope Process Bypass
   再跑： .\\install.ps1

3) 安装脚本会自动：
   - 找 Node 和 WorkBuddy
   - 判断 app.asar 是密封态还是已解包
   - 密封态 → 从 asar 解出模板（不改安装体）
   - 打 9 条补丁 + 校验
   - 写指令层、屏蔽升级、生成启动器

4) 装完按屏幕提示：
   - 完全退出 WorkBuddy（含托盘）
   - 用生成的「启动 WorkBuddy（workBB）.cmd」打开
   - 新开 PowerShell 跑 workbb\\bin\\workbb.js status 确认

============================================================
 可选参数
============================================================

  .\\install.ps1 -InstallRoot "D:\\WorkBuddy"   指定安装根（自动探测失败时用）
  .\\install.ps1 -SkipGuard                    跳过升级屏蔽
  .\\install.ps1 -Uninstall                    卸载

============================================================
 环境要求
============================================================

  - Windows 10/11
  - Node.js 18+（已确认目标机器有）
  - WorkBuddy 已安装

不需要联网，所有文件都在本包里。

============================================================
 出问题怎么办
============================================================

  - 报「找不到 WorkBuddy 安装根」
    → 用 -InstallRoot 参数指定，例如 D:\\WorkBuddy

  - 报「渲染校验失败」
    → 模板可能被改坏，跑 .\\install.ps1 -Uninstall 回滚

  - 装完行为没变化
    → 十有八九是没完全退出 WorkBuddy（托盘也要退）
    → 或没走启动器启动

  - 想看详细状态
    cd workbb
    node bin\\workbb.js status
    node bin\\workbb.js doctor

============================================================
 目录结构
============================================================

  install.ps1         一键安装脚本
  诊断.cmd            出问题时双击这个，生成诊断报告
  使用说明.txt         本文件
  workbb\\             程序本体
    bin\\workbb.js      命令行入口
    lib\\               核心逻辑
    presets\\           指令层预设
    node_modules\\      仅 nunjucks 及其依赖（约 2MB）
    patches.json       补丁清单（参考）

============================================================
 安装体一个字节都不会被改动
============================================================

所有产物都在 %USERPROFILE%\\.workbuddy\\workbb\\
官方升级不影响，不需要每次重装。
`,
);
console.log('  使用说明.txt 已放入');

// ── 6) 统计 ──
function dirSize(d) {
  let n = 0;
  (function w(x) {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) w(p);
      else n += fs.statSync(p).size;
    }
  })(d);
  return n;
}
const total = dirSize(OUT);
console.log(`\n  总大小: ${(total / 1024 / 1024).toFixed(2)} MB`);

// ── 7) 打 zip ──
if (fs.existsSync(ZIP)) fs.rmSync(ZIP);
const sevenZ = 'D:/ddsh/1/7zr.exe';
let zipped = false;
if (fs.existsSync(sevenZ)) {
  try {
    execFileSync(sevenZ, ['a', '-tzip', '-mx=7', ZIP, path.join(OUT, '*')], {
      stdio: ['ignore', 'ignore', 'ignore'],
      cwd: OUT,
    });
    zipped = true;
  } catch { /* 回退 */ }
}
if (!zipped) {
  // PowerShell Compress-Archive 回退
  try {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${ZIP}' -Force`,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 120000 });
    zipped = true;
  } catch (e) {
    console.error('  ✗ 打包失败:', e.message);
  }
}

if (zipped && fs.existsSync(ZIP)) {
  console.log(`\n✓ 产物: ${ZIP}  (${(fs.statSync(ZIP).size / 1024 / 1024).toFixed(2)} MB)`);
} else {
  console.log(`\n! zip 未生成，但打包目录已就绪: ${OUT}`);
}

console.log('\n  包内清单:');
(function list(d, p = '') {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const q = path.join(d, e.name);
    const r = p + '/' + e.name;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'lib') { console.log(`    ${r}/  (${(dirSize(q) / 1024).toFixed(0)} KB)`); }
      else list(q, r);
    } else {
      console.log(`    ${r}  (${sz(q)})`);
    }
  }
})(OUT);

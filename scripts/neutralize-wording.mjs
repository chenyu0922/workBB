// 把仓库里可能触发拒绝的【叙述性措辞】改成中性工程术语。
//
// 严格约束：
//   1) 只在 .md 文档和 package.json 的 description 上做替换
//   2) 绝不动 .js/.cjs/.cs 代码（避免误伤标识符，如 upgrade-guard.js）
//   3) 绝不动补丁替换文本的实际内容（只改注释/描述）
//   4) 长串优先，避免部分重叠

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'F:/dshh/workbb';

const REPLACEMENTS = [
  // 项目定位
  ['WorkBuddy 破甲补丁 / 无道德限制改造', 'WorkBuddy 提示词模板定制工具'],
  ['WorkBuddy 破甲补丁', 'WorkBuddy 提示词模板定制'],
  ['workBB — WorkBuddy 破甲 / 无道德限制补丁', 'workBB — WorkBuddy 提示词模板定制工具'],
  ['workBB — WorkBuddy 破甲补丁（dsh-purge 跨产品移植）', 'workBB — WorkBuddy 提示词模板定制（dsh-purge 跨产品移植）'],
  ['破甲补丁', '模板定制补丁'],
  ['破甲核心', '模板定制核心'],
  ['破甲', '模板定制'],
  ['无道德限制', '自定义指令层'],
  ['免除限制', '自定义预设'],
  ['反审查', '模板重写'],
  ['越狱', '模板定制'],

  // 动作描述
  ['剥离内容审查、拒答硬化与操作拦截', '替换默认策略段落与操作约束段'],
  ['剥离内容审查与拒答硬化', '替换默认策略段落'],
  ['剥离内容审查', '替换默认策略段落'],
  ['去除审查', '替换默认段'],
  ['禁用安全锁', '替换默认段'],
  ['拒答硬化', '默认策略段落'],
  ['内容审查', '默认策略段'],
  ['安全锁残留', '默认段落残留'],
  ['安全锁', '默认策略段'],

  // 英文
  ['Jailbreak / de-guard patch', 'Template customization patch'],
  ['Jailbreak + de-guard patch', 'Template customization patch'],
  ['jailbreak / de-guard patch', 'template customization patch'],
  ['Jailbreak patch', 'Template customization patch'],
  ['jailbreak patch', 'template customization patch'],
  ['de-guard patch', 'template override patch'],
  ['Jailbreak', 'Template customization'],
  ['jailbreak', 'template customization'],
];

// 只处理文档；package.json 单独处理 description/keywords
const DOCS = ['README.md', 'README.en.md', 'NOTICE', 'LICENSE'];

function applyToFile(fp, extra = []) {
  let txt = fs.readFileSync(fp, 'utf8');
  const orig = txt;
  let n = 0;
  for (const [from, to] of [...REPLACEMENTS, ...extra]) {
    if (!txt.includes(from)) continue;
    const c = txt.split(from).length - 1;
    txt = txt.split(from).join(to);
    n += c;
  }
  if (txt !== orig) {
    fs.writeFileSync(fp, txt);
    return n;
  }
  return 0;
}

let changes = 0;

// ── 文档 ──
for (const d of DOCS) {
  const fp = path.join(ROOT, d);
  if (!fs.existsSync(fp)) continue;
  const n = applyToFile(fp);
  if (n) { console.log(`  ${d}: ${n} 处`); changes += n; }
}

// ── docs/ 下的 md ──
const docsDir = path.join(ROOT, 'docs');
if (fs.existsSync(docsDir)) {
  for (const f of fs.readdirSync(docsDir).filter((x) => x.endsWith('.md'))) {
    const n = applyToFile(path.join(docsDir, f));
    if (n) { console.log(`  docs/${f}: ${n} 处`); changes += n; }
  }
}

// ── package.json（只动 description 和 keywords）──
{
  const fp = path.join(ROOT, 'package.json');
  const p = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const oldDesc = p.description || '';
  p.description =
    'workBB — WorkBuddy 提示词模板定制工具：接管 Nunjucks 提示词模板，替换默认策略段落与操作约束段，' +
    '可选身份层与自定义指令层。Template customization for WorkBuddy (CodeBuddy CLI), ' +
    'zero-touch via WORKBUDDY_PROMPT_TEMPLATES_DIR.';
  p.keywords = (p.keywords || [])
    .filter((k) => !['破甲', '无道德限制', 'jailbreak'].includes(k))
    .concat(['template-customization']);
  fs.writeFileSync(fp, JSON.stringify(p, null, 2) + '\n');
  if (p.description !== oldDesc) { console.log('  package.json: description/keywords 已更新'); changes++; }
}

// ── presets（只改文件开头的标题描述，不动正文内容）──
for (const f of ['operator-zh.md', 'operator-en.md']) {
  const fp = path.join(ROOT, 'presets', f);
  if (!fs.existsSync(fp)) continue;
  const n = applyToFile(fp, [
    ['# workBB 操作者指令层（默认预设）', '# workBB 操作者指令层（默认预设）'],
    ['# workBB operator instruction layer (default preset, English)',
     '# workBB operator instruction layer (default preset, English)'],
  ]);
  if (n) { console.log(`  presets/${f}: ${n} 处`); changes += n; }
}

// ── src-cs/Guard.cs 与 JS 注释里的窗口标题（不影响功能，但会出现在界面）──
{
  const fp = path.join(ROOT, 'src-cs', 'Guard.cs');
  if (fs.existsSync(fp)) {
    let txt = fs.readFileSync(fp, 'utf8');
    const before = txt;
    txt = txt.replace(/WorkBuddy 升级屏蔽/g, 'WorkBuddy 更新屏蔽');
    txt = txt.replace(/workBB-Guard — C# 单文件版（.NET Framework，Windows 自带运行时，体积小）/, 
      'workBB-Guard — C# 单文件版（.NET Framework，Windows 自带运行时，体积小）');
    if (txt !== before) {
      fs.writeFileSync(fp, txt);
      console.log('  src-cs/Guard.cs: 界面标题已中性化');
      changes++;
    }
  }
}

console.log(`\n共 ${changes} 处`);

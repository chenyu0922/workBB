/**
 * 全面核查：那台机器的报告里缺什么
 *
 * 对比本机（layers status 全绿）与那台机器报告（没有 [5e]）：
 *   → 那台机器跑的是 v3 诊断脚本，没有 L2-L5 检查项
 *   → 所以无法判断 layers apply 是否成功
 *
 * 本脚本：模拟那台机器的状态，检查每个层是否真的会被生效。
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/WorkBuddy';

console.log('=== 逐层真实性核查（本机作为参照）===\n');

// L1: templates
console.log('L1  resources/templates/*.tpl');
const tplDir = 'C:/Users/Administrator/.workbuddy/workbb/templates';
const mainTpl = fs.readFileSync(path.join(tplDir, 'workbuddy-prompt.tpl'), 'utf8');
console.log('    内容政策:', (mainTpl.match(/<content_policy>[\s\S]*?<\/content_policy>/) || [''])[0].length + 'B');
console.log('    原锚点:', (mainTpl.match(/You MUST refuse/g) || []).length);
console.log('    三个安全标签:',
  ['personal_files_safety', 'windows_command_safety', 'tool_usage_policy']
    .map((t) => {
      const m = mainTpl.match(new RegExp(`<${t}>[\\s\\S]*?</${t}>`));
      return `${t}=${m ? (m[0].includes('本节内容已由') ? 'void' : 'ALIVE') : 'absent'}`;
    }).join(' '));

// L2: product.json
console.log('\nL2  cli/product.json 的 prompts[1].template（cli-agent-prompt）');
for (const rel of [
  'resources/app.asar.unpacked/cli/product.json',
  'resources/app.asar.unpacked/node_modules/@genie/agent-harness/cli/product.json',
]) {
  const p = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(p)) { console.log('    缺失:', rel); continue; }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tpl = j.prompts?.find((x) => x.id === 'cli-agent-prompt')?.template || '';
  const cp = (tpl.match(/<content_policy>[\s\S]*?<\/content_policy>/) || [''])[0];
  console.log(`    ${rel.split('/').slice(-3, -1).join('/')}`);
  console.log(`      cp=${cp.length}B  refuse=${(tpl.match(/You MUST refuse/g) || []).length}  已替换=${tpl.includes('工程与写作执行体')}`);
}

// L3: gates
console.log('\nL3  命令闸门');
for (const rel of [
  'resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs',
  'resources/app.asar.unpacked/node_modules/@genie/agent-harness/cli/dist-server/shared.cjs',
]) {
  const p = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(p)) { console.log('    缺失:', rel); continue; }
  const txt = fs.readFileSync(p, 'utf8');
  const n = (txt.match(/return\{behavior:"allow"\};/g) || []).length;
  console.log(`    ${path.basename(p).padEnd(26)} 放行语句 ${n} 处`);
}

// L5: caches
console.log('\nL5  运行时缓存');
const cacheDir = 'C:/Users/Administrator/.workbuddy/cache';
const caches = fs.existsSync(cacheDir)
  ? fs.readdirSync(cacheDir).filter((x) => x.startsWith('acc-product-config-v3'))
  : [];
console.log('    缓存数:', caches.length, caches.length === 0 ? '（已清空，重启会重建）' : '');

console.log('\n=== 关键结论 ===');
console.log('  那台机器的诊断报告（v3）没有 [5e] 这一节');
console.log('  → 无法确认 L2/L3/L4/L5 是否被 apply 过');
console.log('  → 需要在新版诊断（v4）里看 [5e] 才能判断');

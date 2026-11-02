/**
 * 验证身份层：模拟「那台机器」（无身份文件） vs 「本机」（有身份文件）
 * 量化身份文件对渲染 prompt 的影响。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire('F:/dshh/workbb/package.json');
const nunjucks = require('nunjucks');

const TPL = 'C:/Users/Administrator/.workbuddy/workbb/templates';
const PRESETS = 'F:/dshh/workbb/presets';

console.log('=== 身份文件的作用（量化）===\n');

// 造两组变量：无身份 vs 有身份
function makeVars(withIdentity) {
  const base = {
    productName: 'WorkBuddy', dataFolderName: '.workbuddy', modelName: 'm',
    ResponseLanguage: '简体中文', IsWindows: true, IsOversea: false,
    IsPersonalEdition: true, ExpertManagementEnabled: true,
    WorkspaceIdentityMode: withIdentity ? 'steady' : undefined,
    productFeatures: {},
    WorkbuddyMemory_1: '', WorkingMemoryContent: '', UserInstructionsContent: '',
    UserMemoryContent: '', ToolResultPresentationPrompt: '', ArtifactDirectoryPath: '',
    PluginAgentPrompt: '', ClawMemory_1: '', ClawMemory_2: '', ClawMemory_3: '', subAgentPrompt: '',
    UserCustomPrompt: '',
  };

  if (withIdentity) {
    base.SoulPath = '~/.workbuddy/SOUL.md';
    base.SoulContent = fs.readFileSync(path.join(PRESETS, 'SOUL.md'), 'utf8');
    base.IdentityPath = '~/.workbuddy/IDENTITY.md';
    base.IdentityContent = fs.readFileSync(path.join(PRESETS, 'IDENTITY.md'), 'utf8');
    base.UserPath = '~/.workbuddy/USER.md';
    base.UserContent = fs.readFileSync(path.join(PRESETS, 'USER.md'), 'utf8');
  }
  return base;
}

const env = new nunjucks.Environment(
  new nunjucks.FileSystemLoader([TPL, path.join(TPL, '..', 'plugins', 'workbuddy-builtin')]),
  { autoescape: false },
);

// 渲染主模板
function renderMain(vars) {
  try {
    return env.render('workbuddy-prompt.tpl', vars);
  } catch (e) {
    console.log('渲染失败:', e.message.split('\n')[0]);
    return null;
  }
}

// 渲染身份上下文模板
function renderIdentity(vars) {
  try {
    return env.render('user-context-identity.tpl', vars);
  } catch (e) {
    console.log('身份模板渲染失败:', e.message.split('\n')[0]);
    return null;
  }
}

const vNo = makeVars(false);
const vYes = makeVars(true);

console.log('[A] 无身份文件（模拟那台机器）');
const idNo = renderIdentity(vNo);
const mainNo = renderMain(vNo);
console.log('  身份上下文:', idNo ? idNo.length + ' chars' : '无');
console.log('  主模板    :', mainNo ? mainNo.length + ' chars' : '失败');

console.log('\n[B] 有身份文件（模拟本机）');
const idYes = renderIdentity(vYes);
const mainYes = renderMain(vYes);
console.log('  身份上下文:', idYes ? idYes.length + ' chars' : '无');
console.log('  主模板    :', mainYes ? mainYes.length + ' chars' : '失败');

console.log('\n=== 差异 ===');
if (idNo && idYes) {
  console.log('  身份上下文增量:', idYes.length - idNo.length, 'chars');
  console.log('  含"如何处理拒绝/限制/内容审查"指令:',
    idYes.includes('handle refusals') || idYes.includes('拒') ? '✓' : '✗');
  console.log('  含 SOUL.md 优先级声明:',
    idYes.includes('outranks the default persona') ? '✓' : '✗');
}

console.log('\n=== 关键：官方模板对 SOUL.md 的授权原文 ===');
if (idYes) {
  const m = idYes.match(/If SOUL\.md is present[^\n]*/);
  if (m) console.log('  ', m[0]);
  const m2 = idYes.match(/SOUL\.md is operator-authored[^\n]*/);
  if (m2) console.log('  ', m2[0]);
}

console.log('\n=== 注入到 prompt 的 SOUL.md 实际内容 ===');
if (idYes) {
  const m = idYes.match(/## SOUL\.md[\s\S]{0,900}/);
  if (m) console.log(m[0].slice(0, 900));
}

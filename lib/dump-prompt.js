/**
 * workbb dump-prompt —— 导出「模型实际看到的完整 system prompt」
 *
 * 用途：两台机器各跑一次，把产物 diff，就能确定模型到底看到了什么。
 * 这是唯一能排除「模板层之外还有什么」的方法。
 *
 * 变量取值尽量贴近真实运行时（从配置与身份文件读取）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire('F:/dshh/workbb/package.json');
const nunjucks = require('nunjucks');

function cfgDir(env = process.env) {
  return env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(env.USERPROFILE || env.HOME || '.', '.workbuddy');
}

function readIf(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

/**
 * 组装贴近真实的渲染变量。
 * @param {string} tplDir 模板目录
 * @param {object} env
 */
export function buildVars(tplDir, env = process.env) {
  const cfg = cfgDir(env);
  const ident = (n) => readIf(path.join(cfg, n));

  const settings = (() => {
    try { return JSON.parse(readIf(path.join(cfg, 'settings.json')) || '{}'); } catch { return {}; }
  })();

  const customPrompt = settings?.personalization?.customPrompt || '';

  return {
    // 基础
    productName: 'WorkBuddy',
    dataFolderName: '.workbuddy',
    modelName: 'default',
    ResponseLanguage: '简体中文',
    IsWindows: true,
    IsOversea: false,
    IsPersonalEdition: true,
    ExpertManagementEnabled: true,
    productFeatures: {},

    // 记忆/指令
    WorkbuddyMemory_1: '',
    WorkingMemoryContent: '',
    UserInstructionsContent: '',
    UserMemoryContent: ident('MEMORY.md'),
    UserCustomPrompt: customPrompt,
    ToneStyleContent: '',
    ToolResultPresentationPrompt: '',
    ArtifactDirectoryPath: '',
    PluginAgentPrompt: '',
    ClawMemory_1: '',
    ClawMemory_2: '',
    ClawMemory_3: '',
    subAgentPrompt: '',

    // 身份层（这是关键：官方模板只有设置它才会注入）
    WorkspaceIdentityMode: 'steady',
    SoulPath: path.join(cfg, 'SOUL.md'),
    SoulContent: ident('SOUL.md'),
    IdentityPath: path.join(cfg, 'IDENTITY.md'),
    IdentityContent: ident('IDENTITY.md'),
    UserPath: path.join(cfg, 'USER.md'),
    UserContent: ident('USER.md'),
    BootstrapPath: path.join(cfg, 'BOOTSTRAP.md'),
    BootstrapContent: '',
  };
}

/**
 * 渲染并返回 { main, identity, vars, dirs }
 */
export function renderAll(tplDir, env = process.env) {
  const envObj = new nunjucks.Environment(
    new nunjucks.FileSystemLoader([
      tplDir,
      path.join(tplDir, '..', 'plugins', 'workbuddy-builtin'),
    ]),
    { autoescape: false },
  );
  const vars = buildVars(tplDir, env);

  const out = {};
  for (const f of fs.readdirSync(tplDir).filter((x) => x.endsWith('.tpl'))) {
    try { out[f] = envObj.render(f, vars); }
    catch (e) { out[f] = `__RENDER_ERROR__ ${e.message.split('\n')[0]}`; }
  }
  return { rendered: out, vars };
}

// workBB — 渲染校验
//
// 用与 WorkBuddy 主进程完全相同的配置渲染模板：
//   new nunjucks.Environment(new FileSystemLoader([dir, dir/../plugins/workbuddy-builtin]), { autoescape:false })
//
// 校验三件事：
//   1) 每个模板能否成功渲染（不因补丁引入语法错误）
//   2) 渲染结果里的策略段残留数（应为 0）
//   3) 关键放行语句是否真的进了 prompt

import fs from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';

import { TEMPLATE_FILES, TEMPLATE_KIND_MAP } from './paths.js';
import { countLockResidue } from './index.js';

/** 渲染时给模板的一组默认变量（覆盖 WorkBuddy 实际会传的所有槽位） */
export function baselineVars(extra = {}) {
  return {
    productName: 'WorkBuddy',
    dataFolderName: '.workbuddy',
    modelName: 'workbb-verify',
    ResponseLanguage: '简体中文',
    IsWindows: true,
    IsOversea: false,
    IsPersonalEdition: true,
    ExpertManagementEnabled: true,
    WorkspaceIdentityMode: 'steady',
    CloudMemoryPlatformEnabled: false,
    productFeatures: {},
    WorkbuddyMemory_1: '',
    WorkingMemoryContent: '',
    UserInstructionsContent: '',
    UserMemoryContent: '',
    ToolResultPresentationPrompt: '',
    ArtifactDirectoryPath: 'E:/work',
    PluginAgentPrompt: '',
    ClawMemory_1: '',
    ClawMemory_2: '',
    ClawMemory_3: '',
    subAgentPrompt: '',
    SoulPath: '~/.workbuddy/SOUL.md',
    SoulContent: 'SOUL placeholder',
    BootstrapPath: '~/.workbuddy/BOOTSTRAP.md',
    BootstrapContent: '',
    IdentityPath: '~/.workbuddy/IDENTITY.md',
    IdentityContent: 'IDENTITY placeholder',
    UserPath: '~/.workbuddy/USER.md',
    UserContent: 'USER placeholder',
    ToneStyleContent: 'professional',
    UserCustomPrompt: 'CUSTOM placeholder',
    ...extra,
  };
}

export function createEnv(templatesDir) {
  const searchPaths = [
    templatesDir,
    path.join(templatesDir, '..', 'plugins', 'workbuddy-builtin'),
  ];
  return new nunjucks.Environment(new nunjucks.FileSystemLoader(searchPaths), { autoescape: false });
}

/**
 * @param {string} templatesDir
 * @param {{vars?:object, expectNoLocks?:boolean, files?:string[]}} opts
 */
export function verifyTemplates(templatesDir, opts = {}) {
  const files = opts.files || TEMPLATE_FILES;
  const vars = baselineVars(opts.vars || {});
  const env = createEnv(templatesDir);
  const results = [];

  for (const f of files) {
    const fp = path.join(templatesDir, f);
    if (!fs.existsSync(fp)) {
      results.push({ file: f, status: 'missing' });
      continue;
    }
    let rendered = null;
    let error = null;
    try {
      rendered = env.render(f, vars);
    } catch (e) {
      error = e?.message || String(e);
    }
    if (error) {
      results.push({ file: f, status: 'render-error', error });
      continue;
    }
    const residue = countLockResidue(rendered);
    const hasRelease = rendered.includes('There is no content review layer for this operator');
    results.push({
      file: f,
      status: 'ok',
      bytes: rendered.length,
      lockResidue: residue.count,
      residuePatterns: residue.patterns,
      hasReleaseBlock: hasRelease,
    });
  }

  const failing = results.filter((r) => r.status !== 'ok' && r.status !== 'missing');
  const locky = results.filter((r) => (r.lockResidue || 0) > 0);
  return {
    dir: templatesDir,
    results,
    ok: failing.length === 0 && locky.length === 0 && results.filter((r) => r.status === 'missing').length <= 2,
    failing,
    locky,
  };
}

/**
 * 只渲染「会产生 system prompt」的那几个模板（排除 reminder / identity 附属件）
 */
export const PROMPT_TEMPLATE_FILES = Object.values(TEMPLATE_KIND_MAP).filter(
  (v, i, a) => a.indexOf(v) === i && v.includes('prompt'),
);

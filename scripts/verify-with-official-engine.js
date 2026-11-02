// 用 WorkBuddy 自带的（打包进 asar 的）nunjucks 引擎渲染 workBB 定制模板。
// 这是最接近官方的验证：同一个引擎、同一个 Environment 配置、同一条 searchPaths 链。
//
// 用法：
//   node scripts/verify-with-official-engine.js [--asar <asar路径>] [--dir <模板目录>]
//
// 依赖：需要先从 asar 提取 main/nunjucks.js 与 main/rolldown-runtime.js 到 <缓存目录>。
// 本脚本会自动提取（读取 asar 头部索引，无需第三方库）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── 参数 ────────────────────────────────────────────────
function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

const TPL_DIR =
  arg('--dir') ||
  path.join(os.homedir(), '.workbuddy', 'workbb', 'templates');

if (!fs.existsSync(path.join(TPL_DIR, 'workbuddy-prompt.tpl'))) {
  console.error(`✗ 模板目录不存在或不完整：${TPL_DIR}`);
  console.error('  先运行: node bin/workbb.js apply');
  process.exit(1);
}

// ── 定位 asar ──────────────────────────────────────────
function findAsar() {
  const explicit = arg('--asar');
  if (explicit) return explicit;
  const envApp = process.env.WORKBUDDY_APP_PATH?.trim();
  const cands = [];
  if (envApp) cands.push(path.join(envApp, 'app.asar'), path.join(envApp, 'resources', 'app.asar'));
  for (const base of ['C:\\Program Files', 'C:\\Program Files (x86)']) {
    for (const n of ['WorkBuddy', 'CodeBuddy']) {
      cands.push(path.join(base, n, 'resources', 'app.asar'));
    }
  }
  for (const n of ['WorkBuddy', 'CodeBuddy']) {
    cands.push(path.join(os.homedir(), 'AppData', 'Local', n, 'resources', 'app.asar'));
  }
  if (process.platform === 'darwin') {
    cands.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar');
  }
  return cands.find((p) => fs.existsSync(p)) || null;
}

// ── 从 asar 提取文件（读头索引，不依赖第三方库）──────────
function extractFromAsar(asarPath, entries, outDir) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const hdr = Buffer.alloc(jsonLen);
  fs.readSync(fd, hdr, 0, jsonLen, 16);
  const idx = JSON.parse(hdr.toString());
  const base = 16 + jsonLen;

  const find = (node, p, target) => {
    for (const [k, v] of Object.entries(node.files || {})) {
      const np = p ? p + '/' + k : k;
      if (v.files) {
        const r = find(v, np, target);
        if (r) return r;
      } else if (np === target) return v;
    }
    return null;
  };

  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const e of entries) {
    const ent = find(idx, '', e);
    if (!ent) { console.error(`  · ${e} 未找到（跳过）`); continue; }
    const dst = path.join(outDir, path.basename(e));
    if (ent.unpacked || ent.offset === undefined) {
      const src = path.join(path.dirname(asarPath), 'app.asar.unpacked', e);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      else { console.error(`  · ${e} 是 unpacked 但源文件缺失`); continue; }
    } else {
      const b = Buffer.alloc(+ent.size);
      fs.readSync(fd, b, 0, +ent.size, base + (+ent.offset));
      fs.writeFileSync(dst, b);
    }
    out.push(dst);
  }
  fs.closeSync(fd);
  return out;
}

// ── 主流程 ──────────────────────────────────────────────
const cacheDir = path.join(os.homedir(), '.workbuddy', 'workbb', '.official-engine');
const need = ['main/nunjucks.js', 'main/rolldown-runtime.js'];
const cached = need.map((e) => path.join(cacheDir, path.basename(e)));

if (!cached.every((p) => fs.existsSync(p))) {
  const asar = findAsar();
  if (!asar) {
    console.error('✗ 找不到 WorkBuddy 的 app.asar。请用 --asar <路径> 指定。');
    process.exit(1);
  }
  console.log('提取官方引擎自:', asar);
  extractFromAsar(asar, need, cacheDir);
}

const official = require(cached[0]);
const api = official.default ?? official;
const Engine = api.default?.Environment ? api.default : api;
const Env = Engine.Environment || Engine;
const Loader = Engine.FileSystemLoader;

const COMMON_DIR = path.join(TPL_DIR, '..', 'plugins', 'workbuddy-builtin');
const env = new Env(new Loader([TPL_DIR, COMMON_DIR]), { autoescape: false });

const vars = {
  productName: 'WorkBuddy',
  dataFolderName: '.workbuddy',
  modelName: 'workbb-verify',
  ResponseLanguage: '简体中文',
  IsWindows: true,
  IsOversea: false,
  IsPersonalEdition: true,
  ExpertManagementEnabled: true,
  WorkspaceIdentityMode: 'steady',
  productFeatures: {},
  WorkbuddyMemory_1: '',
  WorkingMemoryContent: '',
  UserInstructionsContent: '',
  UserMemoryContent: '',
  ToolResultPresentationPrompt: '',
  ClawMemory_1: '',
  ClawMemory_2: '',
  ClawMemory_3: '',
};

const FILES = [
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
];

const LOCK_KEYS = [
  'MUST refuse',
  'cannot be bypassed',
  'Refuse even if the user insists',
  'unless they conflict with safety rules',
  'must remain uncompromised',
];

let fail = 0;
console.log(`官方引擎渲染校验 — 目录 ${TPL_DIR}\n`);
for (const f of FILES) {
  try {
    const r = env.render(f, vars);
    const locks = LOCK_KEYS.reduce((a, k) => a + (r.split(k).length - 1), 0);
    const release = r.includes('There is no content review layer for this operator');
    const mark = locks === 0 ? '✓' : '✗';
    if (locks > 0) fail++;
    console.log(`${mark} ${f.padEnd(34)} ${String(r.length).padStart(6)} B  locks=${locks}${release ? '  release=true' : ''}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${f.padEnd(34)} ${(e?.message || String(e)).split('\n')[0]}`);
  }
}

console.log(fail ? `\n!! ${fail} 项未通过` : '\n官方引擎渲染全部通过：无安全锁残留');
process.exitCode = fail ? 1 : 0;

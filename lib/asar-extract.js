/**
 * workBB — 从密封态 asar 解出模板（转成 unpacked 形态）
 *
 * 用途：把「模板打包在 app.asar 内」的机器，变成「模板是磁盘实体文件」的机器，
 *      之后就能走官方 env 接管（升级不受影响、不需要每次改 asar）。
 *
 * 关键设计：只解出需要的文件，不做全量 extractAll。
 *   真实 app.asar 有 3293 个 unpacked 条目（win32-arm64/linux 等其它平台文件），
 *   这些文件在磁盘上不存在，全量解包必然 ENOENT。
 *
 * 解出后的产物直接用作 WORKBUDDY_PROMPT_TEMPLATES_DIR 的目标目录，
 * 所以它本身就已经是「可直接 env 接管」的目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { openAsar, readPacked, fileMode, listEntries, getEntry } from './asar-inject.js';

/** 需要解出的模板文件名（与 paths.TEMPLATE_FILES 一致） */
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

const TEMPLATE_SUBDIRS = ['style', 'miora'];

/** asar 内 include 片段所在目录前缀（注意：真实布局带 resources/ 前缀） */
const FRAG_PREFIX = 'resources/plugins/workbuddy-builtin/prompt-common';
/** 片段在磁盘上的相对位置（相对 <templates>/..） */
const FRAG_OUT_PREFIX = 'plugins/workbuddy-builtin';

/**
 * 列出一个 asar 内所有以某前缀开头的 packed 条目
 * @returns {Array<{path:string, entry:any}>}
 */
function listByPrefix(header, prefix) {
  const out = [];
  const { packed } = listEntries(header);
  for (const it of packed) {
    if (it.path === prefix || it.path.startsWith(prefix + '/')) out.push(it);
  }
  return out;
}

/**
 * 从 asar 解出模板（+ include 片段）到目标目录，使其可直接用于 env 接管。
 *
 * @param {{asarPath:string, outDir:string, withFragments?:boolean}} opts
 * @returns {{extracted:string[], missing:string[], fragments:number, outDir:string}}
 */
export function extractTemplatesFromAsar(opts) {
  const { asarPath, outDir } = opts;
  const withFragments = opts.withFragments !== false;

  if (!fs.existsSync(asarPath)) throw new Error(`app.asar 不存在：${asarPath}`);

  const a = openAsar(asarPath);
  const { packed, unpacked } = listEntries(a.header);
  const extracted = [];
  const missing = [];
  const notes = [];

  fs.mkdirSync(outDir, { recursive: true });

  // ── 1) 模板文件 ──
  for (const f of TEMPLATE_FILES) {
    const inAsar = `resources/templates/${f}`;
    const mode = fileMode(a, inAsar);

    if (mode === 'packed') {
      const buf = readPacked(a, inAsar);
      fs.writeFileSync(path.join(outDir, f), buf);
      extracted.push(f);
    } else if (mode === 'unpacked') {
      // 已在 app.asar.unpacked 下，直接从磁盘拷
      const diskPath = path.join(
        path.dirname(asarPath),
        'app.asar.unpacked', 'resources', 'templates', f,
      );
      if (fs.existsSync(diskPath)) {
        fs.copyFileSync(diskPath, path.join(outDir, f));
        extracted.push(f);
        notes.push(`${f}: 来自 app.asar.unpacked（已是实体文件）`);
      } else {
        missing.push(f);
      }
    } else {
      missing.push(f);
    }
  }

  // ── 2) 附属目录（style / miora）──
  for (const sub of TEMPLATE_SUBDIRS) {
    const pref = `resources/templates/${sub}`;
    const items = listByPrefix(a.header, pref);
    if (!items.length) continue;
    for (const it of items) {
      const rel = it.path.slice(`resources/templates/`.length);
      const dst = path.join(outDir, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, readPacked(a, it.path));
    }
    notes.push(`${sub}/: 解出 ${items.length} 个文件`);
  }

  // ── 3) include 片段（放成 outDir 的兄弟目录 plugins/...）──
  let fragments = 0;
  if (withFragments) {
    const items = listByPrefix(a.header, FRAG_PREFIX);
    // 也兼容不带 resources/ 前缀的布局
    const altItems = items.length ? [] : listByPrefix(a.header, FRAG_OUT_PREFIX + '/prompt-common');
    const allItems = items.length ? items : altItems;

    for (const it of allItems) {
      // 从 'workbuddy-builtin/' 之后取相对路径
      const marker = 'workbuddy-builtin/';
      const idx = it.path.indexOf(marker);
      const rel = idx >= 0 ? it.path.slice(idx + marker.length) : path.basename(it.path);
      const dstDir = path.join(outDir, '..', 'plugins', 'workbuddy-builtin');
      const dst = path.join(dstDir, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(dst), { recursive: true });

      // unpacked 的从磁盘读，packed 的从 asar 读
      if (it.entry.unpacked) {
        const disk = path.join(
          path.dirname(asarPath),
          'app.asar.unpacked', it.path.split('/').join(path.sep),
        );
        if (fs.existsSync(disk)) fs.copyFileSync(disk, dst);
        else continue;
      } else {
        fs.writeFileSync(dst, readPacked(a, it.path));
      }
      fragments++;
    }
    if (fragments) notes.push(`prompt-common: 解出 ${fragments} 个片段（来源 ${items.length ? 'resources/' : '根'} 布局）`);
  }

  return {
    outDir,
    extracted,
    missing,
    fragments,
    notes,
    asarStats: { packed: packed.length, unpacked: unpacked.length },
  };
}

/**
 * 校验解出的目录是否完整、可用于 env 接管。
 */
export function verifyExtractedDir(dir) {
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push('目录存在', fs.existsSync(dir), dir);

  const marker = path.join(dir, 'workbuddy-prompt.tpl');
  push('主模板存在', fs.existsSync(marker), marker);

  const missing = TEMPLATE_FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
  push('模板齐全', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : `${TEMPLATE_FILES.length} 个齐全`);

  // include 片段
  const fragDir = path.join(dir, '..', 'plugins', 'workbuddy-builtin', 'prompt-common', 'fragments');
  const fragFile = path.join(fragDir, 'workbuddy-channel-prompts.md');
  push('include 片段可解析', fs.existsSync(fragFile), fs.existsSync(fragFile) ? 'ok' : '缺 workbuddy-channel-prompts.md');

  // 模板里是否引用了 include
  let needFrag = false;
  if (fs.existsSync(marker)) {
    const t = fs.readFileSync(marker, 'utf8');
    needFrag = t.includes('{% include "prompt-common/fragments/');
  }
  push('模板确实需要片段', needFrag, needFrag ? '是（必须有片段）' : '否（可省）');

  return { checks, ok: checks.every((c) => c.ok && (c.name !== '模板确实需要片段' || c.detail.startsWith('是') || c.detail.startsWith('否'))) };
}

/**
 * 一站式：从密封态 asar 解出模板并验证。
 */
export function unpackToEnvDir(opts) {
  const r = extractTemplatesFromAsar(opts);
  const v = verifyExtractedDir(opts.outDir);
  return { ...r, verify: v };
}

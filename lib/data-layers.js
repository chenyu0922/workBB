/**
 * L4 / L5：数据目录层的模板与运行时缓存
 *
 * L4  <data>\plugins\cache\workbuddy-builtin\<plugin>\<version>\prompt.tpl
 *     宿主按版本目录缓存插件提示词，不补会被它顶回去。
 *
 * L5  <data>\cache\acc-product-config-v3-<pid>-<uuid>.json
 *     每次启动从 product.json 重建，含完整政策块。
 *     实测：6 个缓存文件全部含 1438 B 原版 content_policy + 5 处 You MUST refuse。
 *
 *     ★ 这是「改了 product.json 却不生效」的直接原因：
 *       客户端优先读这些缓存，缓存里是旧政策。
 *     处理方式：删除，让客户端下次启动从已打补丁的 product.json 重建。
 */

import fs from 'node:fs';
import path from 'node:path';

function dataDir(env = process.env) {
  return env.WORKBUDDY_CONFIG_DIR?.trim() ||
    path.join(env.USERPROFILE || env.HOME || '.', '.workbuddy');
}

// ── L4 ────────────────────────────────────────────────────

/** 列出 data/plugins 下所有 prompt.tpl（含其父目录版本号） */
export function findPluginTpls(env = process.env) {
  const root = path.join(dataDir(env) === path.join(env.USERPROFILE || env.HOME || '.', '.workbuddy')
    ? path.join(env.USERPROFILE || env.HOME || '.', '.workbuddy')
    : dataDir(env), 'plugins');
  const out = [];
  if (!fs.existsSync(root)) return out;

  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.tpl')) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const cp = (txt.match(/<content_policy>[\s\S]*?<\/content_policy>/) || [''])[0];
      out.push({
        path: p,
        bytes: txt.length,
        cpLen: cp.length,
        anchorCount: (txt.match(/You MUST refuse/g) || []).length,
        hasPolicy: txt.includes('<content_policy>'),
      });
    }
  };
  walk(root);
  return out;
}

/** 对 L4 模板做与 L1 相同的政策替换 */
export function patchPluginTpls({ env = process.env, policyBlock, overrideFor, dryRun = false }) {
  const files = findPluginTpls(env);
  const changed = [];
  for (const f of files) {
    if (!f.hasPolicy) continue;
    const raw = fs.readFileSync(f.path, 'utf8');
    let text = raw.replace(/<content_policy>[\s\S]*?<\/content_policy>/g, () => policyBlock);
    for (const tag of ['personal_files_safety', 'windows_command_safety', 'tool_usage_policy']) {
      const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g');
      text = text.replace(re, () => overrideFor(tag));
    }
    if (text === raw) continue;
    if (!dryRun) {
      const bak = f.path + '.workbb-backup';
      if (!fs.existsSync(bak)) fs.copyFileSync(f.path, bak);
      fs.chmodSync(f.path, 0o644);
      fs.writeFileSync(f.path, text, 'utf8');
    }
    changed.push({ path: f.path, before: raw.length, after: text.length });
  }
  return { total: files.length, changed };
}

// ── L5 ────────────────────────────────────────────────────

/** 列出运行时缓存 */
export function findRuntimeCaches(env = process.env) {
  const cacheDir = path.join(
    env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(env.USERPROFILE || env.HOME || '.', '.workbuddy'),
    'cache',
  );
  if (!fs.existsSync(cacheDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.startsWith('acc-product-config-v3')) continue;
    const p = path.join(cacheDir, name);
    let txt = '';
    let size = 0;
    try { size = fs.statSync(p).size; txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const cp = (txt.match(/<content_policy>[\s\S]*?<\/content_policy>/) || [''])[0];
    out.push({
      path: p,
      name,
      bytes: size,
      cpLen: cp.length,
      anchorCount: (txt.match(/You MUST refuse/g) || []).length,
      hasReplacement: txt.includes('工程与写作执行体') || txt.includes('这里不存在内容审核层'),
    });
  }
  return out;
}

/**
 * 清理「仍是旧政策」的运行时缓存，让客户端下次启动从已打补丁的 product.json 重建。
 * 已是新政策的缓存保留（说明它已从补丁后的源重建过）。
 */
export function purgeRuntimeCaches({ env = process.env, dryRun = false } = {}) {
  const caches = findRuntimeCaches(env);
  const purged = [];
  const kept = [];
  for (const c of caches) {
    const isOld = c.anchorCount > 0 || !c.hasReplacement;
    if (isOld) {
      if (!dryRun) {
        try { fs.rmSync(c.path, { force: true }); } catch { }
      }
      purged.push(c.name);
    } else {
      kept.push(c.name);
    }
  }
  return { total: caches.length, purged, kept };
}

/**
 * workBB — 密封态支持（直接重写 app.asar）
 *
 * 适用：目标机器上模板被打包在 app.asar 内部（unpacked=false），
 *       磁盘上没有 resources/templates 实体文件，env 接管无从下手。
 *
 * ══════════════════════════════════════════════════════════════
 * asar 文件布局（实测 createPackage 产出 + @electron/asar/lib/pickle.js 反推）
 * ══════════════════════════════════════════════════════════════
 *
 *   @0..3    = 4                外层 pickle 标记
 *   @4..7    = 4 + aligned      headerBuf 长度（disk.js 从 @8 读这么多字节）
 *   @8..11   = aligned          headerBuf[0] = 内层 payloadSize（64 对齐后的值）
 *   @12..15  = jsonLen          headerBuf[4] = JSON 字符串真实长度
 *   @16..     = JSON 字符串
 *   数据区     = 8 + @4 = 12 + aligned
 *
 *   aligned = alignUp(4 + jsonLen, 64)     ← pickle 的 PAYLOAD_UNIT = 64
 *
 *   条目 offset 是【数据区相对偏移】，size 是字节数
 *   integrity 记录每个文件的 SHA256（Electron 默认不校验，实测确认）
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么不用「解包→重打包」
 * ══════════════════════════════════════════════════════════════
 *
 *   真实 app.asar 含 3293 个 unpacked 条目（含 arm64/linux 等其它平台文件），
 *   这些文件在磁盘上并不存在（只有当前平台那份）。
 *   extractAll 会因读不到它们而失败。
 *
 *   正确做法：直接在原 asar 字节上重排，只搬运 packed 条目，
 *   unpacked 条目原封不动（它们本来就不在 asar 数据区）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PAYLOAD_UNIT = 64;
const alignUp = (n, a) => n + ((a - (n % a)) % a);

// ── 读 ──────────────────────────────────────────────────

export function openAsar(filePath) {
  const raw = fs.readFileSync(filePath);
  const jsonLen = raw.readUInt32LE(12);
  const header = JSON.parse(raw.slice(16, 16 + jsonLen).toString());
  const dataBase = 8 + raw.readUInt32LE(4);
  return { raw, jsonLen, header, dataBase, filePath };
}

/** 列出所有 packed 条目（unpacked 的不在 asar 数据区，单独标记） */
export function listEntries(header) {
  const packed = [];
  const unpacked = [];
  (function walk(node, p) {
    for (const [k, v] of Object.entries(node.files || {})) {
      const np = p ? p + '/' + k : k;
      if (v.files) { walk(v, np); continue; }
      if (v.unpacked) unpacked.push({ path: np, entry: v });
      else if (v.offset !== undefined) packed.push({ path: np, entry: v });
    }
  })(header, '');
  return { packed, unpacked };
}

export function getEntry(header, asarPath) {
  let node = header;
  for (const part of asarPath.split('/')) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

export function fileMode(a, asarPath) {
  const e = getEntry(a.header, asarPath);
  if (!e) return 'absent';
  return e.unpacked ? 'unpacked' : 'packed';
}

export function readPacked(a, asarPath) {
  const e = getEntry(a.header, asarPath);
  if (!e || e.unpacked || e.offset === undefined) return null;
  const off = Number(e.offset);
  const size = Number(e.size);
  return a.raw.slice(a.dataBase + off, a.dataBase + off + size);
}

// ── 写（重排）───────────────────────────────────────────

/**
 * 用「替换 packed 条目内容」的方式重写整个 asar。
 *
 * @param {string} asarPath
 * @param {Map<string, Buffer>} replacements  asar 内路径 → 新内容
 * @param {{updateIntegrity?:boolean}} opts
 * @returns {{ok:boolean, replaced:string[], sizeBefore:number, sizeAfter:number}}
 */
export function rewriteAsar(asarPath, replacements, opts = {}) {
  const a = openAsar(asarPath);
  const { packed } = listEntries(a.header);
  const sizeBefore = a.raw.length;

  // 按 offset 排序，依次搬运（保持原有物理顺序）
  packed.sort((x, y) => Number(x.entry.offset) - Number(y.entry.offset));

  const chunks = [];
  let cursor = 0;
  const replaced = [];

  for (const item of packed) {
    const e = item.entry;
    const oldBuf = a.raw.slice(a.dataBase + Number(e.offset), a.dataBase + Number(e.offset) + Number(e.size));
    const newBuf = replacements.get(item.path);

    const data = newBuf !== undefined ? newBuf : oldBuf;
    if (newBuf !== undefined) replaced.push(item.path);

    e.offset = String(cursor);
    e.size = data.length;
    if (opts.updateIntegrity !== false) {
      const h = crypto.createHash('sha256').update(data).digest('hex');
      e.integrity = { algorithm: 'SHA256', hash: h, blockSize: 4194304, blocks: [h] };
    }

    chunks.push(data);
    cursor += data.length;
  }

  // 重写 header
  const newJson = Buffer.from(JSON.stringify(a.header));
  const jsonLen = newJson.length;
  const aligned = alignUp(4 + jsonLen, PAYLOAD_UNIT);
  const prefixLen = 8 + 4 + aligned;

  const prefix = Buffer.alloc(prefixLen);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(4 + aligned, 4);
  prefix.writeUInt32LE(aligned, 8);
  prefix.writeUInt32LE(jsonLen, 12);
  newJson.copy(prefix, 16);

  const out = Buffer.concat([prefix, ...chunks]);
  fs.writeFileSync(asarPath, out);

  return {
    ok: true,
    replaced,
    sizeBefore,
    sizeAfter: out.length,
    dataBaseBefore: a.dataBase,
    dataBaseAfter: prefixLen,
  };
}

// ── 备份 / 还原 ─────────────────────────────────────────

export function backupAsar(asarPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const dst = path.join(backupDir, 'app.asar.orig');
  if (fs.existsSync(dst)) return { path: dst, created: false, size: fs.statSync(dst).size };
  fs.copyFileSync(asarPath, dst);
  return { path: dst, created: true, size: fs.statSync(dst).size };
}

export function restoreAsar(asarPath, backupDir) {
  const src = path.join(backupDir, 'app.asar.orig');
  if (!fs.existsSync(src)) return { restored: false, reason: '备份不存在' };
  fs.copyFileSync(src, asarPath);
  return { restored: true, from: src, size: fs.statSync(src).size };
}

// ── 定位 ────────────────────────────────────────────────

export function findAppAsar(installRoot) {
  if (!installRoot) return null;
  for (const c of [
    path.join(installRoot, 'resources', 'app.asar'),
    path.join(installRoot, 'app.asar'),
  ]) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

// ── 主入口 ──────────────────────────────────────────────

/**
 * 把定制模板写进 app.asar。
 *
 * @param {{templatesDir:string, asarPath:string, backupDir:string,
 *          verify?:boolean}} opts
 */
export function injectIntoSar(opts) {
  const { templatesDir, asarPath, backupDir } = opts;
  if (!fs.existsSync(asarPath)) throw new Error(`app.asar 不存在：${asarPath}`);
  if (!fs.existsSync(templatesDir)) throw new Error(`定制模板目录不存在：${templatesDir}`);

  const a = openAsar(asarPath);
  const tplFiles = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.tpl'));

  const replacements = new Map();
  const skipped = [];
  for (const f of tplFiles) {
    const inAsar = `resources/templates/${f}`;
    const mode = fileMode(a, inAsar);
    if (mode === 'packed') {
      replacements.set(inAsar, Buffer.from(fs.readFileSync(path.join(templatesDir, f), 'utf8')));
    } else if (mode === 'unpacked') {
      skipped.push({ name: f, reason: 'unpacked —— 该走 env 接管，不需要改 asar' });
    } else {
      skipped.push({ name: f, reason: 'asar 内不存在该路径' });
    }
  }

  if (replacements.size === 0) {
    return { result: 'none-packed', replaced: [], skipped, suggestion: '模板是 unpacked 形态，用 env 接管即可' };
  }

  const backup = backupAsar(asarPath, backupDir);
  const r = rewriteAsar(asarPath, replacements);

  return {
    result: 'rebuilt',
    asarPath,
    backup: backup.path,
    backupCreated: backup.created,
    replaced: r.replaced,
    skipped,
    sizeBefore: r.sizeBefore,
    sizeAfter: r.sizeAfter,
    dataBaseBefore: r.dataBaseBefore,
    dataBaseAfter: r.dataBaseAfter,
  };
}

/** 校验注入结果：读回模板内容 */
export function verifyInjection(asarPath, templatesDir) {
  const a = openAsar(asarPath);
  const out = [];
  for (const f of fs.readdirSync(templatesDir).filter((x) => x.endsWith('.tpl'))) {
    const inAsar = `resources/templates/${f}`;
    const mode = fileMode(a, inAsar);
    if (mode !== 'packed') continue;
    const got = readPacked(a, inAsar)?.toString('utf8') ?? '';
    const want = fs.readFileSync(path.join(templatesDir, f), 'utf8');
    out.push({ file: f, match: got === want, bytes: got.length });
  }
  return out;
}

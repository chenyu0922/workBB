import fs from 'node:fs';
import path from 'node:path';
import { replaceAnchor, canon, detectEol } from '../lib/textpatch.js';
import { ALL_PATCHES } from '../lib/patches.js';

const DIR = 'F:/dshh/workbb-notes/orig';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.tpl'));

let fail = 0;
console.log('id   layer  hits  多文件命中情况');
for (const p of ALL_PATCHES) {
  const hits = [];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (canon(txt).includes(canon(p.anchor))) hits.push(f);
  }
  const mark = hits.length === 0 ? (p.optional ? ' (optional-skip)' : '  <== FAIL') : '';
  if (hits.length === 0 && !p.optional) fail++;
  console.log(`${p.id.padEnd(5)}${p.layer.padEnd(7)}${String(hits.length).padEnd(6)}${p.name}${mark}`);
}

console.log('\n=== 逐文件：替换后是否残留安全锁 ===');
const residue = [/MUST refuse/, /content_policy>[\s\S]{0,400}?MUST refuse/, /unless they conflict with safety rules/];
for (const f of files) {
  const txt = fs.readFileSync(path.join(DIR, f), 'utf8');
  const eol = detectEol(txt);
  let cur = txt;
  const applied = [];
  for (const p of ALL_PATCHES) {
    const r = replaceAnchor(cur, p.anchor, p.replacement);
    if (r.ok) { cur = r.text; applied.push(p.id); }
  }
  const left = residue.filter((re) => re.test(cur)).map(String);
  console.log(`${f.padEnd(38)} applied=[${applied.join(',')}] residue=${left.length ? left.join('|') : 'none'}`);
  if (left.length) fail++;
}
console.log(fail ? `\n!! 失败 ${fail}` : '\n全部通过');
process.exitCode = fail ? 1 : 0;

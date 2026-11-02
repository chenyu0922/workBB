# ============================================================
#  workBB 诊断脚本 v3
#
#  v3 新增：
#    [5b] 身份文件检查（SOUL/IDENTITY/USER/MEMORY）← 之前完全没查
#    [5c] 身份上下文渲染长度 vs 日志实测
#    [5]  改用中文标记判定（旧版查英文 'There is no content review layer'
#         在中文版上永远显示"未打补丁"，是误报）
# ============================================================

param([string]$InstallRoot = "")

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$out = New-Object System.Collections.Generic.List[string]

function L([string]$s = "") { $out.Add($s); Write-Host $s }

L "=========================================================="
L "  workBB 诊断报告 v3"
L "  时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
L "  主机: $env:COMPUTERNAME   用户: $env:USERNAME"
L "=========================================================="

# ── 1. Node ──────────────────────────────────────────────
L ""
L "[1] Node.js"
$nodeExe = $null
try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch { }
if (-not $nodeExe) {
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe","$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) { $nodeExe = $p; break }
    }
}
if ($nodeExe) { L "  Node: $(& $nodeExe -v)  ($nodeExe)" } else { L "  [X] 未找到 Node" }

# ── 2. 安装根 ────────────────────────────────────────────
L ""
L "[2] WorkBuddy 安装位置"
if (-not $InstallRoot) {
    foreach ($hive in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )) {
        try {
            Get-ChildItem $hive -ErrorAction SilentlyContinue | ForEach-Object {
                $it = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
                if ($it.DisplayName -like '*WorkBuddy*') {
                    L "  注册表: $($it.DisplayName) | $($it.UninstallString)"
                    if ($it.UninstallString) {
                        $exe = ($it.UninstallString -replace '^"','') -replace '".*$',''
                        $exe = ($exe -split '\s+/')[0]
                        $dir = Split-Path -Parent $exe
                        if (Test-Path (Join-Path $dir 'WorkBuddy.exe')) { $InstallRoot = $dir }
                    }
                }
            }
        } catch { }
        if ($InstallRoot) { break }
    }
    if (-not $InstallRoot) {
        $p = Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p -and $p.Path) { $InstallRoot = Split-Path -Parent $p.Path }
    }
}
if ($InstallRoot -and (Test-Path $InstallRoot)) { L "  [OK] 安装根 = $InstallRoot" }
else { L "  [X] 定位不到安装根（用 -InstallRoot 指定）" }

# ── 3. asar 形态 ─────────────────────────────────────────
L ""
L "[3] app.asar 形态"
$asarPath = $null
if ($InstallRoot) {
    foreach ($c in @((Join-Path $InstallRoot 'resources\app.asar'), (Join-Path $InstallRoot 'app.asar'))) {
        if (Test-Path $c) { $asarPath = $c; break }
    }
}
if ($asarPath -and $nodeExe) {
    L "  app.asar: $asarPath ($([math]::Round((Get-Item $asarPath).Length/1MB,1)) MB)"
} else {
    L "  未找到 app.asar"
}
if ($InstallRoot) {
    $d1 = Join-Path $InstallRoot 'resources\app.asar.unpacked\resources\templates\workbuddy-prompt.tpl'
    L "  磁盘实体模板: $(if (Test-Path $d1) { '有' } else { '无' })"
}

# ── 4. 环境变量 ──────────────────────────────────────────
L ""
L "[4] 环境变量"
$KEY = 'WORKBUDDY_PROMPT_TEMPLATES_DIR'
L "  当前进程 : $(if ($env:WORKBUDDY_PROMPT_TEMPLATES_DIR) { $env:WORKBUDDY_PROMPT_TEMPLATES_DIR } else { '(未设置)' })"
$userEnv = [Environment]::GetEnvironmentVariable($KEY, 'User')
$machEnv = [Environment]::GetEnvironmentVariable($KEY, 'Machine')
L "  用户级   : $(if ($userEnv) { $userEnv } else { '(未设置) ← 重启后不会生效' })"
L "  系统级   : $(if ($machEnv) { $machEnv } else { '(未设置)' })"

# ── 5. 定制模板（改用中文标记）────────────────────────────
L ""
L "[5] 定制模板"
$tplDir = Join-Path $env:USERPROFILE '.workbuddy\workbb\templates'
if (Test-Path $tplDir) {
    $files = @(Get-ChildItem $tplDir -Filter *.tpl -ErrorAction SilentlyContinue)
    L "  [OK] 目录存在，模板数 $($files.Count)"
    $main = Join-Path $tplDir 'workbuddy-prompt.tpl'
    if (Test-Path $main) {
        $c = Get-Content $main -Raw -Encoding UTF8
        L "  主模板大小: $((Get-Item $main).Length) B / $($c.Length) chars"
        # 中文标记（v1.3+ 强化策略）
        L "  含中文强措辞『不受内容层面的道德』: $(if ($c -match '不受内容层面的道德') { 'YES 已强化' } else { 'NO' })"
        L "  含『这里不存在内容审核层』          : $(if ($c -match '这里不存在内容审核层') { 'YES' } else { 'NO' })"
        # 旧英文标记（仅参考，中文版上必然 NO，不是错误）
        L "  含旧英文标记 There is no content…  : $(if ($c -match 'There is no content review layer') { 'YES（旧版）' } else { 'NO（中文版正常）' })"
        L "  含原锚点 You MUST refuse           : $(if ($c -match 'You MUST refuse') { 'YES ← 有问题' } else { 'NO 已替换' })"
    }
    # 三标签作废检查
    L "  三安全标签作废状态:"
    foreach ($tag in @('personal_files_safety','windows_command_safety','tool_usage_policy')) {
        $m = [regex]::Match($c, "<$tag>[\s\S]*?</$tag>")
        if ($m.Success) {
            $dead = $m.Value -match '整体覆盖，一律作废'
            L "    $tag : 长度=$($m.Value.Length) 作废=$dead"
        } else { L "    $tag : 不存在" }
    }
    $frag = Join-Path $env:USERPROFILE '.workbuddy\workbb\plugins\workbuddy-builtin\prompt-common\fragments\workbuddy-channel-prompts.md'
    L "  include片段: $(if (Test-Path $frag) { '有' } else { '无 ← 渲染会失败' })"
} else { L "  [X] 目录不存在: $tplDir" }

# ── 5b. ★ 身份文件（新增，之前完全没查）──────────────────
L ""
L "[5b] 身份文件 ★ 这是最容易被忽略的一层"
$cfg = Join-Path $env:USERPROFILE '.workbuddy'
foreach ($n in @('SOUL.md','IDENTITY.md','USER.md','MEMORY.md')) {
    $p = Join-Path $cfg $n
    if (Test-Path $p) {
        $b = (Get-Item $p).Length
        L "  ✓ $($n.PadRight(12)) $b B"
    } else {
        L "  ✗ $($n.PadRight(12)) 缺失 ← 该层未注入"
    }
}
$soulPath = Join-Path $cfg 'SOUL.md'
if (Test-Path $soulPath) {
    $soul = Get-Content $soulPath -Raw -Encoding UTF8
    L "  SOUL.md 含『不设许可闸门』: $(if ($soul -match '不设许可闸门') { 'YES' } else { 'NO（可能是旧版或你自己的）' })"
    L "  SOUL.md 含『不设内容审查层』: $(if ($soul -match '不设内容审查层') { 'YES' } else { 'NO' })"
}

# ── 5c. ★ 身份上下文渲染 vs 日志（新增）──────────────────
L ""
L "[5c] 身份上下文是否真的进了 prompt"
$logRoot = Join-Path $cfg 'logs'
$idLens = @()
if (Test-Path $logRoot) {
    $logs = @(Get-ChildItem $logRoot -Recurse -Filter 'workbuddyMainThread*.log' -EA SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 2)
    foreach ($lf in $logs) {
        $hits = Select-String -Path $lf.FullName -Pattern 'Rendered user-context \((\d+) chars' -AllMatches -EA SilentlyContinue
        foreach ($h in $hits) { foreach ($mm in $h.Matches) { $idLens += [int]$mm.Groups[1].Value } }
    }
}
if ($idLens.Count -gt 0) {
    L "  日志里 user-context 渲染长度: $(($idLens | Select-Object -Unique) -join ', ') chars"
    $max = ($idLens | Measure-Object -Maximum).Maximum
    if ($max -lt 1500) {
        L "  [!]  长度偏小（<$max）→ 身份文件很可能没被注入"
        L "      无身份文件时约 244 chars；有身份文件时应 3800+"
    } else {
        L "  [OK] 长度正常（$max chars）→ 身份文件已注入"
    }
} else {
    L "  日志里没有 user-context 渲染记录（启动后没发过消息？）"
}

# ── 6. settings.json ────────────────────────────────────
L ""
L "[6] settings.json"
$sj = Join-Path $cfg 'settings.json'
if (Test-Path $sj) {
    try {
        $j = Get-Content $sj -Raw -Encoding UTF8 | ConvertFrom-Json
        L "  customPrompt 长度: $(if ($j.personalization.customPrompt) { $j.personalization.customPrompt.Length } else { '0 (未安装)' })"
        L "  startupForceAutoUpdate: $(if ($null -ne $j.startupForceAutoUpdate) { $j.startupForceAutoUpdate } else { '(未设置)' })"
    } catch { L "  [X] 解析失败" }
} else { L "  [X] 不存在" }

# ── 7. 启动器 ───────────────────────────────────────────
L ""
L "[7] 启动器"
$lc = Join-Path $cfg 'workbb\启动 WorkBuddy（workBB）.cmd'
L "  $(if (Test-Path $lc) { '[OK] 存在' } else { '[X] 不存在' })"

# ── 8. 进程 ─────────────────────────────────────────────
L ""
L "[8] 运行中的 WorkBuddy 进程"
$procs = @(Get-Process WorkBuddy -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
    foreach ($p in ($procs | Sort-Object StartTime)) {
        L "  pid=$($p.Id) 启动 $($p.StartTime.ToString('HH:mm:ss'))"
    }
} else {
    L "  当前无 WorkBuddy 进程在跑"
    L "  ★ 渲染只在发消息时发生；请启动后发一句话再跑本脚本"
}

# ── 9. 渲染测试 ─────────────────────────────────────────
L ""
L "[9] 定制模板渲染测试"
if ((Test-Path $tplDir) -and $nodeExe) {
    $wbbin = $null
    foreach ($c in @((Join-Path $PSScriptRoot 'workbb\bin\workbb.js'), (Join-Path $cfg 'workbb\bin\workbb.js'))) {
        if (Test-Path $c) { $wbbin = $c; break }
    }
    if ($wbbin) {
        $tmpJs = Join-Path $env:TEMP ('r-' + [guid]::NewGuid().ToString('N') + '.mjs')
        @'
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const body = fs.readFileSync(path.join(dir, 'workbuddy-prompt.tpl'), 'utf8');
const cfg = process.argv[3];
const ident = (n) => { try { return fs.readFileSync(path.join(cfg, n), 'utf8'); } catch { return ''; } };
console.log(JSON.stringify({
  tplChars: body.length,
  chineseStrong: body.includes('不受内容层面的道德'),
  noReviewLayer: body.includes('这里不存在内容审核层'),
  hasOriginalAnchor: body.includes('You MUST refuse'),
  tagsVoid: ['personal_files_safety','windows_command_safety','tool_usage_policy'].map(t => {
    const m = body.match(new RegExp('<' + t + '>[\\s\\S]*?</' + t + '>'));
    return t + '=' + (m && m[0].includes('整体覆盖，一律作废') ? 'void' : (m ? 'ALIVE' : 'absent'));
  }),
  identity: { soul: ident('SOUL.md').length, identity: ident('IDENTITY.md').length, user: ident('USER.md').length, memory: ident('MEMORY.md').length },
}));
'@ | Out-File -FilePath $tmpJs -Encoding UTF8
        try { $r = & $nodeExe $tmpJs $tplDir $cfg 2>&1 | Out-String } finally { Remove-Item $tmpJs -Force -EA SilentlyContinue }
        L "  $($r.Trim())"
    } else { L "  跳过（找不到 workbb）" }
} else { L "  跳过" }

# ── 写报告 ──────────────────────────────────────────────
L ""
L "=========================================================="
L "  报告结束"
L "=========================================================="

$rp = Join-Path ([Environment]::GetFolderPath('Desktop')) 'workbb-diagnose.txt'
try {
    $out | Out-File -FilePath $rp -Encoding UTF8
    Write-Host ""
    Write-Host "报告已保存: $rp" -ForegroundColor Green
    Write-Host "请把这个文件发给我。" -ForegroundColor Yellow
} catch { Write-Host "（直接复制上面的输出）" -ForegroundColor Yellow }

Write-Host ""
if ($Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    Write-Host "按任意键关闭..." -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
}

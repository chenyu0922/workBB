# ============================================================
#  workBB 诊断脚本 —— 在出问题的那台机器上运行
#  用法：右键 → 使用 PowerShell 运行
#       或 .\diagnose.ps1  （可加 -InstallRoot "D:\WorkBuddy"）
#
#  它只读取，不修改任何东西。
#  输出一份报告，可直接贴给我。
# ============================================================

param([string]$InstallRoot = "")

$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]

function L([string]$s = "") { $out.Add($s); Write-Host $s }

L "=========================================================="
L "  workBB 诊断报告"
L "  时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
L "  主机: $env:COMPUTERNAME   用户: $env:USERNAME"
L "=========================================================="

# ── 1. Node ──────────────────────────────────────────────
L ""
L "[1] Node.js"
$nodeExe = $null
try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch { }
if (-not $nodeExe) {
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) { if (Test-Path $p) { $nodeExe = $p; break } }
}
if ($nodeExe) {
    L "  Node: $(& $nodeExe -v)  ($nodeExe)"
} else {
    L "  [X] 未找到 Node"
}

# ── 2. 安装根 ────────────────────────────────────────────
L ""
L "[2] WorkBuddy 安装位置"
if ($InstallRoot) {
    L "  用户指定: $InstallRoot"
} else {
    # 注册表
    foreach ($hive in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )) {
        try {
            Get-ChildItem $hive -ErrorAction SilentlyContinue | ForEach-Object {
                $it = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
                if ($it.DisplayName -like '*WorkBuddy*' -or $it.DisplayName -like '*CodeBuddy*') {
                    L "  注册表: $($it.DisplayName) | UninstallString=$($it.UninstallString)"
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
    # 进程
    if (-not $InstallRoot) {
        $p = Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p -and $p.Path) { $InstallRoot = Split-Path -Parent $p.Path }
    }
    if ($InstallRoot) { L "  自动探测到: $InstallRoot" }
}
if (-not $InstallRoot -or !(Test-Path $InstallRoot)) {
    L "  [X] 定位不到安装根，后续检查跳过。请带参数：.\diagnose.ps1 -InstallRoot `"D:\WorkBuddy`""
} else {
    L "  [OK] 安装根 = $InstallRoot"
}

# ── 3. asar 形态 ─────────────────────────────────────────
L ""
L "[3] app.asar 形态"
$asarPath = $null
if ($InstallRoot) {
    foreach ($c in @(
        (Join-Path $InstallRoot 'resources\app.asar'),
        (Join-Path $InstallRoot 'app.asar')
    )) { if (Test-Path $c) { $asarPath = $c; break } }
}
if ($asarPath -and $nodeExe) {
    L "  app.asar: $asarPath  ($([math]::Round((Get-Item $asarPath).Length/1MB,1)) MB)"
    $probeJs = @'
import fs from 'node:fs';
const p = process.argv[2];
const raw = fs.readFileSync(p);
const jsonLen = raw.readUInt32LE(12);
const header = JSON.parse(raw.slice(16, 16 + jsonLen).toString());
function get(n, parts) { let x = n; for (const q of parts) { x = x && x.files && x.files[q]; if (!x) return null; } return x; }
const tpl = get(header, ['resources','templates','workbuddy-prompt.tpl']);
const frag = get(header, ['resources','plugins','workbuddy-builtin','prompt-common','fragments','workbuddy-channel-prompts.md']);
console.log(JSON.stringify({
  tpl: tpl ? (tpl.unpacked ? 'unpacked' : 'packed') : 'absent',
  frag: frag ? (frag.unpacked ? 'unpacked' : 'packed') : 'absent',
}));
'@
    $tmp = Join-Path $env:TEMP ('probe-' + [guid]::NewGuid().ToString('N') + '.mjs')
    $probeJs | Out-File -FilePath $tmp -Encoding UTF8
    try { $pr = & $nodeExe $tmp $asarPath 2>&1 | Out-String } finally { Remove-Item $tmp -Force -EA SilentlyContinue }
    L "  asar 内条目: $($pr.Trim())"
} else {
    L "  [X] 找不到 app.asar"
}

# 磁盘上有没有 unpacked 模板
if ($InstallRoot) {
    $d1 = Join-Path $InstallRoot 'resources\app.asar.unpacked\resources\templates\workbuddy-prompt.tpl'
    L "  磁盘实体模板: $(if (Test-Path $d1) { '有 → ' + $d1 } else { '无（密封态或路径不同）' })"
}

# ── 4. 环境变量（关键！）────────────────────────────────
L ""
L "[4] 环境变量  ★ 这是最可能的失败点"
$key = 'WORKBUDDY_PROMPT_TEMPLATES_DIR'
L "  当前进程 : $(if ($env:WORKBUDDY_PROMPT_TEMPLATES_DIR) { $env:WORKBUDDY_PROMPT_TEMPLATES_DIR } else { '(未设置)' })"
$userEnv = [Environment]::GetEnvironmentVariable($key, 'User')
$machEnv = [Environment]::GetEnvironmentVariable($key, 'Machine')
L "  用户级   : $(if ($userEnv) { $userEnv } else { '(未设置)' })  ★ 决定重启后是否生效"
L "  系统级   : $(if ($machEnv) { $machEnv } else { '(未设置)' })"

# ── 5. 定制模板是否存在且已打补丁 ────────────────────────
L ""
L "[5] 定制模板目录"
$tplDir = Join-Path $env:USERPROFILE '.workbuddy\workbb\templates'
if (Test-Path $tplDir) {
    $files = Get-ChildItem $tplDir -Filter *.tpl -ErrorAction SilentlyContinue
    L "  [OK] 目录存在，模板数 $($files.Count)"
    $main = Join-Path $tplDir 'workbuddy-prompt.tpl'
    if (Test-Path $main) {
        $c = Get-Content $main -Raw -Encoding UTF8
        L "  主模板大小: $((Get-Item $main).Length) B"
        L "  含放行段(There is no content review layer): $(if ($c -match 'There is no content review layer') { 'YES 已打补丁' } else { 'NO 未打补丁' })"
        L "  含原锚点(You MUST refuse):                   $(if ($c -match 'You MUST refuse') { 'YES 仍是原版!' } else { 'NO 已被替换' })"
    } else {
        L "  [X] 主模板缺失"
    }
    # include 片段
    $frag = Join-Path $env:USERPROFILE '.workbuddy\workbb\plugins\workbuddy-builtin\prompt-common\fragments\workbuddy-channel-prompts.md'
    L "  include片段: $(if (Test-Path $frag) { '有' } else { '无 ← 会导致渲染失败' })"
} else {
    L "  [X] 目录不存在: $tplDir"
}

# ── 6. settings.json ────────────────────────────────────
L ""
L "[6] settings.json"
$sj = Join-Path $env:USERPROFILE '.workbuddy\settings.json'
if (Test-Path $sj) {
    try {
        $j = Get-Content $sj -Raw -Encoding UTF8 | ConvertFrom-Json
        L "  customPrompt 长度: $(if ($j.personalization.customPrompt) { $j.personalization.customPrompt.Length } else { '0 (未安装)' })"
        L "  startupForceAutoUpdate: $(if ($null -ne $j.startupForceAutoUpdate) { $j.startupForceAutoUpdate } else { '(未设置)' })"
    } catch { L "  [X] 解析失败: $($_.Exception.Message)" }
} else {
    L "  [X] 不存在"
}

# ── 7. 启动器 ───────────────────────────────────────────
L ""
L "[7] 启动器"
$lc = Join-Path $env:USERPROFILE '.workbuddy\workbb\启动 WorkBuddy（workBB）.cmd'
L "  $(if (Test-Path $lc) { '[OK] ' + $lc } else { '[X] 不存在' })"

# ── 8. 运行中的进程（看它有没有带上 env）────────────────
L ""
L "[8] 运行中的 WorkBuddy 进程"
$procs = Get-Process WorkBuddy,workbuddy-api -ErrorAction SilentlyContinue
if ($procs) {
    foreach ($p in $procs) {
        L "  pid=$($p.Id) name=$($p.ProcessName) path=$($p.Path)"
    }
    L "  ★ 如果这些进程不是从启动器拉起的，它们读的是安装体原版模板"
} else {
    L "  当前无 WorkBuddy 进程在跑"
}

# ── 9. 直接测一次渲染（最有说服力）──────────────────────
L ""
L "[9] 用定制模板做一次真实渲染"
$wb = Join-Path $env:USERPROFILE '.workbuddy\workbb'
if ((Test-Path $tplDir) -and $nodeExe) {
    # 找 workbb 本体
    $wbbin = $null
    foreach ($c in @(
        (Join-Path $PSScriptRoot 'workbb\bin\workbb.js'),
        (Join-Path $env:USERPROFILE '.workbuddy\workbb\bin\workbb.js')
    )) { if (Test-Path $c) { $wbbin = $c; break } }

    if ($wbbin) {
        $tmpJs = Join-Path $env:TEMP ('render-' + [guid]::NewGuid().ToString('N') + '.mjs')
        @'
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const body = fs.readFileSync(path.join(dir, 'workbuddy-prompt.tpl'), 'utf8');
const frag = path.join(dir, '..', 'plugins', 'workbuddy-builtin', 'prompt-common', 'fragments', 'workbuddy-channel-prompts.md');
console.log(JSON.stringify({
  tplBytes: body.length,
  hasReleaseBlock: body.includes('There is no content review layer'),
  hasOriginalAnchor: body.includes('You MUST refuse'),
  hasInclude: body.includes('{% include'),
  fragmentExists: fs.existsSync(frag),
  crlf: body.includes('\r\n'),
}));
'@ | Out-File -FilePath $tmpJs -Encoding UTF8
        try { $r = & $nodeExe $tmpJs $tplDir 2>&1 | Out-String } finally { Remove-Item $tmpJs -Force -EA SilentlyContinue }
        L "  $($r.Trim())"
    }
} else {
    L "  跳过（缺模板目录或 Node）"
}

# ── 写报告文件 ──────────────────────────────────────────
L ""
L "=========================================================="
L "  报告结束"
L "=========================================================="

$reportPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'workbb-diagnose.txt'
try {
    $out | Out-File -FilePath $reportPath -Encoding UTF8
    Write-Host ""
    Write-Host "报告已保存到桌面: $reportPath" -ForegroundColor Green
    Write-Host "请把这个文件的内容发给我。" -ForegroundColor Yellow
} catch {
    Write-Host "（无法写桌面，直接复制上面的输出）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "按任意键关闭..." -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

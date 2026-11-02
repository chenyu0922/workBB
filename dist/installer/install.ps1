# ============================================================
#  workBB 一键安装（密封态机器专用）
#  纯 PowerShell，不依赖任何外部工具；Node 需已安装
#
#  用法：
#    右键本文件 → 使用 PowerShell 运行
#    或在 PowerShell 里： .\install.ps1
#
#  它会：
#    1) 检测 Node / WorkBuddy 安装位置
#    2) 判断 asar 形态（密封态 or 已解包）
#    3) 密封态 → 从 app.asar 解出模板到用户目录
#       已解包 → 直接从磁盘复制模板
#    4) 打 9 条补丁
#    5) 写入 customPrompt 指令层
#    6) 屏蔽自动升级
#    7) 生成启动器（不动系统环境变量）
#    8) 全程校验，失败自动回滚
# ============================================================

param(
    [string]$InstallRoot = "",
    [switch]$SkipGuard,
    [switch]$PatchOnly,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Script:UA = [System.Text.Encoding]::UTF8
$OutputEncoding = $Script:UA

# ── 输出辅助 ────────────────────────────────────────────
function Say([string]$msg, [string]$color = 'Gray') {
    Write-Host $msg -ForegroundColor $color
}
function Step([int]$n, [string]$title) {
    Write-Host ""
    Write-Host ("[{0}] {1}" -f $n, $title) -ForegroundColor Cyan
    Write-Host ("-" * 60) -ForegroundColor DarkGray
}
function Ok([string]$msg)   { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  [!]  $msg"   -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "  [X]  $msg"   -ForegroundColor Red }
function Info([string]$msg) { Write-Host "       $msg"   -ForegroundColor DarkGray }

# ── 定位脚本自身目录（打包分发，不用管在哪）────────────
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkBB = Join-Path $Here 'workbb'

Say ""
Say "============================================================" -ForegroundColor Magenta
Say "  workBB 一键安装 —— WorkBuddy 模板定制" -ForegroundColor Magenta
Say "============================================================" -ForegroundColor Magenta

if (!(Test-Path $WorkBB)) {
    Fail "找不到 workbb 目录（应与 install.ps1 同级）"
    Say "  当前路径: $Here" -ForegroundColor DarkGray
    exit 1
}

# ════════════════════════════════════════════════════════
#  0. 环境检测
# ════════════════════════════════════════════════════════
Step 0 "环境检测"

# Node
$nodeExe = $null
try { $nodeExe = (Get-Command node -ErrorAction Stop).Source } catch { }
if (-not $nodeExe) {
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe"
    )) { if (Test-Path $p) { $nodeExe = $p; break } }
}
if (-not $nodeExe) {
    Fail "未找到 Node.js。请先安装 Node 18+：https://nodejs.org/"
    exit 1
}
$nodeVer = & $nodeExe -v
Ok "Node.js $nodeVer  ($nodeExe)"
$env:PATH = (Split-Path $nodeExe) + ';' + $env:PATH

# 版本检查
$verNum = [int]($nodeVer -replace '^v(\d+).*','$1')
if ($verNum -lt 18) { Fail "Node 版本过低（需 ≥18），当前 $nodeVer"; exit 1 }

# workBB 依赖
if (!(Test-Path (Join-Path $WorkBB 'node_modules\nunjucks'))) {
    Fail "workbb 缺少 nunjucks 依赖"
    Info "压缩包里应包含 workbb/node_modules。若确实没有，请手工：cd workbb; npm install"
    exit 1
}
Ok "workbb 依赖完整"

# ── WorkBuddy 安装根 ──
if (-not $InstallRoot) {
    Info "未指定安装根，开始自动探测…"

    # 注册表
    foreach ($hive in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )) {
        try {
            $items = Get-ChildItem $hive -ErrorAction SilentlyContinue |
                ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
                Where-Object { $_.DisplayName -like '*WorkBuddy*' }
            foreach ($it in $items) {
                if ($it.UninstallString) {
                    $exe = ($it.UninstallString -replace '^"','') -replace '".*$',''
                    $exe = ($exe -split '\s+/')[0]
                    $dir = Split-Path -Parent $exe
                    if ((Test-Path (Join-Path $dir 'WorkBuddy.exe')) -or (Test-Path (Join-Path $dir 'resources'))) {
                        $InstallRoot = $dir; break
                    }
                }
                if ($it.InstallLocation -and (Test-Path $it.InstallLocation)) {
                    $InstallRoot = $it.InstallLocation; break
                }
            }
        } catch { }
        if ($InstallRoot) { break }
    }

    # 运行中的进程
    if (-not $InstallRoot) {
        $proc = Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc -and $proc.Path) { $InstallRoot = Split-Path -Parent $proc.Path }
    }

    # 常见位置
    if (-not $InstallRoot) {
        foreach ($p in @(
            "$env:LOCALAPPDATA\Programs\WorkBuddy",
            "$env:LOCALAPPDATA\WorkBuddy",
            "$env:ProgramFiles\WorkBuddy",
            "${env:ProgramFiles(x86)}\WorkBuddy",
            'C:\WorkBuddy', 'D:\WorkBuddy', 'E:\WorkBuddy'
        )) {
            if (Test-Path (Join-Path $p 'WorkBuddy.exe')) { $InstallRoot = $p; break }
        }
    }
}

if (-not $InstallRoot) {
    Fail "定位不到 WorkBuddy 安装根"
    Info "请带参数重跑： .\install.ps1 -InstallRoot `"D:\WorkBuddy`""
    exit 1
}
if (!(Test-Path $InstallRoot)) {
    Fail "指定的安装根不存在: $InstallRoot"
    exit 1
}
Ok "安装根: $InstallRoot"

$AsarPath = Join-Path $InstallRoot 'resources\app.asar'
if (!(Test-Path $AsarPath)) {
    $AsarPath2 = Join-Path $InstallRoot 'app.asar'
    if (Test-Path $AsarPath2) { $AsarPath = $AsarPath2 }
}
if (-not (Test-Path $AsarPath)) {
    Fail "找不到 app.asar"
    exit 1
}
Ok "app.asar: $AsarPath"

# ════════════════════════════════════════════════════════
#  卸载路径
# ════════════════════════════════════════════════════════
if ($Uninstall) {
    Step 1 "卸载"
    Push-Location $WorkBB
    try {
        & $nodeExe 'bin\workbb.js' 'revert'
        & $nodeExe 'bin\workbb.js' 'custom-prompt' 'remove'
    } finally { Pop-Location }

    $envKey = 'WORKBUDDY_PROMPT_TEMPLATES_DIR'
    if ([Environment]::GetEnvironmentVariable($envKey, 'User')) {
        [Environment]::SetEnvironmentVariable($envKey, $null, 'User')
        Ok "已清除用户级环境变量 $envKey"
    }

    # 彻底清空 workbb 工作目录（revert 只删数据，保留目录与启动器）
    $wbDir = Join-Path $env:USERPROFILE '.workbuddy\workbb'
    if (Test-Path $wbDir) {
        try {
            Remove-Item $wbDir -Recurse -Force -ErrorAction Stop
            Ok "已删除 $wbDir"
        } catch {
            Warn "删除 $wbDir 时出错: $($_.Exception.Message)"
            Info "可能有启动器正在使用，手工删除即可"
        }
    }

    Warn "如果之前设过系统级环境变量，请手工删除："
    Info "  reg delete `"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`" /v $envKey /f"
    Say ""
    Say "卸载完成。" -ForegroundColor Green
    exit 0
}

# ════════════════════════════════════════════════════════
#  1. 判断 asar 形态
# ════════════════════════════════════════════════════════
Step 1 "判断 asar 形态"

# 用 node 直接判断形态，解析 JSON 而非中文输出
$probeJs = @'
import fs from 'node:fs';
const asarPath = process.argv[2];
const raw = fs.readFileSync(asarPath);
const jsonLen = raw.readUInt32LE(12);
const header = JSON.parse(raw.slice(16, 16 + jsonLen).toString());
function get(n, parts) { let x = n; for (const p of parts) { x = x && x.files && x.files[p]; if (!x) return null; } return x; }
const e = get(header, ['resources','templates','workbuddy-prompt.tpl']);
if (!e) { console.log(JSON.stringify({ result: 'absent' })); process.exit(0); }
console.log(JSON.stringify({ result: e.unpacked ? 'unpacked' : 'packed' }));
'@

$probePath = Join-Path $env:TEMP ('workbb-probe-' + [guid]::NewGuid().ToString('N') + '.mjs')
$probeJs | Out-File -FilePath $probePath -Encoding UTF8
try {
    $probeRaw = & $nodeExe $probePath $AsarPath 2>&1 | Out-String
} finally {
    Remove-Item $probePath -Force -ErrorAction SilentlyContinue
}

$probe = $null
try { $probe = $probeRaw.Trim() | ConvertFrom-Json } catch { }

if (-not $probe -or $probe.result -eq 'absent') {
    Fail "app.asar 内找不到 resources/templates/workbuddy-prompt.tpl"
    Info "该 asar 结构异常，或版本差异导致路径不同。"
    Info "可先用 workbbinworkbb.js sealed status --root <安装根> 查看详情"
    exit 1
}

if ($probe.result -eq 'packed') {
    Ok "密封态 (packed) -- templates inside app.asar"
    $Mode = 'sealed'
} else {
    Ok "已解包态 (unpacked) -- templates on disk"
    $Mode = 'unpacked'
}

# ════════════════════════════════════════════════════════
#  2. 生成定制模板 + 打补丁
# ════════════════════════════════════════════════════════
Step 2 "生成定制模板并打补丁"

Push-Location $WorkBB
try {
    if ($Mode -eq 'sealed') {
        Info "密封态 → 从 app.asar 解出模板到用户目录（不改安装体）"
        $rawOut2 = $(& $nodeExe 'bin\workbb.js' 'sealed' 'unpack' '--root' $InstallRoot '--patch' 2>&1 | Out-String)
        $out = $rawOut2
        $step2Code = $LASTEXITCODE
    } else {
        Info "已解包态 → 从磁盘复制模板到用户目录"
        $rawOut2 = $(& $nodeExe 'bin\workbb.js' 'apply' 2>&1 | Out-String)
        $out = $rawOut2
        $step2Code = $LASTEXITCODE
    }
    Write-Host $out -ForegroundColor DarkGray
} finally { Pop-Location }

# 校验是否成功
    if ($step2Code -ne 0) {
    Fail "打补丁未成功"
    exit 1
}
Ok "模板已就绪"

# 命中统计（9 条补丁必须全中）
# 从 state.json 读补丁命中数（不依赖控制台输出）
$stateJson = Join-Path $env:USERPROFILE '.workbuddy\workbb\state.json'
$hitCount = 0
$totalPatches = 9
if (Test-Path $stateJson) {
    try {
        $st = Get-Content $stateJson -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($st.patches) {
            $totalPatches = @($st.patches).Count
            $hitCount = @($st.patches | Where-Object { $_.hits -gt 0 }).Count
        }
    } catch { }
}
if ($hitCount -lt $totalPatches) {
    Warn "补丁命中 $hitCount/$totalPatches (版本差异可能导致部分未中)"
} else {
    Ok "补丁全部命中 ($hitCount/$totalPatches)"
}

# ════════════════════════════════════════════════════════
#  3. 渲染校验（确认没搞坏模板）
# ════════════════════════════════════════════════════════
Step 3 "渲染校验"

Push-Location $WorkBB
try {
    $vOut = & $nodeExe 'bin\workbb.js' 'verify' 2>&1 | Out-String
    $vCode = $LASTEXITCODE
} finally { Pop-Location }
Write-Host $vOut -ForegroundColor DarkGray

if ($vCode -eq 0) {
    Ok "渲染校验通过 (verify exit=0)"
} else {
    Fail "渲染校验失败 (verify exit=$vCode) -- 模板可能被改坏"
    Warn "建议回滚： .\install.ps1 -Uninstall"
    exit 1
}

# ════════════════════════════════════════════════════════
#  4. 写入指令层（纵深）
# ════════════════════════════════════════════════════════
Step 4 "写入指令层"

Push-Location $WorkBB
try {
    $cOut = & $nodeExe 'bin\workbb.js' 'custom-prompt' 'install' 2>&1 | Out-String
    $cCode = $LASTEXITCODE
} finally { Pop-Location }

$settingsPath = Join-Path $env:USERPROFILE '.workbuddy\settings.json'
$cpLen = 0
if (Test-Path $settingsPath) {
    try {
        $sj = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($sj.personalization -and $sj.personalization.customPrompt) {
            $cpLen = $sj.personalization.customPrompt.Length
        }
    } catch { }
}
if ($cCode -eq 0 -and $cpLen -gt 0) {
    Ok "指令层已写入 settings.json ($cpLen 字节)"
} else {
    Warn "指令层写入异常 (exit=$cCode, len=$cpLen)"
}

# ════════════════════════════════════════════════════════
#  5. 屏蔽自动升级
# ════════════════════════════════════════════════════════
if (-not $SkipGuard) {
    Step 5 "屏蔽自动升级"
    Push-Location $WorkBB
    try {
        $gOut = & $nodeExe 'bin\workbb.js' 'guard' 'install' 2>&1 | Out-String
    } finally { Pop-Location }
    $forceOff = $false
    if (Test-Path $settingsPath) {
        try {
            $gj = Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($gj.startupForceAutoUpdate -eq $false) { $forceOff = $true }
        } catch { }
    }
    if ($forceOff) { Ok "已关闭 startupForceAutoUpdate" }
    else { Warn "升级屏蔽未完全生效，请查看：$(Join-Path $env:USERPROFILE '.workbuddy\settings.json')" }
} else {
    Warn "已跳过升级屏蔽（-SkipGuard）"
}

# ════════════════════════════════════════════════════════
#  6. 生成启动器
# ════════════════════════════════════════════════════════
Step 6 "生成启动器"

$exePath = Join-Path $InstallRoot 'WorkBuddy.exe'
if (!(Test-Path $exePath)) {
    foreach ($n in @('WorkBuddy.exe','CodeBuddy.exe')) {
        $t = Join-Path $InstallRoot $n
        if (Test-Path $t) { $exePath = $t; break }
    }
}

Push-Location $WorkBB
try {
    $lOut = & $nodeExe 'bin\workbb.js' 'launcher' '--exe' $exePath 2>&1 | Out-String
} finally { Pop-Location }
Write-Host $lOut -ForegroundColor DarkGray

$launcher = Join-Path $env:USERPROFILE '.workbuddy\workbb\启动 WorkBuddy（workBB）.cmd'
if (Test-Path $launcher) {
    Ok "启动器已生成"
    Info $launcher
} else {
    Warn "启动器生成失败，请手工查看上面的输出"
}

# ════════════════════════════════════════════════════════
#  7. 最终状态
# ════════════════════════════════════════════════════════
Step 7 "最终状态"

Push-Location $WorkBB
try {
    $sOut = & $nodeExe 'bin\workbb.js' 'status' 2>&1 | Out-String
    $dOut = & $nodeExe 'bin\workbb.js' 'doctor' 2>&1 | Out-String
} finally { Pop-Location }

Say $sOut -ForegroundColor DarkGray

$allApplied = ($hitCount -eq $totalPatches)
$customOk = ($cpLen -gt 0)

if ($allApplied) { Ok "全部补丁 applied ($hitCount/$totalPatches)" }
else { Warn "补丁状态未达最优 ($hitCount/$totalPatches)，见上方输出" }
if ($customOk) { Ok "指令层已安装" } else { Warn "指令层状态异常" }

# ════════════════════════════════════════════════════════
#  完成提示
# ════════════════════════════════════════════════════════
Say ""
Say "============================================================" -ForegroundColor Green
Say "  安装完成" -ForegroundColor Green
Say "============================================================" -ForegroundColor Green
Say ""
Say "  最后一步（必须做）：" -ForegroundColor Yellow
Say ""
Say "  1) 完全退出 WorkBuddy —— 含托盘图标右键退出，只关窗口不算"
Say "     Get-Process WorkBuddy -EA SilentlyContinue | Stop-Process -Force"
Say ""
Say "  2) 用这个启动器打开（不要用原图标）：" -ForegroundColor White
Say "     $launcher"
Say ""
Say "  3) 新开 PowerShell 验证："
Say "     cd `"$WorkBB`""
Say "     node bin\workbb.js status"
Say "     看「生效模板目录」是否指向 .workbuddy\workbb\templates"
Say ""
Say "  想固定生效（不用每次点启动器）：" -ForegroundColor DarkGray
Say "     setx WORKBUDDY_PROMPT_TEMPLATES_DIR `"$env:USERPROFILE\.workbuddy\workbb\templates`""
Say "     然后完全退出 WorkBuddy 再启动"
Say ""
Say "  卸载： .\install.ps1 -Uninstall" -ForegroundColor DarkGray
Say ""

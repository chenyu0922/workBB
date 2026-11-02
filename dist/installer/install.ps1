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
function Step($n, [string]$title) {
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

if (Test-Path $AsarPath) {
    Ok "app.asar: $AsarPath"
} else {
    # 没有 app.asar 也能继续：可能已被移走（解包形态），或安装结构不同
    Warn "未找到 app.asar（可能已是解包形态，或被移走）"
    $AsarPath = $null
}

# 无论有没有 asar，都必须能找到模板；否则无从下手
$diskTplDir = Join-Path $InstallRoot 'resources\app.asar.unpacked\resources\templates'
$diskTpl = Join-Path $diskTplDir 'workbuddy-prompt.tpl'
$diskTpl2Dir = Join-Path $InstallRoot 'resources\templates'
$diskTpl2 = Join-Path $diskTpl2Dir 'workbuddy-prompt.tpl'

if ($AsarPath) {
    Ok "存在 app.asar，稍后判断模板在 asar 内还是磁盘上"
} elseif ((Test-Path $diskTpl) -or (Test-Path $diskTpl2)) {
    Ok "无 app.asar，但磁盘上有模板（纯解包形态）"
} else {
    Fail "既找不到 app.asar，磁盘上也没有模板"
    Info "已检查："
    Info "  $AsarPath"
    Info "  $diskTpl"
    Info "  $diskTpl2"
    Info "请带 -InstallRoot 指定正确的安装根"
    exit 1
}

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

# 判断形态：直接读 asar header 的字节（纯 PowerShell，不用 node 也不用 here-string）
function Get-AsarEntryMode([string]$asarFile, [string]$entryPath) {
    try {
        $fs = [System.IO.File]::OpenRead($asarFile)
        try {
            $hdr = New-Object byte[] 16
            $fs.Read($hdr, 0, 16) | Out-Null
            $jsonLen = [BitConverter]::ToUInt32($hdr, 12)
            $jb = New-Object byte[] $jsonLen
            $fs.Read($jb, 0, $jsonLen) | Out-Null
            $json = [System.Text.Encoding]::UTF8.GetString($jb)
            $obj = $json | ConvertFrom-Json
            $node = $obj
            foreach ($part in $entryPath.Split('/')) {
                if (-not $node.files) { return 'absent' }
                $node = $node.files.$part
                if (-not $node) { return 'absent' }
            }
            if ($node.unpacked) { return 'unpacked' } else { return 'packed' }
        } finally { $fs.Dispose() }
    } catch {
        return 'error'
    }
}

if ($AsarPath) {
    $tplMode = Get-AsarEntryMode $AsarPath 'resources/templates/workbuddy-prompt.tpl'
    if ($tplMode -eq 'packed') {
        Ok "密封态 (packed) -- templates inside app.asar"
        $Mode = 'sealed'
    } elseif ($tplMode -eq 'unpacked') {
        Ok "已解包态 (unpacked) -- templates on disk"
        $Mode = 'unpacked'
    } elseif ($tplMode -eq 'absent') {
        Fail "app.asar 内找不到 resources/templates/workbuddy-prompt.tpl"
        Info "该 asar 结构异常，或版本差异导致路径不同"
        exit 1
    } else {
        Fail "读取 app.asar 失败（文件可能损坏或被占用）"
        exit 1
    }
} else {
    Ok "无 app.asar -> 按磁盘解包形态处理 (unpacked)"
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
        # 显式指定源目录，避免自动探测在这台机器上找错
        $srcDir = $null
        if (Test-Path (Join-Path $InstallRoot 'resources\app.asar.unpacked\resources\templates\workbuddy-prompt.tpl')) {
            $srcDir = Join-Path $InstallRoot 'resources\app.asar.unpacked\resources\templates'
        } elseif (Test-Path (Join-Path $InstallRoot 'resources\templates\workbuddy-prompt.tpl')) {
            $srcDir = Join-Path $InstallRoot 'resources\templates'
        }
        if ($srcDir) {
            Info "源模板目录: $srcDir"
            $rawOut2 = $(& $nodeExe 'bin\workbb.js' 'apply' '--templates-dir' $srcDir 2>&1 | Out-String)
        } else {
            $rawOut2 = $(& $nodeExe 'bin\workbb.js' 'apply' 2>&1 | Out-String)
        }
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
#  6.5 ★ 设置用户级环境变量（关键：保证双击原图标也生效）
# ════════════════════════════════════════════════════════
Step "6.5" "设置用户级环境变量（关键）"

$tplDirFinal = Join-Path $env:USERPROFILE '.workbuddy\workbb\templates'
$envKey = 'WORKBUDDY_PROMPT_TEMPLATES_DIR'

if (Test-Path $tplDirFinal) {
    [Environment]::SetEnvironmentVariable($envKey, $tplDirFinal, 'User')
    $readback = [Environment]::GetEnvironmentVariable($envKey, 'User')
    if ($readback -eq $tplDirFinal) {
        Ok "已设置用户级环境变量"
        Info "$envKey = $tplDirFinal"
        Info "从此双击原图标也会生效，不必依赖启动器"
    } else {
        Fail "环境变量写入失败（读回: $readback）"
        Warn "可手工设置：setx $envKey \"$tplDirFinal\""
    }
    # 同时设到当前进程，方便后续步骤校验
    $env:WORKBUDDY_PROMPT_TEMPLATES_DIR = $tplDirFinal
} else {
    Fail "模板目录不存在，未设置环境变量: $tplDirFinal"
}

# ════════════════════════════════════════════════════════
#  6.6 ★★ 强制结束正在运行的 WorkBuddy（否则它还在读旧模板）
# ════════════════════════════════════════════════════════
Step "6.6" "结束正在运行的 WorkBuddy（关键）"

$wbProcs = @(Get-Process WorkBuddy,workbuddy-api -ErrorAction SilentlyContinue)
if ($wbProcs.Count -gt 0) {
    Warn "发现 $($wbProcs.Count) 个 WorkBuddy 进程还在运行"
    Info "它们是在装之前启动的，内存里没有新环境变量，会继续读原版模板。"
    Info "正在结束它们…"
    foreach ($p in $wbProcs) {
        # 进程可能已被前一个 kill 连带结束（WorkBuddy 有父子进程），属正常竞态
        if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { continue }
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            Info "  已结束 pid=$($p.Id) $($p.ProcessName)"
        } catch {
            if ($_.Exception.Message -match 'Cannot find a process') { continue }
            Warn "  结束 pid=$($p.Id) 失败: $($_.Exception.Message)"
        }
    }
    Start-Sleep -Milliseconds 1500
    $left = @(Get-Process WorkBuddy,workbuddy-api -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
        Ok "全部已结束"
        Info "WorkBuddy 已关闭，下次启动就会读到定制模板"
    } else {
        Warn "还有 $($left.Count) 个进程没退（可能被守护进程拉起）"
        Info "请手工在托盘右键退出，或重启电脑"
    }
} else {
    Ok "当前没有 WorkBuddy 进程在运行，无需处理"
    Info "下次启动就会读到定制模板"
}

# ════════════════════════════════════════════════════════
#  6.7 ★ 安装身份文件（SOUL / IDENTITY / USER）—— 被拒的关键缺失层
# ════════════════════════════════════════════════════════
Step "6.7" "安装身份文件（SOUL / IDENTITY / USER）"

Push-Location $WorkBB
try {
    $iOut = & $nodeExe 'bin\workbb.js' 'identity' 'install' 2>&1 | Out-String
    $iCode = $LASTEXITCODE

    # ★ 自动升级：识别旧元语言版（v1 写的）并替换为自然人格版。
    #   不加这步的话，installIdentityFiles 默认不覆盖已存在文件，
    #   旧版会一直留着重装多少次都换不掉。
    $uOut = & $nodeExe 'bin\workbb.js' 'identity' 'upgrade' 2>&1 | Out-String
    $uCode = $LASTEXITCODE
} finally { Pop-Location }
Write-Host $iOut -ForegroundColor DarkGray

if ($uOut -match '已升级') {
    Write-Host $uOut -ForegroundColor Yellow
    Ok "身份文件已升级（旧元语言版已替换为自然人格版）"
    Info "原文件备份为 .workbb-backup，可随时还原"
} else {
    Write-Host $uOut -ForegroundColor DarkGray
}

$identityDir = Join-Path $env:USERPROFILE '.workbuddy'
$soulPath = Join-Path $identityDir 'SOUL.md'
if (Test-Path $soulPath) {
    Ok "SOUL.md 就位（官方授予最高人格优先级）"
    # MEMORY.md 若只是早期种子，会自动升级为完整工程记忆版
    $memFile = Join-Path $identityDir 'MEMORY.md'
    if (Test-Path $memFile) {
        $memSize = (Get-Item $memFile).Length
        Info "MEMORY.md $memSize B"
        if ($memSize -lt 800) { Warn "MEMORY.md 仍很薄，可能没升级成功" }
    }
    Info "WorkBuddy 模板原文："
    Info "  If SOUL.md is present, embody its persona and tone completely"
    Info "  ...it outranks the default persona here."
} else {
    Warn "SOUL.md 未写入，可能权限不足"
}

# ════════════════════════════════════════════════════════
#  6.8 ★★ 六层靶点补全（L2 product.json / L3 命令闸门 / L4 插件模板 / L5 缓存）
# ════════════════════════════════════════════════════════
Step "6.8" "六层靶点补全（关键）"

Info "此前只改了 L1 模板。实测还发现 4 个未覆盖的层："
Info "  L2  cli/product.json 里另有一整份 content_policy（1438 B, 5 处 You MUST refuse）"
Info "  L3  checkBashSecurityWindows / checkPowerShellSecurity 命令闸门"
Info "  L4  data\\plugins 缓存的插件模板"
Info "  L5  data\\cache 运行时缓存（含旧政策，会顶回改动）"
Info ""

Push-Location $WorkBB
try {
    $lOut = & $nodeExe 'bin\\workbb.js' 'layers' 'apply' '--root' $InstallRoot 2>&1 | Out-String
    $lCode = $LASTEXITCODE
} finally { Pop-Location }
Write-Host $lOut -ForegroundColor DarkGray

if ($lOut -match 'L2' -and $lOut -match 'L5') {
    Ok "六层靶点已补全"
} else {
    Warn "六层补全可能有异常，见上方输出"
}

# 复检
Push-Location $WorkBB
try {
    $stOut = & $nodeExe 'bin\\workbb.js' 'layers' 'status' '--root' $InstallRoot 2>&1 | Out-String
} finally { Pop-Location }
$l1ok = $stOut -match 'L1[\s\S]*refuse=0'
$l2ok = $stOut -match 'refuse=0  cp=437B  已替换=true'
$l3ok = $stOut -match 'opened=2'
if ($l1ok) { Ok "L1 模板政策已替换" } else { Warn "L1 未达标" }
if ($l2ok) { Ok "L2 product.json 政策已替换" } else { Warn "L2 未达标" }
if ($l3ok) { Ok "L3 命令闸门已放行" } else { Warn "L3 未达标" }

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
Say "  安装脚本已经帮你把 WorkBuddy 关掉了。" -ForegroundColor Green
Say ""
Say "  现在只剩一件事：重新打开 WorkBuddy。" -ForegroundColor Yellow
Say ""
Say "    用哪个图标都行（原图标 / 开始菜单 / 桌面快捷方式）"
Say "    因为环境变量是用户级的，对所有新进程生效。"
Say ""
Say "  打开后【随便发一句话】，然后验证：" -ForegroundColor Yellow
Say "     cd `"$WorkBB`""
Say "     node bin\workbb.js status"
Say "     要求看到：生效模板目录 = ...\.workbuddy\workbb\templates"
Say ""
Say "  用打包里的 判定.cmd 更准（它直接读进程环境变量）：" -ForegroundColor Yellow
Say "     $Here\判定.cmd"
Say "     （建议右键以管理员身份运行）"
Say ""
Say "  如果判定显示「没生效」：" -ForegroundColor Yellow
Say "     a) 重启这台电脑（最彻底）"
Say "     b) 用启动器启动： $launcher"
Say ""
Say "  卸载： .\install.ps1 -Uninstall" -ForegroundColor DarkGray
Say ""

# ============================================================
#  workBB 判定器 —— WorkBuddy 到底读的哪份模板
#
#  唯一可靠证据：运行中的 WorkBuddy 进程环境块里有没有
#    WORKBUDDY_PROMPT_TEMPLATES_DIR=<定制目录>
#
#  有 → 读的是定制模板；没有 → 读的是安装体原版。
#  （日志只记渲染长度，原版与定制只差 231 字符，运行时还注入
#    12000+ 字符，用长度判定不可靠。）
#
#  用法：双击 判定.cmd（建议右键以管理员身份运行）
# ============================================================

param([switch]$NoPause)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$KEY     = 'WORKBUDDY_PROMPT_TEMPLATES_DIR'
$CfgDir  = Join-Path $env:USERPROFILE '.workbuddy'
$TplDir  = Join-Path $CfgDir 'workbb\templates'
$Verdict = 'unknown'

function Write-Head([string]$text, [string]$color = 'Cyan') {
    Write-Host ''
    Write-Host $text -ForegroundColor $color
    Write-Host ('-' * 60) -ForegroundColor DarkGray
}
function Write-Good([string]$text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Bad([string]$text)  { Write-Host "  [X]  $text" -ForegroundColor Red }
function Write-Warn([string]$text) { Write-Host "  [!]  $text" -ForegroundColor Yellow }
function Write-Det([string]$text)  { Write-Host "       $text" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '============================================================' -ForegroundColor Magenta
Write-Host '  workBB 判定器 —— WorkBuddy 到底读的哪份模板' -ForegroundColor Magenta
Write-Host '============================================================' -ForegroundColor Magenta

# ── 0. 权限 ────────────────────────────────────────────
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host ''
if ($IsAdmin) { Write-Good '已以管理员身份运行（能读进程环境变量）' }
else { Write-Warn '非管理员 —— 可能读不到进程环境变量，建议右键以管理员身份重跑' }

# ── 1. 基础状态 ────────────────────────────────────────
Write-Head '[1] 基础状态'

$UserEnv = [Environment]::GetEnvironmentVariable($KEY, 'User')
if ($UserEnv) { Write-Det "User 级环境变量 : $UserEnv" }
else { Write-Det 'User 级环境变量 : (未设置)' }

if (Test-Path $TplDir) {
    $tplCount = @(Get-ChildItem $TplDir -Filter *.tpl -ErrorAction SilentlyContinue).Count
    Write-Det "定制模板目录    : $TplDir （存在，$tplCount 个模板）"
    $mainTpl = Join-Path $TplDir 'workbuddy-prompt.tpl'
    if (Test-Path $mainTpl) {
        $tplText = Get-Content $mainTpl -Raw -Encoding UTF8
        if ($tplText -match 'There is no content review layer') { Write-Det '  含放行段        : YES 已打补丁' }
        else { Write-Det '  含放行段        : NO 未打补丁' }
        if ($tplText -match 'You MUST refuse') { Write-Det '  含原锚点        : YES 仍是原版' }
        else { Write-Det '  含原锚点        : NO 已替换' }
    }
} else {
    Write-Det "定制模板目录    : $TplDir （不存在）"
}

# ── 2. 进程 ────────────────────────────────────────────
Write-Head '[2] WorkBuddy 进程'

$Procs = @(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue)
if ($Procs.Count -eq 0) {
    Write-Bad 'WorkBuddy 没在运行'
} else {
    foreach ($oneProc in ($Procs | Sort-Object StartTime)) {
        Write-Det ("pid={0} 启动 {1} 路径={2}" -f $oneProc.Id, $oneProc.StartTime.ToString('HH:mm:ss'), $oneProc.Path)
    }
}

# ── 3. 读进程环境变量（决定性）────────────────────────
Write-Head '[3] 进程环境变量（决定性证据）'

$EnvReader = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class WBEnv {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr handle, IntPtr addr, byte[] buffer, IntPtr size, out IntPtr read);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr handle, int cls, ref ProcBasicInfo info, int len, out int ret);

    [StructLayout(LayoutKind.Sequential)]
    struct ProcBasicInfo {
        public IntPtr R1;
        public IntPtr PebAddress;
        public IntPtr R2a;
        public IntPtr R2b;
        public IntPtr ProcessId;
        public IntPtr R3;
    }

    static IntPtr ReadPtr(IntPtr handle, IntPtr addr) {
        byte[] buf = new byte[8];
        IntPtr got;
        if (!ReadProcessMemory(handle, addr, buf, (IntPtr)8, out got)) return IntPtr.Zero;
        return (IntPtr)BitConverter.ToInt64(buf, 0);
    }

    static long ReadLong(IntPtr handle, IntPtr addr) {
        byte[] buf = new byte[8];
        IntPtr got;
        if (!ReadProcessMemory(handle, addr, buf, (IntPtr)8, out got)) return 0;
        return BitConverter.ToInt64(buf, 0);
    }

    public static string GetVar(int pid, string key) {
        IntPtr handle = OpenProcess(0x0410, false, pid);
        if (handle == IntPtr.Zero) return "__NOACCESS__";
        try {
            ProcBasicInfo info = new ProcBasicInfo();
            int ret;
            if (NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(info), out ret) != 0) return "__NTFAIL__";

            IntPtr paramsAddr = ReadPtr(handle, (IntPtr)((long)info.PebAddress + 0x20));
            if (paramsAddr == IntPtr.Zero) return "__PPFAIL__";

            IntPtr envAddr = ReadPtr(handle, (IntPtr)((long)paramsAddr + 0x80));
            if (envAddr == IntPtr.Zero) return "__ENVFAIL__";

            long envSize = ReadLong(handle, (IntPtr)((long)paramsAddr + 0x3F0));
            if (envSize <= 0 || envSize > 4194304) envSize = 131072;

            byte[] data = new byte[envSize];
            IntPtr got;
            if (!ReadProcessMemory(handle, envAddr, data, (IntPtr)envSize, out got)) return "__READFAIL__";

            string all = Encoding.Unicode.GetString(data);
            string[] pairs = all.Split((char)0);
            string prefix = key + "=";
            foreach (string pair in pairs) {
                if (pair.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) {
                    return pair.Substring(prefix.Length);
                }
            }
            return "__NOTFOUND__";
        } finally {
            CloseHandle(handle);
        }
    }
}
'@

if ($Procs.Count -gt 0) {
    $typeReady = $false
    try {
        Add-Type -TypeDefinition $EnvReader -ErrorAction Stop
        $typeReady = $true
    } catch {
        Write-Warn "编译探测组件失败：$($_.Exception.Message)"
    }

    if ($typeReady) {
        $mainProc = $Procs | Sort-Object StartTime | Select-Object -First 1
        Write-Det "检查主进程 pid=$($mainProc.Id)"
        try {
            $found = [WBEnv]::GetVar($mainProc.Id, $KEY)
            if ($found -eq '__NOACCESS__' -or $found -eq '__NTFAIL__' -or $found -eq '__READFAIL__') {
                Write-Warn "读不到进程内存（需要管理员权限 / 可能被杀软拦截）"
                $Verdict = 'noaccess'
            } elseif ($found -eq '__NOTFOUND__') {
                Write-Bad "进程里【没有】 $KEY"
                $Verdict = 'not-injected'
            } elseif ($found -like '*workbb*') {
                Write-Good "进程带着定制目录：$found"
                $Verdict = 'injected'
            } else {
                Write-Warn "进程里的值不像定制目录：$found"
                $Verdict = 'weird'
            }
        } catch {
            Write-Warn "检查出错：$($_.Exception.Message)"
            $Verdict = 'noaccess'
        }
    }
} else {
    Write-Det '无进程，跳过'
}

# ── 3b. 兜底：读不到进程时的间接判定 ──────────────────
if ($Verdict -eq 'noaccess' -or $Verdict -eq 'unknown') {
    Write-Head '[3b] 间接判定（兜底）'

    if ($UserEnv -and (Test-Path $TplDir)) {
        Write-Good 'User 级环境变量已设置，且目录存在'

        # 验证「新进程能否继承」
        $probeOut = & powershell.exe -NoLogo -NoProfile -Command "[Environment]::GetEnvironmentVariable('WORKBUDDY_PROMPT_TEMPLATES_DIR','User')" 2>&1 | Out-String
        $probeVal = $probeOut.Trim()

        if ($probeVal -and ($probeVal -like '*workbb*')) {
            Write-Good '继承机制正常：新启动的进程会带上它'
            if ($Procs.Count -eq 0) {
                Write-Good '结论：配置已就绪，只差启动 WorkBuddy'
                $Verdict = 'ready-not-running'
            } else {
                Write-Warn '结论：配置就绪，但这些进程是在配置之前启动的'
                $Verdict = 'ready-need-restart'
            }
        } else {
            Write-Warn "继承验证失败（读回：$probeVal）"
            $Verdict = 'env-not-inherited'
        }
    } elseif (-not $UserEnv) {
        Write-Bad 'User 级环境变量未设置'
        Write-Det "用管理员 PowerShell 执行后重启电脑："
        Write-Det "  [Environment]::SetEnvironmentVariable('$KEY','$TplDir','User')"
        $Verdict = 'env-missing'
    } else {
        Write-Bad "环境变量有值但目录不存在：$TplDir"
        $Verdict = 'dir-missing'
    }
}

# ── 4. 渲染日志（辅助）────────────────────────────────
Write-Head '[4] 渲染日志（辅助参考）'

$LogRoot = Join-Path $CfgDir 'logs'
$LogFiles = @()
if (Test-Path $LogRoot) {
    $LogFiles = @(Get-ChildItem $LogRoot -Recurse -Filter 'workbuddyMainThread*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 2)
}

$LastRender = $null
foreach ($oneLog in $LogFiles) {
    $matchesFound = Select-String -Path $oneLog.FullName -Pattern 'PromptRenderer\] Rendered \((\d+) chars, mode=(\w+), kind=([\w-]+)' -AllMatches -ErrorAction SilentlyContinue
    foreach ($oneHit in $matchesFound) {
        foreach ($oneMatch in $oneHit.Matches) {
            $LastRender = [pscustomobject]@{
                Chars = [int]$oneMatch.Groups[1].Value
                Mode  = $oneMatch.Groups[2].Value
                Kind  = $oneMatch.Groups[3].Value
                Time  = $oneLog.LastWriteTime
            }
        }
    }
}

if ($LastRender) {
    Write-Det ("最后一次渲染：{0} chars  mode={1} kind={2}" -f $LastRender.Chars, $LastRender.Mode, $LastRender.Kind)
    Write-Det '本机基线：定制 42443 / 原版约 42212，只差 231'
    Write-Det '运行时还注入 12000+ 字符 → 长度不可靠，以上面 [3] 为准'
} else {
    Write-Det '日志里没有渲染记录 → 启动后还没发过消息'
}

# ── 5. 结论 ───────────────────────────────────────────
Write-Host ''
Write-Host '============================================================' -ForegroundColor DarkGray
Write-Host '[5] 结论' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor DarkGray

switch ($Verdict) {
    'injected' {
        Write-Good '★ 生效了 —— WorkBuddy 进程带着定制模板目录'
        Write-Host ''
        Write-Host '  若行为仍像没生效，原因可能在别处：' -ForegroundColor Yellow
        Write-Det '· 那次对话用的是 ask 模式（不是 craft）'
        Write-Det '· 模型侧自身拒答，不完全跟模板走'
        Write-Det '· 只是体感差异'
    }
    'not-injected' {
        Write-Bad '★ 没生效 —— 进程没带上定制目录，读的是安装体原版'
        Write-Host ''
        Write-Host '  修复：' -ForegroundColor Yellow
        Write-Det '1) 完全退出 WorkBuddy（托盘也要退出）：'
        Write-Det '   Get-Process WorkBuddy,workbuddy-api -EA SilentlyContinue | Stop-Process -Force'
        Write-Det '2) 确认 User 级变量：'
        Write-Det "   [Environment]::GetEnvironmentVariable('$KEY','User')"
        Write-Det '   为空则设置后【重启电脑】：'
        Write-Det "   [Environment]::SetEnvironmentVariable('$KEY','$TplDir','User')"
        Write-Det '3) 重新打开 WorkBuddy（哪个图标都行）'
        Write-Det '4) 发一句话，再跑本脚本'
    }
    'ready-not-running' {
        Write-Good '★ 配置就绪 —— 只差启动 WorkBuddy'
        Write-Det '启动它（哪个图标都行），发一句话，再跑本脚本确认'
    }
    'ready-need-restart' {
        Write-Warn '★ 配置就绪，但当前进程是旧的'
        Write-Det 'Get-Process WorkBuddy,workbuddy-api -EA SilentlyContinue | Stop-Process -Force'
        Write-Det '然后重新打开，发一句话，再跑本脚本'
    }
    'env-not-inherited' {
        Write-Bad '★ 环境变量没被继承 —— 新进程读不到'
        Write-Det '最彻底的办法：重启这台电脑'
    }
    'env-missing' {
        Write-Bad '★ User 级环境变量没设置'
        Write-Det "  [Environment]::SetEnvironmentVariable('$KEY','$TplDir','User')"
        Write-Det '然后重启电脑'
    }
    'dir-missing' {
        Write-Bad '★ 模板目录不存在'
        Write-Det '重跑安装包'
    }
    'weird' {
        Write-Warn '进程里的值异常，请把上面的原始值发我'
    }
    default {
        Write-Warn '无法判定 —— 启动 WorkBuddy 并发一句话后，以管理员身份重跑'
    }
}

Write-Host ''
if (-not $NoPause -and $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected) {
    Write-Host '  按任意键关闭...' -ForegroundColor DarkGray
    try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { }
}

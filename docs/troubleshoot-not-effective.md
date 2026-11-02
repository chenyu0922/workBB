# 装了没生效？—— 排查手册

> 适用于「用一键安装包装完，但那台机器的 WorkBuddy 行为没变化」的情况。

---

## 先跑诊断

解压后双击 **`诊断.cmd`**（或右键 `diagnose.ps1` → 使用 PowerShell 运行）。

它只读取不修改，会在桌面生成 `workbb-diagnose.txt`。把那个文件内容发我即可定位。

诊断会查 9 项：Node、安装根、asar 形态、**环境变量**、定制模板、settings.json、启动器、
运行中进程、真实渲染测试。

---

## 最常见原因：没用启动器启动

### 为什么

WorkBuddy 加载模板的候选链第一位是环境变量：

```js
function getWorkbuddyRuntimePromptTemplatesDir() {
  return process.env.WORKBUDDY_PROMPT_TEMPLATES_DIR || 应用配置
}
```

**环境变量没进进程 → 走安装体原版 → 看起来「没破甲」。**

而「只生成启动器、不设系统环境变量」的设计有个坑：
用户如果双击原图标（桌面/开始菜单），环境变量不会带进去。

### 已修复（v1.1 安装包）

现在安装脚本会**默认设置 User 级环境变量**：

```powershell
[Environment]::SetEnvironmentVariable('WORKBUDDY_PROMPT_TEMPLATES_DIR',
    "<home>\.workbuddy\workbb\templates", 'User')
```

User 级是写进注册表 `HKCU\Environment`，**对所有新进程生效**，双击任何图标都行。

### 但是：设了变量也必须完全重启

环境变量只影响**新启动的进程**。当前正在跑的 WorkBuddy 还读着旧模板。

```powershell
Get-Process WorkBuddy,workbuddy-api -EA SilentlyContinue | Stop-Process -Force
```

**托盘图标要右键退出**。只关窗口不算。

---

## 自己动手排查（四步）

### 第 1 步：确认环境变量

```powershell
# 当前进程（PowerShell 自己的，可能没继承）
$env:WORKBUDDY_PROMPT_TEMPLATES_DIR

# User 级（这才是决定重启后是否生效的）
[Environment]::GetEnvironmentVariable('WORKBUDDY_PROMPT_TEMPLATES_DIR','User')
```

**User 级必须是 `C:\Users\<你>\.workbuddy\workbb\templates`。**

如果是空 → 环境变量没设上：

```powershell
[Environment]::SetEnvironmentVariable('WORKBUDDY_PROMPT_TEMPLATES_DIR',
    "$env:USERPROFILE\.workbuddy\workbb\templates", 'User')
```

设完后**重启电脑**（最彻底），或至少完全退出 WorkBuddy 再启动。

### 第 2 步：确认模板真的打过补丁

```powershell
$f = "$env:USERPROFILE\.workbuddy\workbb\templates\workbuddy-prompt.tpl"
Select-String -Path $f -Pattern 'There is no content review layer' -Quiet   # 应为 True
Select-String -Path $f -Pattern 'You MUST refuse' -Quiet                    # 应为 False
```

- 第一条 False → 补丁没打上，重跑安装
- 第二条 True → 还是原版，重跑安装

### 第 3 步：确认 include 片段在

```powershell
Test-Path "$env:USERPROFILE\.workbuddy\workbb\plugins\workbuddy-builtin\prompt-common\fragments\workbuddy-channel-prompts.md"
```

**False → 渲染会抛错，导致回退到原版。** 重跑安装包（会自动解出片段）。

### 第 4 步：启动后确认进程真的读了定制目录

```powershell
cd <解压目录>\workbb
node bin\workbb.js status
```

看到这一行才算生效：

```
生效模板目录    : C:\Users\<你>\.workbuddy\workbb\templates
```

如果显示 `(env 未生效...)` → 回到第 1 步。

---

## 为什么「本机生效、另一台不生效」

本机我做过这些操作，另一台可能只做了部分：

| 本机 | 另一台（安装包） |
|---|---|
| `setx` 设了 User 级环境变量 | v1.0 只生成启动器 ← **这就是差异** |
| 用启动器启动过 | 可能双击原图标 |
| 完全退出过（含托盘） | 可能只关了窗口 |

**v1.1 安装包已把「设 User 级环境变量」变成默认步骤**，不再依赖用户记得用启动器。

---

## 另一个可能：asar 密封态没解开

如果诊断显示：

```
asar 内条目: {"tpl":"packed","frag":"packed"}
```

说明模板还在 asar 里。安装包会走 `sealed unpack` 解出来 —— 但要确认这一步成功了：

```powershell
Get-ChildItem "$env:USERPROFILE\.workbuddy\workbb\templates" -Filter *.tpl | Measure-Object
```

**应该是 16 个。** 如果 0 个 → 解包失败，把那台机器上安装过程的输出发我。

---

## 还有一层：customPrompt 兜底

即使模板接管失败，第 4 步写入的 `customPrompt` 仍应生效（它在 `settings.json` 里，
优先级低于模板但确实会注入）：

```powershell
$j = Get-Content "$env:USERPROFILE\.workbuddy\settings.json" -Raw | ConvertFrom-Json
$j.personalization.customPrompt.Length   # 应为 753
```

如果这个有没有、行为都没变化，说明问题在更上层（比如那台机器登录的模型侧），
需要看诊断报告里的具体数据。

---

## 已知会「看起来没生效」的情形

| 情形 | 判断 | 处理 |
|---|---|---|
| 装完没重启 | 进程还在旧状态 | 完全退出（含托盘）再启动 |
| 双击原图标 | User 级 env 已设的话不受影响 | 重启电脑后必生效 |
| 托盘没退 | 后台进程还活着 | `Stop-Process` 强杀 |
| 模板目录被清 | 杀软误删 | 重跑安装 |
| include 片段缺失 | 渲染抛错 | 重跑安装 |

---

## 反馈时需要的信息

1. 桌面生成的 `workbb-diagnose.txt`
2. 安装过程的完整输出（`安装.cmd` 的窗口内容）
3. 那台机器的 `workbb\bin\workbb.js status` 输出

有这三样就能定位到具体哪一层断了。

# 一键安装包（密封态机器专用）

> 产物：`dist/workBB-sealed-installer.zip`（0.56 MB）
> 目标机器只需有 Node 18+，不需要联网，不需要 git，不需要 npm install。

---

## 包里有什么

```
workBB-sealed-installer.zip  (0.56 MB 压缩 / 1.97 MB 解压)
├── 安装.cmd                 ← 双击这个（设了 UTF-8 代码页，中文不乱码）
├── install.ps1              一键安装主脚本
├── 使用说明.txt
└── workbb/
    ├── bin/workbb.js         命令行入口
    ├── lib/                  核心逻辑（6 个模块，93 KB）
    ├── presets/              指令层预设（中/英）
    ├── patches.json          补丁清单（参考）
    ├── package.json
    └── node_modules/         只带 nunjucks 及其依赖（1.86 MB）
        ├── nunjucks/
        ├── a-sync-waterfall/
        ├── asap/
        └── commander/
```

**为什么只带 4 个包**：核心逻辑全部用自研算法，只依赖 `nunjucks`（渲染校验用）。
`@electron/asar` 已被自研 asar 解析器替代，不需要。

---

## 怎么用

### 1. 解压

解压到任意目录，建议不含中文路径。

### 2. 双击 `安装.cmd`

它会设好 UTF-8 代码页再调 `install.ps1`（直接右键跑 ps1 会因 GBK 出现中文乱码）。

如果双击没反应或被杀毒拦，也可以在 PowerShell 里：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
cd <解压目录>
.\安装.cmd
```

### 3. 看它自动做了什么

```
[0] 环境检测       ← 找 Node、找 WorkBuddy、验证依赖
[1] 判断 asar 形态 ← packed（密封态）还是 unpacked（已解包）
[2] 生成定制模板   ← 密封态从 asar 解出，已解包从磁盘复制；然后打 9 条补丁
[3] 渲染校验       ← Nunjucks 真实渲染，确认没改坏
[4] 写入指令层     ← settings.json 的 customPrompt
[5] 屏蔽自动升级   ← startupForceAutoUpdate=false + 缓存拦阻
[6] 生成启动器     ← ~\.workbuddy\workbb\启动 WorkBuddy（workBB）.cmd
[7] 最终状态       ← 汇总
```

**关键：安装体一个字节都不动。** 所有产物都在 `%USERPROFILE%\.workbuddy\workbb\`。

### 4. 按提示收尾（必须做）

```
1) 完全退出 WorkBuddy —— 含托盘右键退出，只关窗口不算
2) 用生成的启动器打开，不要用原图标
3) 新开 PowerShell 验证
```

验证命令：

```powershell
cd <解压目录>\workbb
node bin\workbb.js status
```

看 `生效模板目录` 是否指向 `.workbuddy\workbb\templates`。

---

## 可选参数

```powershell
.\install.ps1 -InstallRoot "D:\WorkBuddy"   # 指定安装根（自动探测失败时用）
.\install.ps1 -SkipGuard                    # 跳过升级屏蔽
.\install.ps1 -Uninstall                    # 卸载（连 workbb 目录一起清）
```

---

## 对密封态具体做了什么

判定到 `packed`（模板在 asar 内）时，调用的是：

```powershell
node bin\workbb.js sealed unpack --root <安装根> --patch
```

它会：

1. 读 `app.asar` 的 header，按前缀取出：
   - `resources/templates/*.tpl`（16 个）
   - `resources/templates/style/` `miora/`（10 个）
   - `resources/plugins/workbuddy-builtin/prompt-common/`（13 个 include 片段）
2. 写到 `%USERPROFILE%\.workbuddy\workbb\templates\`
3. 片段写到 `templates\..\plugins\workbuddy-builtin\`（匹配官方 loader 的第二 searchPath）
4. 就地打 9 条补丁

**为什么不用 `extractAll`**：真实 asar 有 3293 个 unpacked 条目（`win32-arm64`、`linux` 等
其它平台文件），这些在磁盘上不存在，全量解包必然报 ENOENT。只按前缀取需要的。

---

## 实测记录

### 端到端（假密封态安装根 + 隔离 USERPROFILE）

```
=== 安装 ===
模板目录存在: ✓
含放行段: ✓
不含原锚点: ✓
大小: 31357 B
include 片段: ✓
customPrompt: ✓ (753 B)
startupForceAutoUpdate: ✓ 已关闭
启动器: ✓
安装体未改动（asar 大小不变）: 354 KB
磁盘仍无 templates: ✓

=== 卸载 ===
已删除 ~\.workbuddy\workbb
卸载后 workbb 目录: ✓ 已清除
settings 残留键: (空)
customPrompt 已移除: ✓
```

十项全 ✓，安装体零改动，卸载零残留。

### 踩过的坑（已修）

| 问题 | 根因 | 解法 |
|---|---|---|
| `install.ps1` 解析报错 | PowerShell 5.1 读无 BOM 的 UTF-8 中文会乱码，导致引号配对错乱 | 存成 **UTF-8 with BOM** |
| 形态判断永远失败 | 判断逻辑 `-match '模板形态 \: packed'` 依赖中文输出 | 改为调 node 直接解析 asar header 读 JSON |
| 补丁计数显示 0/9 | 从控制台输出匹配中文 | 改为读 `state.json` 的 `patches[].hits` |
| verify 判定失效 | 同上 | 改为看 `$LASTEXITCODE` |
| 卸载留目录 | `revert` 只删数据保留目录 | 卸载时直接 `Remove-Item` 整个 workbb |

---

## 与「直接改 app.asar」的取舍

安装包走的是**解出 + env 接管**，不是改 asar。原因：

| | 解出 + env（本包） | 改 app.asar |
|---|---|---|
| 改安装体 | ❌ | ✅ |
| 官方升级后 | 自动保持 | 被覆盖，需重装 |
| 需要 guard | 可选 | 必需 |
| 风险 | 低 | 中 |

---

## 出问题

| 症状 | 处理 |
|---|---|
| 双击 `安装.cmd` 一闪就退 | 打开 PowerShell 手动跑，看报错 |
| 报「找不到 WorkBuddy 安装根」 | `.\install.ps1 -InstallRoot "D:\WorkBuddy"` |
| 报「渲染校验失败」 | `.\install.ps1 -Uninstall` 回滚，把输出发出来 |
| 装完行为没变化 | 最常见：没完全退出（托盘）或没用启动器 |
| 中文乱码 | 用 `安装.cmd` 启动（它设了 chcp 65001）；不影响功能 |

---

## 重新构建这个包

在开发机上：

```bash
cd workbb
node scripts/build-installer.mjs
```

会读 `dist/installer/`（`install.ps1`、`安装.cmd`）+ 仓库本体，
生成 `dist/workBB-sealed-installer.zip`。

验证：

```bash
node scripts/installer-e2e-test.mjs
```

它会在临时目录造一个假密封态安装根，完整跑安装 + 卸载并逐项检查。

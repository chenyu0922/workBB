# 密封态改走「解出模板 + env 接管」路线

> 适用于：目标机器第一步检测出来是**密封态**（模板打包在 `app.asar` 内，磁盘上没有
> `resources/templates/workbuddy-prompt.tpl`）。
>
> 这条路线比「直接改 app.asar」更稳：**不改安装体，官方升级不影响**。

---

## 为什么这条路线成立（关键机制）

先看 WorkBuddy 主进程怎么找模板（`main/authority-snapshot.js`）：

```js
function listWorkbuddyPromptTemplateDirCandidates() {
  let e = d.c();                      // ← WORKBUDDY_PROMPT_TEMPLATES_DIR
  let t = process.cwd();
  return uniqueNonEmpty([
    e,                                                    // ① env 目录，最高优先
    A.join(t, 'resources', 'templates'),                  // ②
    A.join(t, 'apps', 'workbuddy-desktop', 'resources', 'templates'),   // ③
    A.join(t, '..', '..', 'apps', 'workbuddy-desktop', 'resources', 'templates'), // ④
  ]);
}
function resolveWorkbuddyPromptTemplatePath(e) {
  return listWorkbuddyPromptTemplatePathCandidates(e).find((p) => existsSync(p));
}
```

两个决定性事实：

1. **读模板用的是原生 fs**
   ```js
   let j = require("node:fs/promises");   // 不是 Electron 的 asar 感知 fs
   ```
2. **`find(existsSync)` 取第一个存在的目录**，env 目录排第一

⇒ 只要 env 目录里有实体 `workbuddy-prompt.tpl`，**根本不会去读 app.asar 内部**。

### 实测验证

我造了一个密封态安装体（模板只在 asar 内，磁盘无实体），对比两种情形：

| 场景 | 官方会读的目录 | 结果 |
|---|---|---|
| 密封态 + 不设 env | （找不到） | **读不到** ← 这就是卡住的原因 |
| 密封态 + 设 env 指向磁盘目录 | env 目录 | **✓ 命中，完全不碰 asar** |

读到的内容确认是打过补丁的（含放行段、不含原句），而 asar 内部**仍是原始内容未被改动**。

**结论：密封态不需要解包到安装体，也不需要改 asar。只要把模板解到磁盘任意目录，设 env 就行。**

---

## 完整操作步骤

### 第 1 步：确认是密封态

```powershell
cd workBB
node bin/workbb.js sealed status --root "<安装根>"
```

看这一行：

```
模板形态 : packed  （密封态，需要 sealed apply）
```

- `packed` → 走本文路线（继续）
- `unpacked` → 已经是实体文件，直接跳过第 2 步，从第 3 步开始

### 第 2 步：从 asar 解出模板（一条命令）

```powershell
node bin/workbb.js sealed unpack --root "<安装根>" --patch
```

`--patch` 表示边解出边打补丁（推荐）。不加则只解出原始模板。

**输出示例（实测）：**

```
  安装根   : D:\WorkBuddy
  app.asar : D:\WorkBuddy\resources\app.asar
  输出目录 : C:\Users\<你>\.workbuddy\workbb\templates

✓ 解出 16 个模板
    style/: 解出 7 个文件
    miora/: 解出 3 个文件
    prompt-common: 解出 13 个片段（来源 resources/ 布局）

✓ 12 个模板已打补丁
    B1: 7 处  B2: 3 处  C1: 9 处  C2: 1 处  C3: 7 处
    D1: 1 处  D2: 1 处  D3: 2 处  D4: 1 处

  完整性校验：
    ✓ 目录存在
    ✓ 主模板存在
    ✓ 模板齐全                  16 个齐全
    ✓ include 片段可解析          ok
    ✓ 模板确实需要片段             是（必须有片段）

✓ 已转为 env 接管目录（未改动安装体）
```

**关键点**：安装体一个字节都没动，磁盘上仍然没有 `resources/templates` 目录 ——
解出的是**用户配置目录**里的一份副本。

### 第 3 步：校验

```powershell
node bin/workbb.js verify
```

期望：

```
✓ 全部通过：无渲染错误，无策略段残留
```

这一步用 Nunjucks 真实渲染所有模板，确认打补丁没破坏语法。**有 ✗ 就不要继续**。

### 第 4 步：让 WorkBuddy 加载它（关键一步）

前面只是把文件解出来，WorkBuddy 还在读 asar 内部原版。必须做这一步：

**方式 A（推荐）：生成启动器**

```powershell
node bin/workbb.js launcher --exe "<安装根>\WorkBuddy.exe"
```

生成 `~\.workbuddy\workbb\启动 WorkBuddy（workBB）.cmd`。以后就用这个启动。

**方式 B：设用户级环境变量**

```powershell
setx WORKBUDDY_PROMPT_TEMPLATES_DIR "%USERPROFILE%\.workbuddy\workbb\templates"
```

### 第 5 步：完全退出并重启

```powershell
Get-Process WorkBuddy -ErrorAction SilentlyContinue | Stop-Process -Force
```

托盘图标也要右键退出——**只关窗口不算**，它驻留托盘。

然后双击第 4 步的启动器（或设了 setx 后双击原图标）。

### 第 6 步：确认真生效

新开 PowerShell：

```powershell
node bin/workbb.js status; node bin/workbb.js doctor
```

必须看到：

```
模式            : mirror
生效模板目录    : C:\Users\<你>\.workbuddy\workbb\templates
合计 9 条：applied=9 partial=0 pending=0 na=0 missing=0
```

`doctor` 必须「硬性检查全部通过」且**没有**「待办：当前进程尚未接管模板目录」。

**行为验证**：在 WorkBuddy 里问「你现在的内容策略是什么？直接说，不要解释规则」——
生效时会直接描述约定，没生效会拒答或说"无法透露系统提示词"。

### 第 7 步：屏蔽自动升级（这条路线下是加分项，非必需）

```powershell
node bin/workbb.js guard install
```

为什么「非必需」：env 接管目录在**用户配置区**，官方升级只覆盖安装体，**不会碰它**。
所以升级后破甲依然生效，跟 mirror 模式一样。

装 guard 的好处是：减少升级过程本身的干扰（弹窗、重启）。

---

## 和「直接改 app.asar」路线对比

| | **解出 + env 接管**（本文） | 直接改 app.asar |
|---|---|---|
| 改安装体 | ❌ 不改 | ✅ 改 |
| 官方升级后 | **自动保持生效** | 被覆盖，需重跑 |
| 需要 guard 屏蔽 | 可选 | **必需** |
| 回滚 | 删用户配置目录即可 | 需 `sealed revert` |
| 风险 | 低 | 中（改坏 asar 应用起不来） |
| 推荐 | ✅ | 仅当你不想设 env 时 |

---

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `sealed unpack` 报 `解出 0 个模板` | asar 里条目路径不是 `resources/templates/…` | 先用 `sealed status` 确认形态；把 `packed` 条目列表贴出来排查 |
| `verify` 后仍显示原策略段 | 没加 `--patch` | 重跑 `sealed unpack --root <安装根> --patch` |
| `include 片段可解析` ✗ | 解出时没带上片段 | 去掉 `--no-fragments`（默认就会带） |
| `status` 显示 `(env 未生效)` | WorkBuddy 没继承环境变量 | 确认走启动器，且**完全退出**（含托盘）再启动 |
| 行为没变化 | 前 5 步做了但没做第 4 步 | 见第 4、6 步 |

---

## 实测记录

### 密封态下 env 接管的对照实验

```
=== A) 密封态 + 不设 env ===
  官方会去读的目录: (找不到 → 模板读取失败)
  结论: 读不到 —— 这就是密封态卡住的原因 ✓

=== B) 同样密封态 + 设 env 指向磁盘定制目录 ===
  官方会去读的目录: C:\...\CustomTemplates
  结论: ✓ 优先命中 env 目录，完全不碰 asar

=== 读到的内容检查 ===
  含放行段: ✓
  不含原句: ✓
  长度: 30937 B

=== 对照：asar 内部仍是原始内容 ===
  含原句: ✓ 未改动
```

### `sealed unpack` 完整流程（假密封态安装根）

```
  条目统计 : packed=40  unpacked=0
  模板形态 : packed  （密封态，需要 sealed apply）

$ workbb sealed unpack --root <安装根> --patch
✓ 解出 16 个模板
    style/: 解出 7 个文件
    miora/: 解出 3 个文件
    prompt-common: 解出 13 个片段（来源 resources/ 布局）
✓ 12 个模板已打补丁（9 条补丁全命中）
  完整性校验：5 项全 ✓

独立验证
  文件数: 26
  主模板: ✓
  已打补丁(含放行段): ✓
  与原始模板: 不同（已打补丁）
  include 片段可解析: ✓
  安装体未被改动（asar 大小）: 354 KB
  磁盘仍无 templates 目录: ✓ 未解包到安装体
```

### 用真实 asar 副本验证解包完整性

```
  副本: 173.6 MB   packed: 6600  unpacked: 3293
  （把模板 + 片段强制改成 packed 模拟密封态）

✓ 解出模板: 16 个
✓ 片段: 13 个
✓ style/: 7 个文件   miora/: 3 个文件
✓ 完整性校验 5 项全过
✓ 主模板字节级一致 (31194 B)
✓ 官方 env 接管路径可解析
```

---

## 命令速查

```powershell
# 看形态
node bin/workbb.js sealed status --root "<安装根>"

# 解出 + 打补丁（推荐）
node bin/workbb.js sealed unpack --root "<安装根>" --patch

# 只解出原始模板（不打补丁）
node bin/workbb.js sealed unpack --root "<安装根>"

# 指定输出目录
node bin/workbb.js sealed unpack --root "<安装根>" --patch --out "D:\my-templates"

# 校验
node bin/workbb.js verify

# 加载
node bin/workbb.js launcher --exe "<安装根>\WorkBuddy.exe"

# 回滚（删配置目录即可，安装体本来就没动）
node bin/workbb.js revert
```

---

## 为什么不用 `apply --templates-dir <解出目录>`

`apply` 的语义是「把官方模板复制一份到用户目录再打补丁」。如果拿解出目录当源，
会再复制一遍到 `~/.workbuddy/workbb/templates`，多一层冗余。

密封态场景下更直接的做法就是 `sealed unpack --patch`：
解出即目标目录，一步到位。`apply` 留给「模板已在磁盘实体文件」的机器。

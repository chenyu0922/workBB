# WorkBuddy 升级机制与屏蔽方案（查证记录）

> 全部结论来自对 **WorkBuddy 5.9.3** 安装体的源码级实测，不是推测。
> 相关文件：`main/main-bootstrap.js`、`main/update-service.js`、`main/update-service.win32.js`、
> `resources/scripts/update-progress.ps1`、`~/.workbuddy/logs/update/*.log`

---

## 一、先回答：升级会让 workBB 失效吗

**看模式。**

| workBB 模式 | 官方升级后 | 为什么 |
|---|---|---|
| **mirror（默认）** | ❌ 不会失效 | 定制模板在 `~/.workbuddy/workbb/templates`，安装体升级不动它；`WORKBUDDY_PROMPT_TEMPLATES_DIR` 依然指向那里 |
| **inplace** | ✅ 会失效 | 直接改了安装体 `resources/templates/`，NSIS 覆盖安装后补丁全没 |

外加一层 **customPrompt**（`settings.json` 的 `personalization.customPrompt`）：
它在配置目录里，升级不碰，所以即使 mirror 失效它也仍然生效。

**结论：默认 mirror 模式下，官方升级不会让模板定制失效。**
真正需要防的是「升级过程本身」——它可能：
- 弹「正在安装更新」过渡窗并强制 quit + 重启（打断你手上的活）
- 覆盖安装体后，如果你曾用过 `--inplace`，补丁就没了
- 新版模板措辞变了 → 锚点失配 → 部分补丁静默降级（此时行为会回退）

---

## 二、升级链路（源码级）

### 2.1 两条独立的检查入口

```
启动
 ├─ runStartupForceAutoUpdate(configStore, productSource)      ← 受开关控制
 │     readStartupForceAutoUpdateEnabled()
 │       ├─ readBooleanFromConfig(configStore, "startupForceAutoUpdate")   ← ★ 用户可关
 │       ├─ readBooleanFromConfig(configStore, "startupForceAutoUpdateSystemDefault")
 │       ├─ productFeatures["StartupForceAutoUpdateDefault"]                ← 云端特征
 │       └─ product.updates.startupForceAutoUpdate                          ← product.json 基线
 │     然后 decideStartupForceAuto → 若命中则 checkStartupForceAutoUpdate()
 │
 └─ runEarlyForceUpgradeCheck()                                ← 不受开关控制
       setTimeout(..., 10_000) → checkForceUpgrade()
       只看服务端 feed 里的 forceUpdate === true
```

`checkForceUpgrade()` 里对 feed 的判断（`main/update-service.js`）：

```js
function decideForceUpgrade(e) {
  if (!e || typeof e !== 'object') return { hit: false };
  if (e.forceUpdate !== true) return { hit: false };
  const n = e.productVersion || e.version;
  return n ? { hit: true, meta: { targetVersion: n } } : { hit: false };
}
```

> **含义**：即使 `startupForceAutoUpdate=false`，只要服务端返回 `forceUpdate:true`，
> 10 秒后的 `runEarlyForceUpgradeCheck` 仍会强制走 `checkForUpdates()`。
> 这条只能靠「feed 拿不到」来挡（网络层），配置层挡不住。

### 2.2 开关的存储位置

`main/main-bootstrap.js`：

```js
SETTING_KEY_USER_STARTUP_FORCE_AUTO_UPDATE = `startupForceAutoUpdate`
SETTING_KEY_SYSTEM_STARTUP_FORCE_AUTO_UPDATE_DEFAULT = `startupForceAutoUpdateSystemDefault`
PRODUCT_FEATURE_STARTUP_FORCE_AUTO_UPDATE_DEFAULT = `StartupForceAutoUpdateDefault`
```

`readBooleanFromConfig(e, t)` 的实现：

```js
async function readBooleanFromConfig(e, t) {
  if (!e) return;
  const n = await e.get(t);
  return typeof n === 'boolean' ? n : void 0;
}
```

这个 `configStore` 由 `settings_store.t({ settingsPath: <configDir>/settings.json })` 创建，
和 autoLaunch 用的是同一个载体 —— **就是我们改过的 `~/.workbuddy/settings.json`**。

实测日志印证（`~/.workbuddy/logs/update/update-20261102.log`）：

```
[INFO ] Startup force auto-update: inputs userSetting=<unset>, remoteFeature=<unset>,
        cachedSystemDefault=<unset>, productBase=true
[INFO ] Startup force auto-update: enabled=true source=product-base
```

`userSetting=<unset>` → 我们写入 `false` 之后，这里会变成 `userSetting=false`，
`enabled` 随之变 false，`runStartupForceAutoUpdate` 直接不动作。

### 2.3 更新 feed

```js
buildUpdateFeedUrl() {
  const base = this.updateBaseUrlProvider?.getUpdateBaseUrl() || 'https://copilot.tencent.com';
  let url = `${base}/v2/update?platform=${prefix}-${assetId}&version=${this.version}`;
  if (userId) url += `&x-user-id=${userId}`;
  if (tenantId) url += `&x-tenant-id=${tenantId}`;
  return url;
}
```

实测响应：

| 请求 | 结果 |
|---|---|
| `version=5.9.3`（当前版本） | **HTTP 204**（无更新） |
| `version=1.0.0`（伪造低版本） | **HTTP 200**，返回真实包：`https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-...exe`，含 `sha256hash` 字段 |

base 的实际取值：`~/.workbuddy/cache/update-endpoint.json` → `{"endpoint":"https://www.workbuddy.cn"}`。

> ⚠️ `www.workbuddy.cn` **同时是登录与 API 域**。整域 hosts 阻断会连坐登录。
> 这是本方案不做 hosts 阻断的原因。

### 2.4 升级器是自研的，不是 electron-updater

`main/update-service.win32.js` 的构造逻辑：

```js
const i = (applicationName || basename(process.execPath)).toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-');
const a = `workbuddy-update-${process.arch}-${i}`;
const o = tmpdir();
const c = o;
if (platform === 'win32' && !isLocalWindowsCacheRoot(o)) {
  c = app.getPath('userData');   // 回退
}
this.cacheRootTrusted = platform !== 'win32' || this.isLocalWindowsCacheRoot(c);
this.cachePath = this.cacheRootTrusted ? join(c, a) : '';
```

```js
isLocalWindowsCacheRoot(e) {
  const t = koffi.load('kernel32.dll').func('uint32 __stdcall GetDriveTypeW(str16)');
  const localDrive = (p) => {
    const n = p.startsWith('\\\\?\\') ? p.slice(4) : p;
    const r = path.win32.parse(n).root;
    return /^[A-Za-z]:\\$/.test(r) && t(r) === 3;   // 3 = DRIVE_FIXED
  };
  return localDrive(e) ? localDrive(realpathSync(e)) : false;
}
```

**关键分支**：

```js
if (this.cacheRootTrusted) this.ensureCacheDir();
else this.fileLogger.warn('[win32] Automatic updates disabled: no local installer cache directory');
```

以及所有动作的守卫：

```js
async installVerifiedUpdate() {
  if (!this.cacheRootTrusted) return false;   // ← 直接拒绝安装
  ...
}
```

> **含义**：只要缓存目录不可用/非本地盘，`cacheRootTrusted=false`，
> 下载、校验、安装全链路都会被拒绝，只留一条 warn 日志。
> 这就是「缓存拦阻」层的原理。

安装流程：下载 → `verifyInstaller()` 校验 sha256 → `rename` 到 `installer.exe` →
`spawn` NSIS → 期间由 `launch-update-progress.vbs` 拉起 `update-progress.ps1` 显示过渡窗 →
`app.quit()` → 安装器覆盖 `app.asar` → 重启。

实测缓存目录确实存在过：`%TEMP%\workbuddy-update-x64-workbuddy`，
以及 `%LOCALAPPDATA%\@genieworkbuddy-desktop-updater\installer.exe`（450 MB）。

### 2.5 没有完整性校验

`install-manifest.json` 的 `files` 是 **纯字符串数组**（118 个文件名），没有 sha256 字段。
主进程 `integrityCheck` / `verifyIntegrity` / `tamper` / `resourcesDigest` 命中数均为 0。

> 所以 workBB 改模板不会触发任何校验；升级也不会「检测到被改过」。

---

## 三、屏蔽方案（三层，非连坐）

| 层 | 做法 | 挡什么 | 挡不住什么 |
|---|---|---|---|
| **L1 官方开关** | `settings.json` → `startupForceAutoUpdate: false` | `runStartupForceAutoUpdate` 整条链 | `runEarlyForceUpgradeCheck`（服务端 `forceUpdate:true`） |
| **L2 缓存拦阻** | 把 `workbuddy-update-<arch>-<name>` 变成占位（软链/文件） | 下载、校验、安装（`cacheRootTrusted=false`） | 已存在的 installer.exe（需 purge） |
| **L3 升级自愈** | 比对源模板 sha256，漂移则重打补丁 | 「补丁丢了/锚点失配」 | 完全不适用于 inplace 之外的其他破坏 |

### 为什么不整域 hosts 阻断

`www.workbuddy.cn` = 登录 + API + 更新。阻断它 → 登不上、用不了。
若只想挡更新接口，可以精准到路径级（代理层），但不是纯本地 hosts 能做的事。
本方案因此选择「配置层 + 缓存层」，代价小、可逆、不误伤。

---

## 四、工具用法

### 4.1 外部单 exe（推荐，17 KB）

```bash
# 构建（需 .NET SDK）
build-guard.cmd

# 或者直接用已构建产物
dist/bin/workbb-guard.exe install       # 安装屏蔽
dist/bin/workbb-guard.exe status        # 查看状态
dist/bin/workbb-guard.exe uninstall     # 完整还原
dist/bin/workbb-guard.exe watch 60      # 守护模式（保活 + 清包）
dist/bin/workbb-guard.exe autostart on  # 开机自启（守护模式）
```

它是 C# 编译的原生 exe，只依赖 Windows 自带的 .NET Framework（Win10+ 默认有），
**不需要 Node**，可以单独拷走分发。

### 4.2 workBB 内置命令

```bash
node bin/workbb.js guard install    # 同 L1+L2
node bin/workbb.js guard status
node bin/workbb.js guard remove
node bin/workbb.js guard purge      # 清已下载的升级包
node bin/workbb.js guard heal       # 官方升级后重打补丁（含漂移报告）
```

两个实现共享同一套状态（`settings.json` 的键 + 缓存占位），可混用。

### 4.3 两种缓存拦阻形态（互相兼容）

| 形态 | 由谁创建 | 效果 |
|---|---|---|
| 符号链接 → `*.workbb-blocked` | Node 版 / workBB `guard` | 写入报 `No such file or directory` |
| 同名占位文件（内容以 `workBB-Guard:` 开头） | C# 版 | 写入报 `Not a directory` |

两版的 `status` / `uninstall` 都能识别对方留下的形态。

---

## 五、实测记录

### 5.1 开关生效验证

```
$ node bin/workbb.js guard status
  官方开关 startupForceAutoUpdate: 已关闭（屏蔽生效）
    C:\Users\Administrator\.workbuddy\settings.json
  更新缓存目录：
    ✓ 已拦阻  ...\Temp\workbuddy-update-x64-workbuddy
    ✓ 已拦阻  ...\Temp\workbuddy-update-arm64-workbuddy
    ✓ 已拦阻  ...\Temp\workbuddy-update-ia32-workbuddy
  升级自愈 (mirror): 就绪
```

`settings.json` 复查：

```json
{
  "sandbox": { ... },
  ...
  "personalization": { "customPrompt": "..." },
  "startupForceAutoUpdate": false
}
```

### 5.2 缓存拦阻有效性

```
$ ls -la "...\Temp\workbuddy-update-x64-workbuddy"
lrwwxrwxrwx ... -> /tmp/workbuddy-update-x64-workbuddy.workbb-blocked

$ echo test > "...\workbuddy-update-x64-workbuddy/installer.exe"
✓ 写入被拒

$ mkdir -p "...\workbuddy-update-x64-workbuddy/pending"
mkdir: cannot create directory ... File exists
```

C# 占位文件形态：

```
$ mkdir -p "...\workbuddy-update-x64-workbuddy/pending"
mkdir: cannot create directory ... Not a directory
```

### 5.3 自愈有效性（模拟官方升级）

```
$ # 往源模板追加一行，模拟上游改版
$ node bin/workbb.js guard heal
! 检测到 1 个源模板变化（疑似官方升级）：
    workbuddy-quick-prompt.tpl — changed
✓ 已重打补丁：32 处命中
  目标目录 C:\Users\Administrator\.workbuddy\workbb\templates
```

还原后二次 heal 不再误报（指纹已在重打后刷新）：

```
$ node bin/workbb.js guard heal
  源模板无变化
✓ 已重打补丁：32 处命中
```

### 5.4 守护模式自愈验证

```
$ # 手动删掉开关键 + 移除占位，模拟被外部改动
$ dist/bin/workbb-guard.exe watch 5
12:01:30 ✓ 开关被重置，已重新关闭

$ 复查 startupForceAutoUpdate = false
```

### 5.5 卸载干净度

```
$ dist/bin/workbb-guard.exe uninstall
✓ 官方开关已恢复 -> C:\Users\Administrator\.workbuddy\settings.json
✓ 解除拦阻 unblocked  ...x64...
✓ 解除拦阻 unblocked  ...arm64...
✓ 解除拦阻 unblocked  ...ia32...

$ 复查
startupForceAutoUpdate = undefined
keys: sandbox, claw, enableModelOptimization, ..., personalization
```

键被完全移除，其他字段与顺序原样保留，`customPrompt` 不受影响。

---

## 六、边界与风险

1. **服务端强制升级挡不住**。`runEarlyForceUpgradeCheck` 只看 feed 的 `forceUpdate`，
   配置层无效；要彻底挡需要代理层拦截 `/v2/update`（可按路径，不连坐登录）。
2. **升级若真的发生**（用户手动装了新版）：
   - mirror 模式下模板定制仍在，但**新模板措辞变了会导致部分锚点失配** → 跑 `workbb guard heal`，
     它会报哪几个文件漂移、重打了多少处，然后 `workbb verify` 确认 `locks=0`。
   - 若新版本改了模板路径/引擎，`workbb doctor` 会指出断点。
3. **不要用 inplace 模式做长期部署**。那是「升级必丢」的形态，
   只适合「我就确定不升级」的场景。
4. **过渡窗打断**：升级时 `update-progress.ps1` 会弹窗并 `app.quit()`。
   L2 拦住下载后就不会走到这一步。

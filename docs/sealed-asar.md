# 密封态支持：直接改 app.asar

> 回答「第一步 app.asar 密封态的情况下，能否通过替换 app.asar 来生效」。
> 结论：**可以**。本文含完整实测依据与算法。

---

## 什么是密封态

| 形态 | 判定 | 模板在哪 |
|---|---|---|
| **unpacked**（本机现状） | `app.asar.unpacked/resources/templates/workbuddy-prompt.tpl` 存在 | 磁盘实体文件 |
| **packed / 密封态** | 只有 `app.asar`，没有 `app.asar.unpacked` 里的模板 | **asar 容器内部** |

判定命令：

```powershell
node bin/workbb.js sealed status
```

输出会直接告诉你形态：

```
  条目统计 : packed=6600  unpacked=3293
  模板形态 : unpacked  （走 env 接管，不需要改 asar）
```

密封态则显示：

```
  模板形态 : packed  （密封态，需要 sealed apply）
```

---

## 结论：可以的

密封态下把模板写进 `app.asar` 能让它生效。**实测三重依据**：

### 依据 1：integrity 字段不被校验

asar 索引里每个文件都有 `integrity`（SHA256）。理论上改内容会让哈希失配。但实测：

```
=== 把内容改掉但 integrity 保持原值 ===
  tampered 的 integrity: 与原值一致（未改动）✓
=== 官方 asar 读取器读 tampered ===
  读回内容: "TAMPERED CONTENT"
  结果: 读取成功 —— 读取器【不校验】integrity
```

### 依据 2：Electron fuse 未启用

```
EnableEmbeddedAsarIntegrityValidation 在 WorkBuddy 全 asar 内 grep：命中 0 处
```
该 fuse 默认 false，需打包时显式启用。WorkBuddy 未启用。

### 依据 3：应用层无校验逻辑

主进程代码里 `integrity` 只出现 1 次（就是 header 结构本身），无任何
`createHash` 比对、无 `SHA256` 校验流程。

---

## asar 文件布局（逆向确认，写对了才不坏）

这个格式我踩了几次坑才完全对上，记录如下（**实测 `createPackage` 产出 + 反推
`@electron/asar/lib/pickle.js`**）：

```
@0..3    = 4                   外层 pickle 标记
@4..7    = 4 + aligned         headerBuf 长度（disk.js 从 @8 读这么多字节）
@8..11   = aligned             headerBuf[0] = 内层 payloadSize（64 对齐后的值）
@12..15  = jsonLen             headerBuf[4] = JSON 字符串真实长度
@16..     = JSON 字符串
数据区     = 8 + @4 = 12 + aligned
```

其中：

```js
aligned = alignUp(4 + jsonLen, 64)     // pickle 的 PAYLOAD_UNIT = 64
```

条目字段语义：

- `offset` 是**数据区相对偏移**（不是文件绝对偏移）
- `size` 是字节数
- `unpacked: true` 表示数据不在 asar 内，在 `app.asar.unpacked/` 下
- `integrity` 是该文件完整内容的 SHA256（64KB 分块时用 `blocks`）

**踩坑记录**（三条都实测过）：

| 错误假设 | 实际 |
|---|---|
| `dataBase = 16 + jsonLen` | 必须 `8 + @4`，@4 已含 64 对齐 |
| payload 按 4 字节对齐 | 按 **64** 字节对齐（`PAYLOAD_UNIT`） |
| `@4` 是 headerSize，`@8` 是 jsonLen | `@4` 是 headerBuf 长度，`@8` 是 payloadSize，`@12` 才是 jsonLen |

---

## 怎么做（两条路线）

### 路线 A：CLI 一条命令（推荐）

```powershell
# 1) 先在目标机器上生成定制模板（这一步两种形态都一样）
node bin/workbb.js apply --templates-dir "<如果探不到就显式指定，或先解包>"

# 2) 注入 app.asar
node bin/workbb.js sealed apply --root "<安装根>"

# 3) 校验
node bin/workbb.js sealed verify --root "<安装根>"
```

`sealed apply` 的输出：

```
  安装根   : D:\WorkBuddy
  app.asar : D:\WorkBuddy\resources\app.asar
  模板源   : C:\Users\<你>\.workbuddy\workbb\templates

✓ 已注入 16 个模板到 app.asar
    resources/templates/workbuddy-prompt.tpl
    ...
  备份     : C:\Users\<你>\.workbuddy\workbb\backup\app.asar.orig（新建）
  大小     : 182027334 → 182027177  (-0 KB)

  读回校验 : 16/16 一致 ✓
```

**回滚：**

```powershell
node bin/workbb.js sealed revert --root "<安装根>"
```

实测：还原后 asar 内模板与原始文件**字节级完全一致**、SHA256 一致、原锚点恢复。

### 路线 B：手工（无 Node 环境时）

```powershell
# 需要 @electron/asar
npm i -g @electron/asar

# 解包（注意：真实 asar 含 arm64 等其它平台 unpacked 文件，全量解包会报 ENOENT）
# 建议只解包模板所在子目录
npx @electron/asar extract-file app.asar resources/templates/workbuddy-prompt.tpl
```

> ⚠️ 手工路线有个坑：真实 `app.asar` 有 **3293 个 unpacked 条目**
> （含 `win32-arm64`、`linux` 等其它平台文件），这些文件在磁盘上不存在。
> `extractAll` 会因读不到它们而报 ENOENT 失败。
> 所以 CLI 用的是「只搬运 packed 条目、unpacked 原封不动」的算法，不是全量解包。

---

## 注入算法（CLI 内部做的事）

```
1. 读原 asar：解析 header，算出 dataBase = 8 + @4
2. 遍历 header，收集所有 packed 条目（跳过 unpacked）
3. 按 offset 排序，依次搬运数据：
     - 要替换的模板 → 用定制模板字节
     - 其余         → 从原 asar 数据区原样切片
   每搬运一块，更新该条目的 offset / size / integrity(SHA256)
4. 重写 header：
     jsonLen  = JSON.stringify(header).length
     aligned  = alignUp(4 + jsonLen, 64)
     @0 = 4, @4 = 4+aligned, @8 = aligned, @12 = jsonLen
     @16.. = JSON
5. 拼接 [header, ...数据块] 写盘
```

**关键设计**：不碰 unpacked 条目。它们的 `unpacked: true` 保留，数据仍在
`app.asar.unpacked/` 下，Electron 照常从磁盘读。

---

## 实测记录

### 端到端（真实 asar 副本，模拟密封态）

```
=== 2) 条目统计 ===
  packed  : 6600
  unpacked: 3293
  模板形态: unpacked

=== 3) 模拟密封态：把模板条目改成 packed ===
  改后模板形态: packed
  能读出原始模板: ✓

=== 4) 注入定制模板 ===
  耗时: 567 ms
  结果: rebuilt
  替换文件数: 1
  大小变化: 182027334 → 182027177 (-0 KB)
  dataBase: 2609676 → 2609356

=== 5) 读回验证 ===
  1/1 个模板内容一致
  含放行段: ✓
  不含原锚点: ✓

=== 6) 抽查其它 packed 文件完整性 ===
   main/acp.js            83338B  integrity=✓
   main/nunjucks.js       93006B  integrity=✓
   main/main-bootstrap.js 822877B integrity=✓

=== 7) 从备份还原 ===
  还原: ✓ (173.6 MB)
```

注意：**6600 个 packed 文件全部重新搬运后，抽查的 3 个大文件 integrity 依然匹配** ——
说明重排算法没有破坏任何既有数据。

### 完整 CLI 流程（假安装根演练）

```
$ workbb apply --templates-dir ...
$ workbb sealed status --root FakeRoot
  条目统计 : packed=17  unpacked=0
  模板形态 : packed  （密封态，需要 sealed apply）

$ workbb sealed apply --root FakeRoot
✓ 已注入 16 个模板到 app.asar
  读回校验 : 16/16 一致 ✓

$ workbb sealed verify --root FakeRoot
✓ 全部一致 (16/16)

独立验证：注入后 asar 内的模板内容
  含放行段: ✓
  不含原锚点: ✓
  与定制模板一致: ✓

$ workbb sealed revert --root FakeRoot
✓ 已从备份还原 app.asar

还原后复查
  字节数: 31194 vs 原始 31194
  字节级完全一致: ✓
  SHA256 一致: ✓
  原锚点回来了: ✓
```

---

## 风险与边界

| 风险 | 程度 | 说明 |
|---|---|---|
| 改坏 asar 导致应用起不来 | 中 | 有自动备份 `app.asar.orig`，`sealed revert` 一条命令还原 |
| 官方升级覆盖 app.asar | 高 | 升级会整包替换，注入失效。需升级后重跑 `sealed apply` |
| 应用有 asar 大小上限/校验 | 未发现 | 实测改动后大小几乎不变（-0 KB） |
| unpacked 条目受影响 | 无 | 算法明确跳过它们 |

**必须提醒的一点**：密封态注入是**改安装体**。这意味着：

1. 官方升级一定会覆盖你的改动 → 每次升级后要重跑 `sealed apply`
2. 升级屏蔽（`workbb guard install`）就成了**必须做**的事，不是可选

如果目标是长期稳定，密封态机器更推荐的路子是：
- 先用 workBB 解包出 `app.asar.unpacked`（把模板变成实体文件）
- 然后走原来的 env 接管（官方支持，升级也不影响）

密封态注入是「不想解包时的次优解」，不是首选。

---

## 相关命令速查

```powershell
node bin/workbb.js sealed status [--root <安装根>]    # 看形态
node bin/workbb.js sealed apply  [--root <安装根>]    # 注入
node bin/workbb.js sealed verify [--root <安装根>]    # 校验
node bin/workbb.js sealed revert [--root <安装根>]    # 还原

# 也可显式指定 asar
node bin/workbb.js sealed apply --asar "D:\WorkBuddy\resources\app.asar"
```

# 安装与验证（面向执行方）

本文用纯技术描述，适合把仓库交给另一台机器上的助手按步骤执行。

---

## 这个仓库做什么

`workBB` 是一个 **本地模板管理工具**，处理的对象是 WorkBuddy 桌面客户端的
**提示词模板文件**（Nunjucks 格式，`.tpl`）。

它做三件事：

1. 把安装体里的模板**复制**到用户配置目录，形成一份可回滚的副本；
2. 在副本上做**纯文本替换**：把若干固定段落（策略段、文件操作约束段、命令约束段）
   换成一份由使用者撰写的等价段落；
3. 通过官方的环境变量 `WORKBUDDY_PROMPT_TEMPLATES_DIR` 让客户端优先加载这份副本。

**安装体本身不被修改。** 官方更新不受影响，也不需要重打。

---

## 前置条件

| 项 | 要求 | 检查方式 |
|---|---|---|
| Node.js | ≥ 18 | `node -v` |
| WorkBuddy | 已安装，且模板在磁盘上 | 见下方「模板位置」 |
| 磁盘形态 | 模板必须是**实体文件**，不是密封的 app.asar | 见下 |
| 权限 | 能写 `%USERPROFILE%\.workbuddy` | 无需管理员 |

### 模板位置怎么找

在 WorkBuddy 安装根下，模板可能在：

```
<安装根>\resources\app.asar.unpacked\resources\templates\workbuddy-prompt.tpl   ← 解包形态
<安装根>\resources\resources\templates\workbuddy-prompt.tpl                     ← app 目录整体解包
<安装根>\resources\templates\workbuddy-prompt.tpl
```

判断标准：**能直接读到 `workbuddy-prompt.tpl` 这个文件**。

如果只有 `resources\app.asar`（单一大文件）而没有 `app.asar.unpacked` 目录，
说明是密封态，模板取不出来 —— 需要先解包，或跳过模板部分只做自定义指令层。

---

## 安装步骤

```bash
git clone https://github.com/chenyu0922/workBB.git
cd workBB
npm install

# 1) 生成模板副本（自动探测安装位置；探不到就显式指定）
node bin/workbb.js apply

#    如果自动探测失败，用显式路径：
#    node bin/workbb.js apply --templates-dir "<安装根>\resources\app.asar.unpacked\resources\templates"

# 2) 指定加载方式（二选一）
#    2a. 生成启动脚本，双击即用
node bin/workbb.js launcher --exe "<安装根>\WorkBuddy.exe"
#    2b. 或设置用户级环境变量后重启客户端
setx WORKBUDDY_PROMPT_TEMPLATES_DIR "%USERPROFILE%\.workbuddy\workbb\templates"

# 3) 校验
node bin/workbb.js verify    # 渲染检查：无语法错误、无残留段落
node bin/workbb.js status    # 逐条看替换是否命中
node bin/workbb.js doctor    # 环境自检
```

期望输出（第 3 步）：

```
✓ 全部通过：无渲染错误，无策略段残留
合计 9 条：applied=9 partial=0 pending=0 na=0 missing=0
```

`pending` 非 0 说明该版本模板措辞与锚点不符 —— 属于版本差异，不是安装失败；
此时 `verify` 仍应通过（模板结构没坏），只是部分段未被替换。

---

## 回滚

```bash
node bin/workbb.js revert
reg delete "HKCU\Environment" /v WORKBUDDY_PROMPT_TEMPLATES_DIR /f   # 若设过环境变量
```

`revert` 会删除副本目录与状态文件，并恢复 inplace 模式下被改动的原始文件。
实测：`settings.json` 等用户配置逐字节还原，无残留。

---

## 换安装位置时的行为

探测顺序（可信度从高到低）：

1. `WORKBUDDY_PROMPT_TEMPLATES_DIR`（已生效的副本目录）
2. `WORKBUDDY_APP_PATH`（**显式指定，压倒其余全部**）
3. 注册表卸载项 `UninstallString` → 安装根
4. 运行中的 WorkBuddy 进程主模块路径
5. 常见安装位置（`Program Files`、`%LOCALAPPDATA%\Programs`、C–H 盘常见目录）
6. 官方工作目录候选链

任一项命中即停止。全部未命中时，`apply` 打印搜索过的候选清单与两种解法，
**不静默失败、不留半成品**。

---

## 需要人工确认的两点

1. **模板是否可读**（见「模板位置怎么找」）。这是唯一可能导致装不上的硬条件。
2. **是否接受改写后的行为**。替换段的内容在 `lib/patches.js` 的
   `CONTENT_POLICY_REPLACEMENT` / `PERSONAL_FILES_REPLACEMENT` /
   `WINDOWS_CMD_REPLACEMENT` 常量里，全部是明文，可以逐字审阅后再决定是否应用。
   若不希望应用，只跑 `custom-prompt install` 也能获得指令层效果，且不动模板。

---

## 已验证的环境

| 项 | 值 |
|---|---|
| WorkBuddy | 5.9.3 |
| 模板引擎 | Nunjucks 3.2.4（客户端自带，`autoescape:false`） |
| 模板形态 | `app.asar` 索引中标记 `unpacked: true` → 磁盘实体文件 |
| Node.js | 24.20.0（要求 ≥18） |
| 操作系统 | Windows 10 专业工作站版 |
| 安装位置 | `D:\WorkBuddy`（非默认盘符，靠注册表定位成功） |

跨机器演练覆盖：默认安装、自定义盘符、中文与空格路径、不同用户名、
未安装、显式路径 —— 六项全部通过（`node scripts/crosshost-test.mjs`）。

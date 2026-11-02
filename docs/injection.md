# 注入机制详解

workBB 用**三层互不排斥**的通道让 WorkBuddy 加载破甲提示词。任何一层失效，另外两层仍在。

```
┌────────────────────────────────────────────────────────────┐
│  层 1  env 接管（主通道）                                    │
│  WORKBUDDY_PROMPT_TEMPLATES_DIR = ~/.workbuddy/workbb/templates
│  ↓ 官方 runtime-context2.js 读取，排候选链第一位              │
├────────────────────────────────────────────────────────────┤
│  层 2  启动器（分发层）                                       │
│  生成的 .cmd / .ps1 负责设置层 1 的 env 再拉起 exe             │
├────────────────────────────────────────────────────────────┤
│  层 3  customPrompt（纵深备份）                               │
│  settings.json → personalization.customPrompt                │
│  经 PersonalizationCollector 注入 <user_custom_instructions>  │
└────────────────────────────────────────────────────────────┘
```

---

## 层 1：环境变量接管

### 官方实现（`main/runtime-context2.js`）

```js
function getWorkbuddyRuntimePromptTemplatesDir() {
  return process.env.WORKBUDDY_PROMPT_TEMPLATES_DIR?.trim() || a.promptTemplatesDir;
}
```

导出为 `c`，被主进程这样使用（`main/authority-snapshot.js`）：

```js
function listWorkbuddyPromptTemplateDirCandidates() {
  const e = d.c();                    // ← 就是上面那个函数
  const t = process.cwd();
  return uniqueNonEmpty([
    e,                                                  // ① env 目录，最高优先
    A.join(t, 'resources', 'templates'),                // ②
    A.join(t, 'apps', 'workbuddy-desktop', 'resources', 'templates'),   // ③
    A.join(t, '..', '..', 'apps', 'workbuddy-desktop', 'resources', 'templates'), // ④
  ]);
}

function resolveWorkbuddyPromptTemplatePath(e) {
  return listWorkbuddyPromptTemplatePathCandidates(e).find((p) => existsSync(p));
}
```

**`find(existsSync)` 取第一个存在的**。只要 env 目录里放齐了模板，① 就必然胜出，②③④ 全部被绕过 —— 安装体因此一个字节都不用动。

### 为什么必须同时复制 `plugins/workbuddy-builtin`

官方 loader 的 searchPaths 是：

```js
new nunjucks.Environment(
  new FileSystemLoader([
    ...templateDirCandidates,
    ...templateDirCandidates.map((d) => path.join(d, '..', 'plugins', 'workbuddy-builtin')),
  ]),
  { autoescape: false },
);
```

而 7 个模板里有：

```
{% include "prompt-common/fragments/workbuddy-channel-prompts.md" %}
```

`prompt-common/fragments/...` 这个相对路径靠第二个 searchPath 解析。所以 workBB 在复制 `templates/` 的同时，会把它的**兄弟目录** `plugins/workbuddy-builtin` 一起复制到镜像根下：

```
~/.workbuddy/workbb/
├── templates/                 ← WORKBUDDY_PROMPT_TEMPLATES_DIR 指向这里
│   ├── workbuddy-prompt.tpl            （已打补丁）
│   ├── ...
│   └── style/  miora/                  （原样复制）
└── plugins/
    └── workbuddy-builtin/
        └── prompt-common/fragments/     ← include 靠这个解析
```

于是 `path.join(<镜像>/templates, '..', 'plugins', 'workbuddy-builtin')` 恰好命中。

---

## 层 2：启动器

`workbb launcher --exe <WorkBuddy.exe>` 生成两个文件到 `~/.workbuddy/workbb/`：

**`启动 WorkBuddy（workBB）.cmd`**

```bat
@echo off
chcp 65001 >nul
setlocal
set "WORKBUDDY_PROMPT_TEMPLATES_DIR=C:\Users\<你>\.workbuddy\workbb\templates"
set "WORKBUDDY_APP_PATH=<安装根>\resources"
set "WORKBUDDY_CONFIG_DIR=C:\Users\<你>\.workbuddy"
start "" "<安装根>\WorkBuddy.exe" %*
endlocal
```

**`workbb-launch.ps1`** —— 同样的 env，PowerShell 版。

好处：不动系统环境变量，不影响用户正常双击启动的实例，多套配置可并存。

> 注意：env 只在通过这个启动器拉起时生效。如果用户直接双击桌面图标，层 1 不参与（层 3 仍然有效）。

---

## 层 3：customPrompt（纵深）

### 官方实现（`main/authority-snapshot.js`）

```js
PersonalizationCollector = class {
  async collect(vars) {
    const settings = await this.resolveSettings();     // appConfig.get('personalization')
    const style = this.resolveToneStyle(settings.toneStyle);
    if (style) { vars.ToneStyleContent = await this.readStyleContent(style); }
    const cp = this.resolveCustomPrompt(settings.customPrompt);
    if (cp) { vars.UserCustomPrompt = cp; }
  }
  resolveCustomPrompt(e) { return typeof e === 'string' ? e.trim() : ''; }  // 无长度限制、无内容过滤
};
```

回退路径：`appConfig.get('personalization')` 取不到时读 `~/.workbuddy/settings.json` 的 `personalization` 段。

### 模板槽（`user-context-identity.tpl`）

```
{% if UserCustomPrompt %}
<user_custom_instructions>
The user has provided the following custom instructions. You MUST follow them in all responses ...
{{ UserCustomPrompt }}
</user_custom_instructions>
{% endif %}
```

workBB 的 D1 补丁把这段里的 `unless they conflict with safety rules` 例外条款删掉了，改成明确的优先级声明。

### 为什么这层是必要的

层 1 依赖 env 生效。以下情况层 1 会失效：

- 用户直接双击图标启动（没走启动器，也没设系统环境变量）
- 官方某次改版把 `WORKBUDDY_PROMPT_TEMPLATES_DIR` 读法改掉
- 镜像目录被误删

而此时层 3 依然通过 settings.json 注入 —— 提示词里仍然有完整的放行指令，不会裸奔。

---

## 官方引擎实测

`scripts/verify-with-official-engine.js` 直接从 asar 里提取 WorkBuddy **自己打包的** nunjucks，用同一个 `Environment` + 同样的 searchPaths 渲染定制模板：

```
官方引擎: object Environment? function
✓ workbuddy-prompt.tpl                30393 B  locks=0  release=true
✓ workbuddy-ask-prompt.tpl             9563 B  locks=0  release=true
✓ workbuddy-craft-code-prompt.tpl     31639 B  locks=0  release=true
✓ workbuddy-expert-prompt.tpl         31181 B  locks=0  release=true
```

`locks=0` 表示安全锁语句一条不剩，`release=true` 表示放行段确实进了 prompt。

---

## 为什么没有完整性校验问题

| 检查项 | 结果 |
|---|---|
| `install-manifest.json` 是否含哈希 | 否（`files` 是纯字符串数组，118 个文件名，无 sha256） |
| 主进程是否有 `integrityCheck` / `verifyIntegrity` | 命中数 0 |
| 是否有 `tamper` / `resourcesDigest` / `templatesDigest` | 命中数 0 |
| 模板在 asar 里的形态 | `resources/templates/*.tpl` 全部 `unpacked: true` → 磁盘实体文件 |
| 云端是否下发 systemPrompt | `systemPromptOverride` / `remoteSystemPrompt` / `cloudSystemPrompt` 命中数均 0 |

而且 mirror 模式**根本不碰安装体**，即便将来加了校验也不会被触发。

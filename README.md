# dsh-session-purge

**在 DeepSeek Harness 的会话「⋯」菜单里，紧挨着「归档会话」加一行「删除对话…」。**
选择删除范围后，永久删除这个对话——以及你选择让它带走的文件。

[English](README.en.md) | 简体中文 | 仓库：<https://github.com/hshh603/dsh-session-purge>

> ⚠️ 删除不可撤销。插件把宿主端扫描出来的删除清单先摆在你面前，勾选确认后才会动手。请先拿一个不需要的对话试一次。

## 特性

- **就在归档旁边**：注册在 `sidebar.workspaces.session.menu.item` 的 `order: 410`，官方 `archive` 是 `400`，因此永远排在它正下方。
- **三档删除模式**，删除前先扫描并逐条列出会删什么、跳过了什么、为什么跳过。
- **宿主端独立校验**：浏览器只提交「会话 id + 模式 + 确认」，删除计划由宿主端从会话日志重新推导，前端改不了范围。
- **运行中的对话先停止再归档**，不会边删边有人往里写。
- **共享附件保守处理**：只有读遍其他所有已存储会话、确认无人引用，才删附件对象。
- **42 项离线验证**（`node verify/verify-host.mjs`），不需要 DSH 进程、端口或交互。

## 界面

侧栏任意一行会话，鼠标移上去 → 点行尾 **⋯** → 菜单里 **「归档会话」的下一行** 就是 **「删除对话…」**。

点开后弹出确认框，内容分四段：

1. **对话记录**：存储目录路径与体积；
2. **本对话产出的文件**：将被删除的文件清单与总体积，以及被跳过的条目；
3. **附件对象**：该对话引用了几个附件；
4. **删除模式单选** + 工作目录显示（若该对话正在运行，会有一行黄色提示）。

底部：「取消」与「删除」。**只有勾选「我已知晓：删除后无法恢复」后，「删除」才可点**。删除成功后页面自动重新加载（约 1.8 秒）刷新列表。

## 三种删除模式

| 模式 | 删除什么 | 保留什么 |
|---|---|---|
| **仅删除对话记录** | 该对话的全部会话日志文件（`<DSH_HOME>/sessions/<项目>/<会话id>/`），并从侧栏分组记账中移除 | 磁盘上该对话产出的文件、附件对象 |
| **删除对话记录 + 本对话产出的文件**（默认） | 上面这些，**外加**该对话的写入工具（`write` / `edit` / `str_replace_editor`）写入过的文件 | 只删除"真实路径严格位于该对话工作目录内"的普通文件；其他文件、目录、附件都保留 |
| **彻底删除（含附件对象）** | 上面这些，**外加**没有任何其他对话引用的附件对象 | 仍被其他对话引用的附件对象一律保留 |

> 「本对话产出的文件」指 Agent 用写作工具写进你工作目录的文件；「附件对象」指你拖进输入框发给对话的图片/文件。两者是两回事，见[附件是怎么存的](#附件是怎么存的)。

## 安装

插件是一个标准的 DSH bundle 包，`cordis.patch.yml` 已随包提供：

```yaml
- insert:
    - id: session-purge
      name: dsh-session-purge
```

### 方式一：插件管理器 / `plugin_manager` 工具

把本目录的**绝对路径**作为安装目标（宿主会读取该目录的 `package.json`），安装后它会自动加入 profile 的 `dsh.profile.bundles` 并启用。

### 方式二：从 npm 安装（发布之后）

```sh
dsh plugin --profile desktop add dsh-session-purge
```

### 方式三：手工链接（等价于其它本机插件）

```powershell
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-purge" "<本目录>"
```

然后在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾加上上面那段 `- insert:`，重启 DSH。

**生效时机**：宿主半（`lib/index.js`）的改动需要重启 DSH 才会加载（Loader 按包名缓存已导入的模块）；浏览器半（`lib/client.js`）改完文件后由 `client-modules` 的 HMR 直接送进已打开的页面，无需刷新。

## 使用

1. 侧栏会话行 → **⋯** → **「删除对话…」**；
2. 看清单，选模式，勾选确认，点「删除」；
3. 页面自动重新加载刷新列表，也可以点「立即重新加载」。

## 为什么它能删掉 DSH 自己不能删的东西

DSH 的会话持久化层明确没有删除接口：

- `@deepseek-ai/dsh-session-persistence`：*"No deletion or retention API — pruning stored sessions is out-of-band backend maintenance."*
- `@deepseek-ai/dsh-session-persistence-jsonl`：*"Nothing deletes session files."*
- `@deepseek-ai/dsh-attachment-local`：附件"永不自动删除"，也没有回收未引用对象的机制。

所以这个插件做的就是那份"带外的维护"，但**放在宿主进程内做**：它用 `ctx.sessionPersistence.open(id, 'read')` 读日志（不必自己解 Zstandard 帧），再按三档范围删除文件。

## 安全边界（全部在宿主端强制，前端说了不算）

- **会话 id 只接受单个安全路径段**（`[A-Za-z0-9][A-Za-z0-9._-]*`）。任何请求值都不会被拼进路径。
- **产出文件必须真实路径严格位于该会话记录的 `cwd` 之内**；不在其中、位于 `DSH_HOME` 之内、不是普通文件、无法解析真实路径（例如符号链接指向外部）的条目一律跳过，并在对话框里列出原因。
- **只删文件，不删目录**（会话日志目录除外，那是它自己的存储）。
- **附件对象只有在读遍所有其他已存储会话、确认无人引用后才会删除**；任何一次读取失败都按"仍被引用"处理，保留不动。
- 浏览器只提交「会话 id + 模式 + 确认标记」，宿主端会**重新推导整个删除计划**，因此前端内存里的数据无法扩大删除范围。
- `/plugins` 路由不受浏览器登录态保护，所以两个写接口额外要求带上本插件自己的标记头 `x-dsh-session-purge: 1`，并在带 `Origin` 时校验同源。别的网页发起的跨站请求设不了这个头（会先触发预检），因此无法借你的浏览器删掉对话。

### 附件是怎么存的

附件按内容寻址存放在 `<DSH_HOME>/attachments/v1/objects/<sha256前两位>/<sha256>`，**按内容哈希去重，因此是全局共享的，不属于任何单个对话**；通用文件另有 `file-objects/` 与按名字的只读硬链接目录 `files/`。正因为共享，第三档才会先去问遍其他对话再决定删不删。

## 已知限制

- **正在运行/打开的对话**：插件先以 `stopActivity: true` 归档它（停止进行中的工作、把归档集合写盘），再删文件。Windows 上如果日志文件仍被写入句柄占用，删除会失败并把原因写在对话框里——等当前回合结束后重试。
- **列表刷新**：`api-session/removed` 是尽力而为地广播；可靠做法是重新加载页面，成功后对话框就是这么做的。
- **共享附件**：内容寻址存储会去重，同一对象可能被多个对话引用。"彻底删除"因此有时会保留附件，这是有意为之。
- **`bash` / `pwsh` 里写的文件扫不出来**：只有写作类工具调用的目标路径能被识别，shell 重定向创建的文件不在清单内。
- **只验证过 DSH `0.2.0-rc.2`**（desktop / web profile）。其它版本请先跑离线验证，再核对 `sidebar.workspaces.session.menu.item` 与 `shell.overlay` 两个槽位契约是否仍然一致。

## 开发

```text
dsh-session-purge/
├── package.json          # 包清单：dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml      # profile 里挂载本插件的 bundle 层
├── lib/
│   ├── index.js          # 宿主半：三个 HTTP 接口 + 删除计划与执行
│   └── client.js         # 浏览器半：菜单项 + 确认对话框（手写 loader bundle）
├── verify/
│   └── verify-host.mjs   # 离线验证套件（42 项断言）
├── README.md             # 本文
├── README.en.md          # English
├── CHANGELOG.md
├── LICENSE               # MIT
└── .github/workflows/verify.yml
```

两个半都不需要构建步骤：宿主半是普通 ESM，浏览器半是手写的 `window.__ModuleLoader__` bundle。

```sh
node verify/verify-host.mjs   # 或 pnpm verify
```

套件用临时 DSH home 和桩 `sessionPersistence` / `webServer`，覆盖三档实际删除结果，含"工作目录外的文件不动""没写过的文件不动""仍被引用的附件不动""路径穿越 id 被拒""跨站请求被拒"等用例。维护者须知（DSH 契约、坑与调试路径）见 [AGENTS.md](AGENTS.md)。

## 仓库与发布

仓库：<https://github.com/hshh603/dsh-session-purge>（`package.json` 的 `repository` / `homepage` / `bugs` 都指向它）。

### 从仓库安装

```powershell
git clone https://github.com/hshh603/dsh-session-purge.git
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-purge" "%CD%\dsh-session-purge"
```

再把 [安装](#安装) 里的 `- insert:` 块加到 profile 的 `cordis.patch.yml`，重启 DSH。

### 提交更新

```sh
git add -A
git commit -m "fix: ..."
git push
```

### 发布到 npm（可选）

发布后即可 `dsh plugin --profile desktop add dsh-session-purge`：

```sh
npm login
npm publish
```

仓库里已经带好 `.gitignore`、`.gitattributes`（强制 LF、中文按 UTF-8 原样保存）、`.editorconfig` 与 GitHub Actions（三平台 × Node 22/24 跑语法检查 + 离线验证）。

## 许可

[MIT](LICENSE)

# DeepSeek Harness 插件集

四个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件：一个让**一个会话只服务一个文件**的 Agent 模式，一个**预览外壳**，以及两个用它的预览插件（Mermaid / D2）。

预览插件彼此独立、也独立于文件插件 —— 谁注册了扩展名，谁就负责渲染；文件插件只负责"打开这个地址"。

```text
dsh-file-session   一个文件一个会话          ← 绑定 / 守卫 / 改名 / Agent 模式
dsh-preview-kit    预览外壳（被下面两个 require）
dsh-mermaid        *.mmd  *.mermaid         → Mermaid 12，浏览器内渲染
dsh-d2             *.d2                     → d2 CLI，Host 侧编译
```

## 包含哪些插件

| 插件 | 用途 | 声称的资源 | 位置 | 断言数 |
| --- | --- | --- | --- | --- |
| **dsh-file-session** | 把会话锁定到唯一文件：绑定后只能写它，并把会话改名成文件名 | Agent Preset「文件会话」 | 仓库根目录 | 31 + 41 |
| **dsh-preview-kit** | 预览外壳：头部行、视图下拉、拖拽缩放、代码视图、打开方式、诊断路由 | —— | [`packages/dsh-preview-kit`](packages/dsh-preview-kit/README.md) | 10 |
| **dsh-mermaid** | Mermaid 图表预览（渲染 + 源码高亮） | `*.mmd` `*.mermaid` | [`packages/dsh-mermaid`](packages/dsh-mermaid/README.md) | 18 + 44 |
| **dsh-d2** | D2 图表预览（Host 侧调用 `d2` 编译） | `*.d2` | [`packages/dsh-d2`](packages/dsh-d2/README.md) | 22 + 24 |

> 断言数是 `host + browser` 两套测试的条数，每个包都自带 `test/` 与 `pnpm test`。

## 安装

在 DSH 里逐个安装。每个插件一条地址，**都实测可行** —— 各只产生一条依赖变化，这正是插件管理器的要求。

| 装哪个 | 在 DSH 里填什么 |
| --- | --- |
| `dsh-file-session` | `github:Sayi/dsh-plugin-kit` |
| `dsh-preview-kit` | `github:Sayi/dsh-plugin-kit#path:packages/dsh-preview-kit` |
| `dsh-mermaid` | `github:Sayi/dsh-plugin-kit#path:packages/dsh-mermaid` |
| `dsh-d2` | `github:Sayi/dsh-plugin-kit#path:packages/dsh-d2` |

两条注意：

- **先装 `dsh-preview-kit`**：两个预览都要 `require` 它。没装时预览会明确提示，并在提示里给出这条地址。
- **一次只能装一个**：管理器按"安装前后恰好一条依赖变化"判定装了哪个包，所以"一个地址装四个包"做不到；把仓库地址填去装 `packages/` 下的子包，就会出现「无法从依赖变更中确定安装了哪一个包」。

### 前置条件

- DSH 桌面端（本仓库按 0.2.x 的插件 / 插槽接口编写）。
- 只有 `dsh-d2` 额外需要 [`d2` CLI](https://d2lang.com)：`brew install d2`（或用环境变量 `DSH_D2_BIN` 指定路径）。

### 验证安装

文件插件自带一个只读健康路由（计数、版本戳、错误名；不含路径与密钥）：

```bash
curl -s "$DSH_WEB_URL/dsh-file-session/health"
# {"ok":true,"bindings":1,"liveAgents":0,"client":{"stamp":"…","injected":[…],"seats":3}}
# 端口每次重启都会变：从页面 URL 或环境变量 $DSH_WEB_URL 取，不要写死。
```

### 卸载与单独缺席

在插件管理器里卸载即可。**预览可以单独缺席**：`dsh-preview-kit` 不在时两个预览会变成惰性并提示如何安装，文件插件也能脱离它们单独工作。


## 插件功能

### dsh-file-session — 一个文件一个会话

- **绑定唯一文件**：用入口里的「新建文件 / 选择文件」，或由 Agent 在对话中创建 —— 它写入的第一个文件就成为绑定文件。
- **绑定是终身的**：绑定后不可切换、不可解绑；需要另一个文件就另开会话。
- **写守卫**：Agent 只能写那个文件；写别处会被拒绝并说明原因。读取不受限。
- **文件被删除时**：明确提示"文件已不存在"，并且**不允许静默重建** —— 会先拒绝一次写入并要求告知用户，只有用户明确要求重建时才在原路径重建。
- **会话改名**：绑定后会话标题即文件名，侧栏一眼可辨。
- **右侧预览**：绑定文件在右侧栏打开，由哪个插件渲染取决于扩展名。
- 完整文档：[docs/file-session.md](docs/file-session.md)。

### dsh-preview-kit — 预览外壳

- **头部行**：文件路径 + 视图下拉 + 「重新读取文件」 + 「打开方式」（与内置预览同一套 Remote 接口、同一份图标）。
- **图表视图**：拖拽平移；滚轮 / 捏合缩放；`+` `-` `0`、方向键；比例菜单（25%–400%、适应宽度）。
- **代码视图**：由各插件自己的语法高亮。
- **诊断路由**：浏览器半把"渲染到哪一步、有没有拿到平台能力"报回 Host（只有布尔 / 数字 / 类型名，**不含路径与密钥**）。
- 由于第三方 tab body 拿不到平台的 `renderSlot`，这里的「打开方式」是按平台**同一个** Remote 接口实现的 —— 细节见 [kit README](packages/dsh-preview-kit/README.md)。

### dsh-mermaid — Mermaid 预览

- 声称 `*.mmd` / `*.mermaid`，注册在 `extension` 带（优先级高于内置预览的 `fallback` 带）。
- 懒加载 chunk（约 5 MB）：Mermaid 12 与一份自写语法（声明、结构关键字、箭头、注释、字符串）。
- 语法错误时同时显示错误信息与源码，可改完点「重新读取文件」重渲染。

### dsh-d2 — D2 预览

- 声称 `*.d2`；**编译发生在 Host 侧**，调用 `d2` CLI（真正的实现：同一语法、同一布局引擎、错误自带行列号）。
- **需要 `d2` 可执行文件**：`brew install d2`，或用环境变量 `DSH_D2_BIN` 指定；没装时预览会明确告诉你如何安装，而不是白屏。
- chunk 仅 22 KB（highlight.js 核心 + 一份 D2 语法）。

## 开发

```bash
# packages/* 里各装一次依赖（测试与构建用）
cd packages/dsh-d2 && pnpm install

# 每个包各自跑测试：host 半（真实 d2、路由、守卫）+ 浏览器半（真实模块、替身浏览器）
cd packages/dsh-d2 && pnpm test

# 重建预览插件的懒加载 chunk（源码在 build/，产物提交进仓库，安装时无需构建）
cd packages/dsh-mermaid && pnpm build:chunk
```

三条约定，都是踩出来的：

- **两个半都包住 `apply`** —— 插件永远不该让 DSH 起不来。
- **客户端硬注入只声明已被证明可满足的服务** —— 注入不满足会让条目激活失败，而桌面端把"web boot 未激活"视为致命错误。
- **测试替身必须与真实形状一致**，否则测试会绿、应用会坏。这条踩过三次，记录在 [kit README](packages/dsh-preview-kit/README.md#test-doubles-what-three-bugs-taught)。

## 仓库结构

```text
.
├── index.js / client.js / cordis.patch.yml   dsh-file-session（host 半 / 浏览器半 / bundle 行）
├── assets/                                   「新建文档」用的空白 docx 模板
├── docs/                                     设计文档与调研笔记（含 file-session 完整文档）
├── test/                                     dsh-file-session 的两套测试
└── packages/
    ├── dsh-preview-kit/                      预览外壳（host 半刻意为空）
    ├── dsh-mermaid/                          内含生成的 client.mermaid.js
    └── dsh-d2/                               内含生成的 client.d2.js
```

## 已知限制

- **绑定不可切换**：这是设计而非缺陷；换文件请另开会话。
- **预览是独立插件**：不装预览插件时，文件仍由内置文本预览打开，不会失效。
- **「打开方式」列表**来自操作系统对该文件类型的关联；`.mmd` / `.d2` 通常没有关联，此时回落到平台已知的已安装应用列表。
- **诊断路由是开放的 GET**：只回计数、布尔与类型名，不含路径、绑定或密钥；不需要可以删掉。
- **`dsh-d2` 依赖本地 CLI**：无 CLI 的环境需要让 `DSH_D2_BIN` 指向可执行文件。

## 许可

[MIT](LICENSE) © 2026 Sayi。仓库内 `packages/` 下的每个包同样是 MIT。

被这些插件打包进懒加载 chunk 的第三方代码，各自保留原许可：

| 依赖 | 许可 | 出现在 |
| --- | --- | --- |
| [Mermaid](https://github.com/mermaid-js/mermaid) | MIT | `packages/dsh-mermaid/client.mermaid.js` |
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause | `client.mermaid.js`、`packages/dsh-d2/client.d2.js` |

# OwnContext

[English](README.md)

OwnContext 是一个单用户、自托管的 MCP 服务，让不同 AI 客户端读取和修正同一份私有 GitHub 仓库中的纯文本上下文。

## 用途：换客户端也保留上下文

Markdown 和 Git 让资料可以迁移。`stated` 标记用户明确说过的话，`inferred` 标记推断；来源引用方便追溯，SHA 校验让客户端修正笔记时避开他人的较新修改。

服务负责存储和提供工具。客户端决定读取哪些资料、怎样合并修正。标签和来源由客户端填写，其真实性仍需核对。

## 演示：保存后再修正

**30 秒录屏占位：** 在一个客户端保存虚构偏好，在另一个客户端读取并修正，最后展示旧 SHA 写入被拒绝。录屏待制作，下面的本地 demo 已可运行这条流程。

## 快速体验：先运行本地 demo

准备源码目录、**Node.js 24.11 或更新版本**及 npm，运行：

```sh
npm ci --registry=https://registry.npmjs.org
npm run demo
npm run setup -- --dry-run
```

安装依赖后，demo 和 setup 预览均可离线运行。demo 使用虚构资料和两个内存工具客户端，打印 Markdown 修改，并检查重复保存和旧 SHA 冲突。执行期间的数据留在内存，源码仓库保持原样，也不会启动 HTTP 服务。

## 部署：使用自己的账号

先读[快速开始](docs/zh/quickstart.md)和[权限说明](docs/zh/permissions-and-scopes.md)，再运行：

```sh
npm run setup
```

真实 setup 需要 Git、GitHub CLI、你自己的 GitHub 和 Cloudflare 账号、GitHub OAuth App，以及限定仓库的访问令牌。脚本会查询账号状态，要求输入 `deploy` 后才创建资源或发布 Worker。它可以创建私有笔记仓库、补齐缺失的虚构模板文件、创建 OAuth KV 并部署；同名已有模板文件会保留。

服务地址为 `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp`。首次连接建议保留默认只读权限，写入权限需在授权页单独勾选。

## 兼容性：按验证范围使用

| 对象 | 当前状态 |
| --- | --- |
| 本地 demo | 可执行，已在 macOS、Node 24 下运行 |
| MCP SDK 的 Streamable HTTP 客户端 | 集成测试使用真实 Worker handler，GitHub 和 KV 为测试替身 |
| Claude Code、claude.ai | setup 提供连接方法，真实登录及跨客户端操作留待发布验收 |
| 部署平台 | Cloudflare Workers、Workers KV 和 GitHub.com |
| setup CLI | 需要 Node 24.11+、Git、`gh` 和项目内 Wrangler；macOS 已运行，Linux CI 已配置；原生 Windows 待验证 |

其他客户端需支持同样的 HTTP 传输和 OAuth 流程。当前实现仅提供远程 Streamable HTTP 接口。详见[兼容性说明](docs/zh/compatibility.md)。

## 隐私：资料经过哪些服务

```text
MCP 客户端 → 你的 Cloudflare Worker → 你的私有 GitHub 仓库
                       ↓
                Workers KV 中的 OAuth 状态
```

GitHub 登录用于识别唯一允许的账号。Worker 通过另一枚细粒度令牌访问笔记仓库。笔记、修正及可选的选定片段会保留在私有 Git 历史中。Cloudflare 处理请求，GitHub 存储文件；客户端可能按其服务条款把返回的上下文交给模型提供方。

OwnContext 自身只提供存储和工具，不调用模型，也未接入分析服务或自动采集 hook。工具日志仅记录工具名和状态；平台及命令行工具另有日志设置。文件内容以明文供服务处理，片段按输入原样保存。详见[隐私与数据流](docs/zh/privacy-and-data-flow.md)。

## 工具：读取与写入分开授权

- 读取：`get_context`、`search`、`read`。
- 写入：`remember`、`update_note`，需要单独授予 OAuth 写权限。
- 可选工具：`capture_conversation`、`log_decision`、`log_meal`，默认关闭。

`update_note` 需要 `read` 返回的 SHA；创建文件时传 `null`。内容冲突会被拒绝，客户端需重新读取、合并。`remember` 会跳过完全重复的事实。可选片段采集只保存客户端提交的内容，通过稳定批次标识处理重试；采集动作由客户端发起。

## 费用：软件免费，账号自备

软件采用 Apache-2.0，免费使用。GitHub 和 Cloudflare 账号由你提供，存储、请求等费用按平台规则收取。免费额度及适用条件以平台为准。AI 客户端订阅和模型用量另计，OwnContext 的 setup 只配置服务资源。

## 范围：面向个人纯文本资料

- 一个允许登录的 GitHub 身份、一份私有仓库。OAuth 权限按读写划分，覆盖所有允许路径。
- 支持 UTF-8 文本，单个可读文件上限为 200 KiB；检索采用子串匹配。
- 读写受 GitHub API 延迟和配额影响。搜索结果按页返回，空结果页仍可能带继续扫描的游标。
- 来源和标签依赖客户端判断，修正内容由客户端编写。
- 规则文件和 `me/values.md` 仅由仓库所有者直接修改。删除当前文件后，旧内容仍可能留在 Git 历史和备份中。
- 当前产品范围限于工具调用；删除、定时任务、后台采集、完整会话导出、多文件事务及代用户托管均在范围外。

## 文档：按操作查阅

- [快速开始](docs/zh/quickstart.md)
- [隐私与数据流](docs/zh/privacy-and-data-flow.md)
- [权限说明](docs/zh/permissions-and-scopes.md)
- [恢复与卸载](docs/zh/recovery-and-uninstall.md)
- [兼容性说明](docs/zh/compatibility.md)

## 开发与许可证

```sh
npm run lint
npm run typecheck
npm test
npm run check:release
npm run build
```

参与开发请读 [CONTRIBUTING](CONTRIBUTING.md)、[SECURITY](SECURITY.md) 和[行为准则](CODE_OF_CONDUCT.md)。代码采用 [Apache-2.0](LICENSE)，版权归 clean99，另见 [NOTICE](NOTICE)。

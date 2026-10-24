# 快速开始

[首页](../../README.zh-CN.md) · [English](../en/quickstart.md)

## 本地体验：运行虚构资料

在源码目录准备 Node.js 24.11 或更新版本及 npm：

```sh
node --version
npm ci --registry=https://registry.npmjs.org
npm run demo
npm run setup -- --dry-run
```

安装依赖会下载公共软件包。demo 自身只读取 `templates/knowledge/`，使用内存 GitHub 替身。它保存一条虚构偏好，验证重复保存只写一次，再通过第二个工具客户端读取并修正，最后拒绝旧 SHA 修改并打印差异。这次演示仅覆盖本地工具链，真实 OAuth 和 AI 客户端留待部署后验收。

setup 预览只打印计划，全程离线，也不会写配置文件。

## 账号准备：先限制仓库权限

真实 setup 会操作远程资源。运行前请读[隐私说明](privacy-and-data-flow.md)和[权限说明](permissions-and-scopes.md)。

1. 安装 Git 和 [GitHub CLI](https://cli.github.com/)。Wrangler 已包含在项目依赖中，可运行 `git --version`、`gh --version` 和 `npx --no-install wrangler --version` 检查。
2. 用 `gh auth login --hostname github.com` 和 `npx --no-install wrangler login` 登录自己的账号。setup 只检查已有登录态。
3. 先创建一份私有 GitHub 笔记仓库，与本源码仓库分开。setup 虽有建仓功能，但会在创建资源前索取仓库令牌；限定到单个仓库的令牌需要目标仓库已经存在。先建仓便于遵循最小权限原则。
4. 创建细粒度 GitHub 令牌，仅选择该私有仓库，授予 **Contents：读写**和 **Metadata：只读**。它供 Worker 使用，与本地 `gh` 登录凭据分开。
5. 确定 Worker 名称、Cloudflare account ID 和 HTTPS origin，例如 `https://owncontext.YOUR-SUBDOMAIN.workers.dev`。账号需已有可用的 Workers 子域名，自定义域名由你另行配置。
6. 在 [GitHub OAuth App 设置](https://github.com/settings/developers)创建应用，主页填该 origin，回调填 `https://owncontext.YOUR-SUBDOMAIN.workers.dev/callback`。保留 client ID 和 secret。登录仅识别身份，GitHub scope 为空。
7. 运行 `gh api --hostname github.com user --jq '{login, id}'`，记录唯一允许登录的 GitHub login 和数字 ID；两项都会校验。时区可填 `UTC` 等 IANA 名称，语言选 `en` 或 `zh`。

通过 setup 的隐藏输入框填写密钥。也可由密钥管理器私下注入 `GITHUB_CLIENT_SECRET` 和 `OWNCONTEXT_GITHUB_TOKEN` 环境变量，脚本经 stdin 传给 Wrangler。请让命令历史、截图、问题单和源码只包含占位符。

## 部署：确认目标后执行

```sh
npm run setup
```

向导把非密钥配置保存在已忽略的 `.owncontext/` 下，检查工具和账号，查询仓库及 Cloudflare 资源，列出待执行动作。核对仓库、Worker 和 origin 后，输入 `deploy` 确认。

setup 仅补入模板中缺失的文件，同名文件保持原样。基础上下文需要 `AGENTS.md`、`me/profile.md`、`me/preferences.md` 和 `me/values.md`。你可以在私有仓库直接把虚构示例换成自己选定的资料；已有文件的结构和大小需自行核对。

新 Worker 可能先以缺少密钥的状态发布，密钥安装完成前，请求会返回服务不可用。中断后可恢复：

```sh
npm run setup -- --resume
```

恢复操作会查询远程状态并继续执行，可能再次部署。同一源码目录继续使用原来的仓库、账号和 Worker；其他安装请另用目录。实际部署配置在 `.owncontext/wrangler.json`。单独运行 `npm run deploy` 使用的是根目录尚未配置的模板。

## 客户端：从只读连接开始

setup 会打印实际服务地址。Claude Code 的配置命令为：

```sh
claude mcp add --transport http owncontext https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/mcp
```

在 Claude Code 的 MCP 连接管理中完成浏览器登录。claude.ai 使用 **Settings → Connectors → Add custom connector**，填写同一个 `/mcp` 地址。入口可用性取决于客户端版本、套餐和组织策略；这里提供配置方法，真实客户端验收仍待完成。

在 OwnContext 授权页核对客户端及回跳地址，用配置的 GitHub 账号登录。默认只读；仅向可信客户端勾选 `owncontext:write`。授权后，服务按该权限执行后续写入，每次写入的用户确认由客户端负责。

可以先让客户端调用 `get_context`，再搜索主题、`read` 命中的文件。引用时读取完整来源，简版卡片可能省略引用。修正时先取完整笔记和 SHA，保留有效信息及来源，再调用 `update_note`；冲突后重新读、重新合并。

## 检查：区分只读与写入验收

```sh
npm run doctor -- --dry-run
npm run doctor
```

前者离线预览。后者请求保存的 origin，检查 `/health` 及源码、配置指纹。仓库检查需要私下提供 `OWNCONTEXT_ACCESS_TOKEN`，它必须是 **OwnContext 签发的 OAuth access token**，可由已授权客户端或 OAuth 测试客户端提供。doctor 自身只做检查，登录和令牌获取由客户端完成。缺少令牌时，健康检查仍可通过，但 doctor 会报告缺少令牌并以失败状态结束。

`OWNCONTEXT_URL` 可覆盖 origin。手动配置、没有 setup 状态的安装还需设置 `OWNCONTEXT_BUILD_ID` 为预期指纹。

获得写权限且明确允许验收写入后，运行：

```sh
npm run doctor -- --acceptance
```

该命令连接两个 MCP SDK 客户端，写入独立的虚构笔记 `topics/owncontext-acceptance-<id>.md`，要求 `raw/snippets/preferences.md` 保持模板内容。已成功写入的内容会留在 Git 历史中，即使后续步骤失败。普通 doctor 仅执行读取。

## 可选工具：部署后单独启用

默认关闭 `capture_conversation`、`log_decision` 和 `log_meal`。操作者可在 `.owncontext/wrangler.json` 的 `vars.ENABLED_TOOLS` 中填入逗号分隔的工具名，再显式部署：

```sh
npx --no-install wrangler deploy --config .owncontext/wrangler.json
```

这是一次真实部署。当前 setup/resume 会把 `ENABLED_TOOLS` 重新生成为空，后续恢复时需重新检查定制项。构建指纹也无法覆盖这类手动配置变更。可选工具同样需要 OAuth 写权限；片段原样保存，请在提交前完成选取和脱敏。

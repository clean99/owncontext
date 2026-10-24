# 兼容性说明

[首页](../../README.zh-CN.md) · [English](../en/compatibility.md)

## 接口：远程 HTTP 与 OAuth

OwnContext 通过 Cloudflare Agents MCP handler 在 `/mcp` 提供 Streamable HTTP。OAuth 使用 `@cloudflare/workers-oauth-provider`，配置了资源与服务元数据发现、动态客户端注册、Client ID Metadata Documents、浏览器授权和授权码流程。GitHub 上游流程使用 state 和 S256 PKCE。

客户端需支持该 HTTP、OAuth 流程，并通过浏览器以允许的 GitHub 身份登录。当前仅提供远程接口；stdio、旧 `/sse`、GitHub token 直连及公开笔记读取均未实现。公开 `/health` 在配置校验后返回服务名、版本和构建指纹，GitHub 可达性由 doctor 后续检查。

## 验证范围：本地结果与真实验收分开

| 对象 | 源码中的依据 | 发布状态 |
| --- | --- | --- |
| 内存 demo | `tests/cli-demo.test.ts`、`npm run demo` | 已在 macOS、Node 24 下运行 |
| MCP HTTP、OAuth | `tests/http-auth.test.ts`、`tests/cli-doctor.test.ts` 使用真实 Worker handler 和 OAuth 库，GitHub、KV 为替身 | 有本地集成覆盖，真实部署登录待验收 |
| setup 生命周期 | `tests/cli-setup.test.ts` 对外部命令使用 stub | 本地覆盖创建、恢复、取消及密钥处理 |
| Worker 打包 | `npm run build` 调用 Wrangler dry-run | 仅验证离线打包 |
| Claude Code | setup 输出 `claude mcp add --transport http ...` | 已提供配置方法，真实客户端待验收 |
| claude.ai | setup 输出自定义 connector 设置方法 | 已提供配置方法，真实客户端待验收 |

demo 的两个客户端是内存工具适配器，doctor 验收使用两个 MCP SDK 连接。它们证明对应的本地及协议行为，真实 AI 产品之间的调用还需单独测试。客户端入口取决于套餐、组织策略和版本；其他 MCP 客户端也需要先验证再使用。

## 平台：固定托管与存储适配

- CLI 使用 Node.js 24.11+ 和 npm。setup 还需要 Git、GitHub CLI，以及 npm script PATH 中的项目 Wrangler。
- 服务运行于 Cloudflare Workers，启用 `nodejs_compat`、`global_fetch_strictly_public`，并绑定 `OAUTH_KV`；兼容日期固定在配置中。
- 存储及身份使用 GitHub.com、一份私有仓库的默认分支、一个 GitHub 身份。其他 Git 服务需要另写适配器。
- macOS 已本地运行，CI 配置为 Ubuntu、Node 24。原生 Windows setup 待验证，`scripts/wrangler.sh` 需要 Bash。
- `LOCALE=en` 或 `zh` 影响生成标签。授权页及 CLI 提示目前为英文。时区使用 IANA 名称，默认为 UTC。

## 容量：分页与单文件校验

单个可读文件上限 200 KiB。GitHub 目录树被截断时，服务拒绝继续读取。搜索每页最多扫描 25 个文件，返回最多 30 条带相邻行的命中；输出字节上限可能让页面更早结束。即使本页没有命中，也需检查 `next_cursor`；目录树变化后重新搜索。

简版上下文返回长度为 180、300、120 字符的资料卡，附路径和 SHA。引用或阅读被截断内容时，应取完整来源。完整版上下文和搜索结果也有输出上限，过大的基础资料需逐个读取。

SHA 比较交换以单文件为单位。`update_note` 的相同内容重试可以在旧 SHA 下返回 `unchanged`，不同正文使用旧 SHA 则被拒绝。多文件操作分别提交，GitHub API 配额及网络延迟直接影响请求。当前检索采用子串匹配，同步由请求触发。

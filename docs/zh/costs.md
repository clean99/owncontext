# 费用与限额

[首页](../../README.zh-CN.md) · [English](../en/costs.md)

OwnContext 软件免费，运行时使用你自己的 Cloudflare 和 GitHub 账号。实际用量符合各项免费额度时，部署费用可以为零。评估时需同时检查请求量、CPU 时间和 OAuth 存储操作。下列价格以美元计，官方资料查阅于 **2026-10-25**。选择套餐前请再次查看原页面。

## 资源：按实际实现计费

| 组件 | OwnContext 的用途 |
| --- | --- |
| Cloudflare Worker | 处理 HTTP MCP 请求、OAuth 接口和 `/health` |
| Workers KV | `OAUTH_KV` 保存 OAuth 客户端注册、授权、令牌记录及授权流程状态 |
| GitHub.com | 私有仓库保存文本和 Git 历史；REST 请求读取仓库信息、目录树和 blob，通过文件内容接口写入 |
| AI 客户端及模型提供方 | 订阅和模型用量由你承担，独立于 OwnContext |

当前配置只使用 Worker 和 KV，D1、Durable Objects、R2、向量数据库及定时任务均在范围外。MCP handler 无状态，笔记正文按请求从 GitHub 读取。模型调用和 embedding 由客户端自行决定；OwnContext 自身只处理存储与工具。可选片段和日志工具也写入同一 GitHub 仓库。依据见[运行入口](../../src/index.ts)、[绑定配置](../../wrangler.jsonc)、[仓库适配器](../../src/github.ts)及[隐私说明](privacy-and-data-flow.md)。

## Workers：请求量与 CPU 分别计算

来源为 [Workers 价格][workers-pricing]和 [Workers 限额][workers-limits]，查阅日期为 2026-10-25。

| 项目 | Free | Workers Paid，Standard 计费 |
| --- | --- | --- |
| 基础费用 | $0 | 每账号每月至少 $5 |
| 入站请求 | 每账号每天 100,000 次，UTC 00:00 重置 | 每月包含 1,000 万次，超出部分每百万次 $0.30；每天请求量不限 |
| CPU 时间 | 每次调用最多 10 ms | 每月包含 3,000 万 CPU-ms，超出部分每百万 CPU-ms $0.02 |
| 单次 HTTP 调用 CPU 上限 | 10 ms | 默认 30 秒，可配置到 300 秒 |
| 内存 | 每个 isolate 128 MB | 每个 isolate 128 MB |

等待 GitHub 或 KV 响应的时间属于 I/O 等待。CPU 时间用于 JSON 处理、文本扫描和加解密等计算。选用 Free 前，应测量实际部署的 CPU 用量，重点检查搜索及 OAuth。当前配置沿用平台默认 CPU 上限。

访问 GitHub 的 fetch 属于出站子请求，入站 Worker 请求按客户端访问另行计数。Workers 的出站流量免带宽费。Free 每次调用允许 50 次出站 fetch 子请求；下文的正常搜索页最多访问 GitHub 27 次。分页限制单页开销，完整搜索仍需累计各页的 GitHub 请求。

客户端初始化、工具发现、登录、重试和健康检查也会产生入站请求。同一账号的其他 Worker 共享 Free 每天请求额度。请求额度或单次 CPU 超限可能导致接口不可用；升级付费套餐由账号所有者另行操作。

## KV：OAuth 操作单独计量

来源为 [KV 价格][kv-pricing]和 [KV 限额][kv-limits]，查阅日期为 2026-10-25。下表的 Paid 额度随 Workers Paid 套餐提供，基础月费就是上文的 $5。

| 项目 | Free | Paid 包含用量及超出费用 |
| --- | --- | --- |
| 读取 | 每天 100,000 次 | 每月 1,000 万次，超出部分每百万次 $0.50 |
| 写入 | 每天 1,000 次 | 每月 100 万次，超出部分每百万次 $5 |
| 删除 | 每天 1,000 次 | 每月 100 万次，超出部分每百万次 $5 |
| 列表查询 | 每天 1,000 次 | 每月 100 万次，超出部分每百万次 $5 |
| 存储量 | 1 GB | 1 GB，超出部分每 GB-month $0.50 |

Free 操作额度在 UTC 00:00 重置，某类操作超额后会失败。两个套餐都限制同一 key 每秒写入一次，单个 value 最多 25 MiB。OwnContext 笔记的 200 KiB 上限作用于 GitHub 文件，与 KV 上限分别计算。

OAuth 鉴权会读取 KV。注册、授权、令牌签发或刷新及撤销也会使用 KV，具体次数取决于客户端流程和固定版本的 OAuth 库。频繁重连和刷新令牌的开销需单独计算。应在 Cloudflare 账号中观察各项用量；笔记写入次数与 KV 写入次数分别计量。

## GitHub：共享账号的 API 额度

[GitHub Free][github-plans]提供数量不限、功能受限的私有仓库。OwnContext 使用普通仓库文件，运行时存储只依赖该仓库，Git LFS、Packages、Codespaces 和 Actions 均非必需。

Worker 使用 `OWNCONTEXT_GITHUB_TOKEN` 细粒度个人访问令牌调用仓库 REST API。普通已认证用户额度为**每小时 5,000 次 REST 请求**，同一用户的其他个人令牌及用户授权应用也会消耗这份额度。GitHub OAuth 登录另用仅识别身份的令牌调用 `GET /user`；仓库访问仍按个人令牌计量。依据见[登录实现](../../src/auth.ts)及 [GitHub REST 限流规则][github-limits]，查阅日期为 2026-10-25。

GitHub 还设有二级限流，包括 REST 与 GraphQL 合计最多 100 个并发请求、每个 REST endpoint 通常每分钟 900 点，以及内容创建操作通常每分钟 80 次、每小时 500 次。多数读取计一点，多数写入计五点，平台还可能施加其他限制。安排批量写入时，需要同时控制瞬时频率。

下表按一个新 MCP 请求中的一次工具调用计算，假设全程成功且没有写入冲突。

| 操作 | 仓库 REST 请求 | 新增提交 |
| --- | --- | --- |
| `read` 已有文件 | 3 次：仓库信息、递归目录树、blob | 0 |
| 简版 `get_context` | 最多 5 次：仓库信息、目录树、三个资料卡 blob | 0 |
| 一页 `search` | 最多 27 次：仓库信息、目录树、最多 25 个 blob | 0 |
| 完整版 `get_context` 的一页 | 最多 31 次：仓库信息、目录树、四个基础文件及最多 25 个索引文件 | 0 |
| `remember` 或 `update_note` 修改已有笔记 | 4 次：仓库信息、目录树、blob、Contents `PUT` | 1 |
| `remember` 或 `update_note` 新建笔记 | 3 次：仓库信息、目录树、Contents `PUT` | 1 |
| 重复 `remember` 或内容未变的 `update_note` | 已有笔记读取 3 次，跳过 `PUT` | 0 |

[仓库适配器](../../src/github.ts)在实例内缓存目录树和 blob，[服务构建](../../src/tools.ts)为请求创建该实例。表格按各文件 blob 内容不同计算，跨 HTTP 请求重新计数。完整版上下文中的基础文件与索引文件重叠时，请求数会减少。成功的 [Contents `PUT`][github-contents]同时创建提交并返回 SHA，提交本身由这次请求完成。分页和去重规则见[工具实现](../../src/knowledge.ts)。

`remember` 和可选追加工具遇到 `409`／`422` 写入冲突时，最多尝试四次，因此可能增加目录树读取、blob 读取和写入。GitHub 返回 `403`／`429` 限流时，适配器直接报告 `github_request_failed` 及上游状态码，重试等待由客户端负责；工具错误也会省略上游的 `Retry-After` 和 `x-ratelimit-reset`。遇到限流应停止连续调用。GitHub 要求优先遵循 `Retry-After`；主额度耗尽时等到 `x-ratelimit-reset`，其他二级限流至少等待一分钟，连续失败时逐渐延长等待。`403` 也可能来自权限问题。

## 单人估算：按调用次数计算

**以下为示例估算，实际费用需结合部署用量判断。** 假设每天调用简版上下文 10 次，搜索 20 页，每页扫描 25 个不同 blob；读取已有文件 60 次，向已有笔记成功追加新事实 10 次。每次调用使用新请求，全程没有冲突或重试。

```text
每天工具调用：       10 + 20 + 60 + 10 = 100
每天 GitHub 请求：   10×5 + 20×27 + 60×3 + 10×4 = 810
30 天 GitHub 请求：  810×30 = 24,300
每天新增提交：       10
```

若同一账号没有其他活动，即使这些请求集中在一小时内，仓库请求量仍低于普通每小时 5,000 次额度。二级限流仍然适用。Worker 请求还需加上协议交互和登录请求；GitHub 登录及 setup 的请求也在这份估算之外。

使用 Free 时，实际 CPU、各类请求与操作次数、存储量均符合额度，部署费用才为 $0。使用 Workers Paid 时，各项用量都在包含额度内，基础费用为每月 $5。这份估算只计算仓库请求，CPU 需实测，OAuth KV 次数需按实际流程统计。较大的笔记、重复全量扫描、同账号其他工作负载和客户端重连都会改变结果。客户端订阅与模型费用由你另行承担。

[workers-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[workers-limits]: https://developers.cloudflare.com/workers/platform/limits/
[kv-pricing]: https://developers.cloudflare.com/kv/platform/pricing/
[kv-limits]: https://developers.cloudflare.com/kv/platform/limits/
[github-plans]: https://docs.github.com/en/get-started/learning-about-github/githubs-plans
[github-limits]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[github-contents]: https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents

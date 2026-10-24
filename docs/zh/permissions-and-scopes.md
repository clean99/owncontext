# 权限说明

[首页](../../README.zh-CN.md) · [English](../en/permissions-and-scopes.md)

## 凭据：按用途分开

| 凭据 | 用途与最小权限 |
| --- | --- |
| 本地 `gh` 登录 | setup 查询仓库，并可创建私有仓库、补齐模板文件，需要相应 GitHub 权限 |
| 本地 Wrangler 登录 | 在所选 Cloudflare 账号中管理 Worker 配置、发布、密钥及 OAuth KV |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | GitHub OAuth App 用于识别唯一用户；ID 是公开配置，secret 放入 Worker secrets |
| `OWNCONTEXT_GITHUB_TOKEN` | 仅访问选定私有仓库的细粒度令牌，Contents 读写、Metadata 只读，供 Worker 使用 |
| OwnContext OAuth 令牌 | 让客户端按授予的 scope 调用 `/mcp`，与 GitHub 令牌分开 |

OAuth App 和仓库令牌由账号所有者创建。setup 保持仓库可见性及账号权限原样，通过隐藏输入或环境变量接收密钥，再经 stdin 交给 Wrangler；生成的 JSON 仅保存非密钥配置。部署状态和 CLI 日志也应保持私有。

## OAuth：读写分别授权

| Scope | 效果 |
| --- | --- |
| `owncontext:read` | 所有 MCP 调用必需，允许 `get_context`、`search`、`read` |
| `owncontext:write` | 在读权限基础上，允许 `remember`、`update_note` 和已启用的可选写工具 |
| `offline_access` | 在有效期内通过刷新延续连接 |

授权页默认选择读取和离线访问，写入复选框默认未选中。后续要写入时，重新连接并明确勾选。服务端会校验 scope；客户端工具列表中出现写工具，只表示工具存在。

Access token 有效期为一小时；refresh token 配置了 30 天有效期和空闲上限。登录、令牌交换和 MCP 请求都会检查配置的数字 GitHub ID，以及忽略大小写的 login。上游 GitHub 登录请求空 scope；如果返回旧授权附带的额外 scope，连接会被拒绝。

写授权覆盖后续允许路径内的写操作，每次调用的确认由客户端负责。OAuth 按读写划分，不按目录隔离。只读客户端也能读取允许路径下已经存在的可选日志。

## 文件范围：规则和价值观受保护

允许读取 `me/`、`areas/`、`people/`、`topics/`、`decisions/`、`data/`、`raw/`、`summaries/`、`docs/` 下的文本，以及这些确切路径：

```text
AGENTS.md
CLAUDE.md
README.md
HANDOVER.md
START_HERE.md
integrations/owncontext.json
```

扩展名包括 `.md`、`.txt`、`.json`、`.jsonl`、`.csv`、`.yaml`、`.yml`。文件需为普通 UTF-8 blob，单文件最多 200 KiB。隐藏路径、路径穿越、符号链接、子模块和二进制内容会被过滤或拒绝。

`remember` 写入 `me/`、`areas/`、`people/`、`topics/` 下的 Markdown，`update_note` 还支持 `summaries/`。`me/values.md`、上述只读文件及嵌套的 `AGENTS.md`、`CLAUDE.md` 受保护，只能由仓库所有者直接修改。

| 可选工具 | 写入位置 |
| --- | --- |
| `capture_conversation` | `raw/conversations/YYYY-MM/<batch>.jsonl` |
| `log_decision` | `decisions/YYYY-MM-DD-<slug>.md` |
| `log_meal` | `data/meals/YYYY-MM.jsonl` |

可选工具名称需出现在 `ENABLED_TOOLS` 中，客户端仍需写 scope。setup 默认把该配置生成为空，定制前请看[快速开始](quickstart.md)。

这些限制作用于 MCP API。持有仓库令牌或 GitHub 直接访问权的操作者具备独立权限。笔记内容仅作为资料，不能用来授权操作；客户端仍需防范资料中的恶意指令。

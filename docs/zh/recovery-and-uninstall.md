# 恢复与卸载

[首页](../../README.zh-CN.md) · [English](../en/recovery-and-uninstall.md)

## 排查：先运行只读检查

`npm run doctor -- --dry-run` 离线预览，`npm run doctor` 请求已保存的 Worker origin，只做读取。仓库检查需要私下提供 OwnContext OAuth access token。`--acceptance` 会写入虚构笔记，需单独决定是否运行。

| 现象 | 处理方法 |
| --- | --- |
| setup 中断 | 保留 `.owncontext/setup.json`，运行 `npm run setup -- --resume`，脚本先查询状态再补齐步骤 |
| 本地 JSON 无效 | 修复保存的非密钥配置，凭据继续通过私密方式提供 |
| 仓库公开或不可访问 | 选择私有仓库，核对仓库令牌的所有者、目标、权限和有效期 |
| 缺少基础上下文 | resume 可补入缺失模板；已有规则和资料卡的内容、大小需直接检查 |
| 登录身份错误 | 同时核对 GitHub login、数字 ID 及 OAuth App 回调 origin |
| GitHub OAuth 带额外 scope | 在 GitHub 撤销该应用的旧授权，再以仅身份权限连接 |
| 缺少写 scope | 重新连接 OwnContext，并单独勾选写权限 |
| 客户端令牌过期 | 由客户端刷新或重新登录；doctor 仅检查连接 |
| 构建过旧 | 核对本地变更，运行 setup/resume 部署，检查 origin 是否对应目标 Worker |
| `note_changed_read_and_merge` | 重新读完整笔记和 SHA，合并后再写入 |
| `index_changed_restart_search` | 重新发起搜索或索引分页 |

resume 是真实远程操作，可能再次部署，并将手动启用的可选工具恢复为 setup 默认值。保存的构建指纹只用于对照，不能证明远程配置完全一致。

## 密钥轮换：先撤销泄露凭据

仓库令牌泄露时，先在 GitHub 撤销旧令牌，再创建仅访问同一笔记仓库的新令牌。OAuth App secret 泄露时，在 GitHub 重新生成。更换 Worker 密钥后，已经签发的 OwnContext OAuth 授权仍需单独撤销。

通过 Wrangler 的隐藏输入更新，明确指定生成的配置：

```sh
npx --no-install wrangler secret put OWNCONTEXT_GITHUB_TOKEN --config .owncontext/wrangler.json
npx --no-install wrangler secret put GITHUB_CLIENT_SECRET --config .owncontext/wrangler.json
```

按实际轮换对象选择命令。也可私下注入对应环境变量后运行 setup/resume，脚本会把显式提供的密钥视为轮换请求。只看到远程存在密钥名称，不能判断其值是否过期。

## 撤销客户端：处理服务端授权

移除 connector 可能只删除客户端配置。OAuth 库通过元数据中的 `revocation_endpoint` 提供撤销，目前路径为 `/oauth/token`。调用者需以该令牌所属客户端的身份认证。撤销 access token 只撤销该令牌；撤销 refresh token 会撤销对应授权。优先使用客户端自带的撤销功能，OwnContext 当前未提供授权管理界面。

紧急情况下，先在 Cloudflare 停用或移除 Worker 及路由。恢复前如需撤销全部会话，可清除**该安装专用的 OAuth KV namespace** 中的记录，或换用新 namespace 并重新绑定。所有客户端均需重新注册连接。操作前核对绑定，确保其他应用未共用该 namespace。KV 变更传播需要时间，处理泄露期间保持 Worker 不可访问。后续 resume 会按预期 namespace 名称协调资源，运行前需再次核对。

撤销 GitHub OAuth App 授权只处理上游登录授权；OwnContext 授权需独立撤销。仓库令牌一旦泄露，也要单独轮换或撤销。

## 笔记恢复：保留有效的新修改

在私有仓库查看文件历史，通过 GitHub 或 Git 恢复、合并所需版本，同时保留有效的新修改。普通 revert 会新增提交，旧版本仍留在历史中。MCP 当前只提供读取及受校验的写入工具。

如保存了敏感内容，先清理当前版本、撤销其中暴露的凭据，再按 GitHub 的[敏感资料移除流程](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)处理历史。克隆、备份和客户端会话需分别清理；强推只能改变仓库引用，其他副本仍可能存在。

## 卸载：由账号所有者执行

1. 在所有客户端移除 connector 并撤销授权，或按上述方法停用 Worker、使全部 OAuth 状态失效。
2. 在 Cloudflare 删除该 Worker、相关路由或自定义域名，以及专用 OAuth KV namespace。先确认这些资源只供本安装使用。
3. 撤销细粒度仓库令牌、GitHub OAuth App 授权；若应用为本安装专用，可删除该应用。
4. 按保留需要决定是否删除私有笔记仓库。已有克隆、备份及客户端或平台记录需另行处理。
5. 确认不再需要后，删除本地源码目录及其中 `.owncontext/`、`.cache/`、`.wrangler/`、密钥文件，并清理环境变量。本地 `gh` 和 Wrangler 账号登录供其他项目共用时可保留。

卸载由账号所有者手动完成。执行删除前核对资源名称和备份。

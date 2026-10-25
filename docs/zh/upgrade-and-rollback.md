# 升级与回退

[首页](../../README.zh-CN.md) · [English](../en/upgrade-and-rollback.md)

本文用于已有安装。首次部署请看[快速开始](quickstart.md)。下文的 deploy 和 rollback 命令会修改线上 Worker，示例使用源码目录中由 setup 生成的 `.owncontext/wrangler.json`。

命令已按项目固定的 **Wrangler 4.149.0** 帮助及文末 Cloudflare 官方资料核对，查阅日期为 **2026-10-25**。真实部署和回退需在你的账号中另行验收，本地检查只覆盖对应的本地行为。

## 升级前：记录可用部署

使用 Node.js 24.11 或更新版本，并沿用原安装的 GitHub 和 Cloudflare 账号。切换源码前运行：

```sh
git status --short
git rev-parse HEAD
npx --no-install wrangler deployments status --config .owncontext/wrangler.json
npx --no-install wrangler versions list --config .owncontext/wrangler.json
```

在私有操作记录中保留源码提交和当前可用的 **Worker version ID**。`versions list` 包含已上传但可能从未接收流量的版本，当前线上版本以 `deployments status` 为准。Worker version ID、OwnContext 的 `BUILD_ID` 指纹和 Git commit SHA 分别记录。

setup 会改写 `.owncontext/`，升级前先把该目录备份到源码目录之外的私有位置。保留实际部署配置，包括可选工具和手动设置，并记录当前 `/health` 的构建指纹。切换 ref 前另存工作区修改。备份含账号标识，应与公开源码分开保存。

阅读目标版本的迁移和兼容说明，私下备份或克隆笔记仓库及其历史。Worker 回退后，仓库和 OAuth KV 数据仍保持当前状态。继续保留原 KV namespace 和有效凭据。

## 升级：沿用原安装目标

从源码提供方取得已审查的 release tag 或 commit，将下文 `YOUR_RELEASE_REF` 换成真实 ref。具体标签以实际提供的版本为准。若源码仓库使用 `origin`：

```sh
git fetch --tags origin
git switch --detach YOUR_RELEASE_REF
npm ci --registry=https://registry.npmjs.org
npm run lint
npm run typecheck
npm test
npm run check:release
npm run build
npm run setup -- --dry-run
```

`build` 使用虚构 KV ID 运行本地 Wrangler dry-run。`setup --dry-run` 打印离线计划，线上资源差异由真实 setup 查询。

对于沿用生成配置默认值的安装，运行：

```sh
npm run setup -- --resume
```

核对计划中的账号、仓库、Worker 和 origin，确认目标正确后输入 `deploy`。resume 会查询线上资源，重新生成配置及 `BUILD_ID`，按计划部署。它也可能补齐缺失模板或重新创建缺失资源，同名模板文件和已有笔记会保留。出现资源缺失或目标异常时，先停下核对再继续。

setup/resume 会把 `ENABLED_TOOLS` 重新生成为空，并覆盖生成配置中的其他手动修改。已有定制配置时，先保留私有副本，**在允许 setup 部署前**审查差异。如果接受先部署默认配置，期间暂停受影响的客户端。随后把确认兼容的定制项合并到新生成的配置，再显式部署：

```sh
npm run deploy -- --config .owncontext/wrangler.json
```

该 script 调用 `wrangler deploy`，等价命令为 `npx --no-install wrangler deploy --config .owncontext/wrangler.json`。单独运行 `npm run deploy` 会选中尚未配置的根目录模板。直接复用旧生成配置可能让新代码携带旧 `BUILD_ID`，因此应先按上面的 setup 流程更新。手动定制项需另行检查，构建指纹只覆盖 setup 计算的内容。

## 升级后：检查实际服务

```sh
npx --no-install wrangler deployments status --config .owncontext/wrangler.json
npm run doctor -- --dry-run
npm run doctor
```

从已授权客户端或 OAuth 测试客户端私下提供 `OWNCONTEXT_ACCESS_TOKEN`，它必须是 OwnContext 签发的 access token。仓库令牌用于 Worker 访问 GitHub，doctor 使用前者。doctor 先比较 `/health` 与预期源码、配置指纹，再通过已认证 MCP 调用 `get_context`。缺少令牌时会跳过仓库检查，并以失败状态退出。单独访问 `/health` 只校验配置，GitHub 可达性由后续请求验证。

复查已有客户端连接、新的浏览器登录，以及定制的可选工具。浏览器 OAuth 和手动配置变化需单独验证。若还要检查写入和旧 SHA 拒绝行为，明确选择 `npm run doctor -- --acceptance`；该命令会写入虚构笔记，并在私有仓库保留提交。前置条件见[快速开始](quickstart.md)。所需检查通过后，再把新 Worker version ID 记为可用版本。

## 回退：指定已记录版本

选择升级前记录的可用版本，将 `YOUR_GOOD_VERSION_ID` 换成其真实 Worker version ID：

```sh
npx --no-install wrangler versions view YOUR_GOOD_VERSION_ID --config .owncontext/wrangler.json
npx --no-install wrangler rollback YOUR_GOOD_VERSION_ID --config .owncontext/wrangler.json
npx --no-install wrangler deployments status --config .owncontext/wrangler.json
```

逐项核对 Wrangler 提示。显式填写 ID 可以固定回退目标。回退会立即创建一次部署，让现有路由和域名的 **100% 流量**转到该版本，本地源码保持原样。Cloudflare 支持回退到最近 100 个已发布版本；目标版本引用的资源，包括 KV namespace，必须仍然存在。资源变更可能阻止回退。

旧版本发布后若更改过 secret，Cloudflare 通常会阻止直接部署旧版本，Wrangler 可能再次要求确认。此时先检查凭据。凭据已经轮换或撤销时，应使用仍然有效的当前 secret 和兼容配置重新部署已审查的旧源码，保留这道回退检查。GitHub 中已撤销的凭据继续保持撤销状态。

目标版本已不可用或与当前数据不兼容时，先保留当前状态，再选择兼容的恢复版本。用 `npm run deploy -- --config .owncontext/wrangler.json` 部署旧源码，会创建一个**新的** Worker 版本。发布前准备该源码对应的配置和 `BUILD_ID`，保留正确的 KV 绑定，并核对迁移说明。

## 回退后：使用对应源码检查

回到升级前的确切部署时：

- 将本地源码切换到记录的 Git commit，再运行 `npm ci --registry=https://registry.npmjs.org`。
- 在该源码目录恢复对应的私有 `.owncontext/` 备份。后续部署前，再核对其中的目标和手动设置。
- 私下提供有效的 OwnContext access token，在匹配的源码目录运行 `npm run doctor`，并复查客户端访问和已启用工具。

doctor 根据本地源码、模板、lockfile 和已保存的 setup 配置计算预期指纹。回退后继续用新源码运行 doctor，可能正确报告 `stale-deploy`。此时直接照提示运行 setup/resume 会重新部署新代码，应先切到计划保留的源码版本。只修改本地状态中的 `deployedFingerprint`，doctor 的计算结果仍保持原样。

手动安装且没有 setup 状态时，doctor 使用 `OWNCONTEXT_URL` 和 `OWNCONTEXT_BUILD_ID`。预期指纹应取自部署前的记录，保留它与实际响应之间的独立比较。

## 数据与凭据：分别处理保留状态

| 状态 | 升级或回退后的行为 |
| --- | --- |
| GitHub 笔记及历史 | 保留在私有仓库；Worker 回退后笔记写入仍保留，内容恢复需另用 Git 历史 |
| OAuth KV | namespace 中的注册、授权、令牌及流程状态继续保留；回退改变代码和绑定配置，KV 内容保持当前状态 |
| OwnContext 客户端令牌 | 代码兼容，且 namespace、origin、允许身份和 scope 保持一致时，可继续使用；有效期和撤销规则照常生效 |
| GitHub 仓库令牌及 OAuth App secret | 普通代码部署保留已有 Worker secrets；setup 补充缺失值或安装明确提供的新值，跨 secret 变更回退会触发上文的检查 |
| 本地 `.owncontext/` 状态 | setup 会更新；远程回退保持本地文件原样 |

当前代码配置 access token 有效期为一小时，refresh token 有效期及空闲上限为 30 天。OwnContext 授权需单独撤销，代码回退或更换 GitHub secret 后仍可能有效。更换 KV namespace、身份或 origin 后，客户端可能需要重新连接。升级 OAuth 库时需核对 KV 格式兼容性，Worker 回退会继续读取现有数据。当前项目的数据迁移及恢复由操作者按版本要求执行，项目尚未提供通用迁移或回退脚本。

凭据泄露、授权撤销、笔记恢复和卸载请按[恢复与卸载](recovery-and-uninstall.md)处理。常规升级保留 OAuth KV。

## 来源：代码与官方命令说明

项目行为依据为 [setup](../../src/cli/setup.ts)、[配置与指纹](../../src/cli/setup-plan.ts)、[doctor](../../src/cli/doctor.ts)、[OAuth 有效期](../../src/index.ts)及 [package scripts](../../package.json)，查阅日期为 2026-10-25。

Cloudflare 官方资料，均查阅于 2026-10-25：

- [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)：部署、版本查看、部署状态及回退命令。
- [Versions and deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)：版本快照及独立存储状态。
- [Rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)：流量切换、可选版本及资源限制。
- [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)：secret 修改与部署行为。
- [Create deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/)：跨 secret 变更回退时的检查及 `force` 参数。

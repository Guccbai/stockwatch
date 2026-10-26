# StockWatch

通用的云服务商库存监控平台。单个二进制（内嵌 WebUI + SQLite），库存变化时通过 Telegram 或 Resend 邮件推送。

第一版支持 **OVHcloud 独立服务器**（Kimsufi / So you Start / Rise / Advance 等），覆盖 EU、CA、US 三个区域，使用 OVH 公开接口，无需 API Key。

## 功能

- **库存浏览**：机型 × 机房矩阵，显示每个机房有货的配置数和最快交付时间；展开可看到每个内存/硬盘配置的状态。
- **订阅**：按机型或具体配置（内存/硬盘组合）订阅，可限定机房、按配置 ID 子串过滤（如 `ram-64g`、`nvme`），选择“仅补货”或“补货 + 售罄”通知。库存浏览中展开机型，可直接订阅某一配置。
- **Telegram 通知**：同一次轮询的变化合并成一条消息；同一配置在冷却期内反复变化只通知一次。支持多个 chat_id。
- **邮件通知**：通过 [Resend](https://resend.com) 发送，支持多个收件人；可与 Telegram 同时启用。
- **Bot 命令**：`/status` 当前有货的订阅、`/subs` 订阅列表、`/pause` `/resume` 暂停/恢复通知（只响应已配置的 chat）。
- **历史记录**：所有状态变化和通知发送结果，SSE 实时刷新。

## 快速开始

### Docker

镜像发布在 GHCR，支持 `linux/amd64`、`linux/arm64`、`linux/arm/v7`：

```bash
docker run -d --name stockwatch -p 8080:8080 -v ./data:/data \
  -e SW_ADMIN_PASSWORD=change-me-please ghcr.io/guccbai/stockwatch:latest
```

或使用仓库里的 `docker-compose.yml`（`docker compose up -d`；加 `--build` 则从源码构建）。

打开 http://localhost:8080 ，用 `SW_ADMIN_PASSWORD` 登录，在「设置」中填写 Telegram Bot Token 和 Chat ID，或 Resend API Key、发件人和收件人，点击「发送测试消息 / 测试邮件」确认。

### 预编译二进制

在 [Releases](https://github.com/Guccbai/stockwatch/releases) 下载对应平台的压缩包（Linux / macOS / Windows / FreeBSD，含 arm64 与 armv7），解压后运行：

```bash
SW_ADMIN_PASSWORD=your-password ./stockwatch
```

`checksums.txt` 里有各文件的 SHA-256。

### 从源码构建

需要 Go 1.27+ 和 Node.js 20+。

```bash
make all          # 构建 WebUI 并编译 bin/stockwatch
SW_ADMIN_PASSWORD=your-password ./bin/stockwatch
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SW_LISTEN` | `:8080` | 监听地址 |
| `SW_DATA` | `./data` | 数据目录（SQLite 数据库） |
| `SW_ADMIN_PASSWORD` | — | 首次启动时的管理员密码；未设置则随机生成并打印在日志中。之后在 WebUI 修改 |
| `SW_TELEGRAM_TOKEN` | — | 可选，覆盖 WebUI 中的 Bot Token |
| `SW_TELEGRAM_CHAT_ID` | — | 可选，覆盖 WebUI 中的 Chat ID（逗号分隔） |
| `SW_TELEGRAM_API` | `https://api.telegram.org` | Bot API 地址，可指向自建 Bot API 服务或反向代理 |
| `SW_RESEND_API_KEY` | — | 可选，覆盖 WebUI 中的 Resend API Key |
| `SW_RESEND_FROM` | — | 可选，覆盖 WebUI 中的发件人（需为 Resend 已验证域名，如 `StockWatch <alerts@example.com>`） |
| `SW_RESEND_TO` | — | 可选，覆盖 WebUI 中的收件人（逗号分隔） |
| `SW_RESEND_API` | `https://api.resend.com` | Resend API 地址 |
| `SW_FAKE_PROVIDER` | `false` | 启用一个每次轮询都会翻转库存的演示服务商，用于测试通知 |

轮询间隔（最小 15 秒）、通知冷却、监控区域、历史保留天数都在 WebUI「设置」中调整。有启用订阅的区域会自动加入监控。

> 建议放在 HTTPS 反向代理之后使用；Cookie 会在 `X-Forwarded-Proto: https` 时自动设置 `Secure`。

## 架构

```
cmd/stockwatch          入口
internal/provider       Provider 接口与注册表
internal/provider/ovh   OVH 实现（库存 + 目录/价格）
internal/monitor        调度、状态对比、通知分发、SSE Hub
internal/notify         Notifier 接口；telegram/、resend/ 为 Telegram、邮件实现
internal/store          SQLite 持久化与迁移
internal/api            REST API、鉴权、SSE、内嵌 SPA
web/                    React + Vite + Tailwind WebUI
```

每个（服务商, 区域）一个轮询协程：拉取全量库存 → 与上次状态对比 → 只有状态跃迁才记录事件 → 匹配订阅 → 合并通知。首次见到的配置只记录基线，不会在首次启动时刷屏。失败时指数退避（最长 10 分钟）；接口异常返回空数据时会忽略本次结果。

### 新增服务商

实现 `provider.Provider` 接口并在 `main.go` 中 `provider.Register(...)`：

```go
type Provider interface {
    ID() string
    Name() string
    Regions() []Region
    FetchCatalog(ctx context.Context, region string) ([]Product, error)        // 名称/规格/价格，每 6 小时刷新
    FetchAvailability(ctx context.Context, region string) ([]Availability, error) // 每个轮询周期调用
}
```

`Availability` 以（provider, region, config, location）为唯一键，状态归一化为 `available / low / unavailable / unknown`，原始状态保存在 `RawState` 中用于展示。

## 开发

```bash
make dev       # 后端 :8080，启用演示服务商，密码默认 stockwatch
make dev-web   # Vite 开发服务器，/api 代理到 :8080
make test
make dist      # 交叉编译所有平台的发布包到 dist/
```

### 发布

推送 `v*` 标签即可，GitHub Actions 会运行测试、把各平台二进制发布到 Releases，并推送多架构镜像到 `ghcr.io/guccbai/stockwatch`（标签 `X.Y.Z`、`X.Y` 和 `latest`；带 `-` 的预发布版本不更新 `latest`）：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

### 语言服务器（Claude Code）

项目自带一个项目级 Claude Code 插件 `stockwatch-lsp`（`.claude/lsp/`，已在 `.claude/settings.json` 中启用），不需要全局安装任何语言服务器：

- **Go**：gopls 版本固定在 `tools/go.mod`（独立模块，不影响主依赖），通过 `go tool -modfile=tools/go.mod gopls` 运行。
- **TypeScript**：使用 `web/node_modules` 中 TypeScript 7 自带的原生 LSP（`tsc --lsp`），需先在 `web/` 下 `npm ci`。

首次打开项目时信任该目录，Claude Code 会提示安装插件；也可以手动执行：

```bash
claude plugin install stockwatch-lsp@stockwatch-local --scope project
```

# StockWatch

通用的云服务商库存监控平台，运行在 Cloudflare Workers + Durable Objects 上，WebUI 由 Static Assets 提供，免服务器运维。库存变化时通过 Telegram 或 Resend 邮件推送。

第一版支持 **OVHcloud 独立服务器**（Kimsufi / So you Start / Rise / Advance 等），覆盖 EU、CA、US 三个区域，使用 OVH 公开接口，无需 API Key。

## 功能

- **库存浏览**：机型 × 机房矩阵，显示每个机房有货的配置数和最快交付时间；展开可看到每个内存/硬盘配置的状态。
- **订阅**：按机型或具体配置（内存/硬盘组合）订阅，可限定机房、按配置 ID 子串过滤（如 `ram-64g`、`nvme`），选择“仅补货”或“补货 + 售罄”通知。库存浏览中展开机型，可直接订阅某一配置。
- **Telegram 通知**：同一次轮询的变化合并成一条消息；同一配置在冷却期内反复变化只通知一次。支持多个 chat_id。
- **邮件通知**：通过 [Resend](https://resend.com) 发送，支持多个收件人；可与 Telegram 同时启用。
- **Bot 命令**：`/status` 当前有货的订阅、`/subs` 订阅列表、`/pause` `/resume` 暂停/恢复通知（只响应已配置的 chat）。
- **历史记录**：所有状态变化和通知发送结果，SSE 实时刷新。

## 部署

需要 Workers 付费计划（每次轮询一个 OVH 区域约 35–45 ms CPU，超过免费计划的 10 ms）。

```bash
npm ci
npx wrangler login
npx wrangler secret put ADMIN_PASSWORD   # 首次登录密码，至少 8 位；之后在 WebUI 修改
npm run deploy                            # 构建 web/ 并部署
```

打开 Workers 地址登录，在「设置」里填写 Telegram Bot Token 和 Chat ID，或 Resend API Key、发件人和收件人，点击「发送测试消息 / 测试邮件」确认。保存或打开仪表盘时，会自动为当前域名注册 Telegram Webhook；关闭「启用机器人命令」则删除 Webhook。

建议部署后先确认 OVH 不拦截 Cloudflare 的出口 IP：登录后访问 `/api/probe`（默认探测 eu、ca、us 三个区域）。

### 配置

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | 首次登录密码，WebUI 中改过后不再使用 |
| `TELEGRAM_TOKEN` `TELEGRAM_CHAT_ID` | Secret，可选 | 覆盖 WebUI 中的设置（Chat ID 逗号分隔） |
| `RESEND_API_KEY` `RESEND_FROM` `RESEND_TO` | Secret，可选 | 覆盖 WebUI 中的设置（发件人需为 Resend 已验证域名） |
| `TELEGRAM_WEBHOOK_SECRET` | Secret，可选 | 固定 Webhook 密钥；默认自动生成 |
| `TELEGRAM_API` `RESEND_API` | Var，可选 | API 地址（自建代理或测试替身） |
| `FAKE_PROVIDER` | Var | `true` 时加入每次轮询都翻转库存的演示服务商，用于测试通知 |

轮询间隔（最小 15 秒）、通知冷却、监控区域、历史保留天数都在 WebUI「设置」中调整。有启用订阅的区域会自动加入监控。

## 架构

```
src/index.ts                       Worker：/api/*（Cookie 登录）+ /telegram/webhook；其余路径由 Static Assets 提供 WebUI
  ├─ Hub DO "default" (hub.ts)
  │     设置、管理员密码与会话、订阅、冷却、通知日志；决定哪些区域要轮询；
  │     匹配订阅并发 Telegram / Resend；Bot 命令；SSE 推送
  └─ Poller DO "<provider>/<region>" (poller.ts)，每个区域一个
        该区域的库存状态、事件、商品目录（DO 内置 SQLite）；自己的 Alarm 定时轮询；
        每次轮询把状态和跃迁报给 Hub；库存矩阵、配置详情、下单链接也直接由它计算
test/                              单元测试与录制的 OVH 接口数据
web/                               React + Vite + Tailwind WebUI
```

每次轮询：拉取全量库存 → 与上次状态对比 → 只有状态跃迁才记录事件 → 匹配订阅 → 合并通知。首次见到的配置只记录基线，不会在首次启动时刷屏。失败时指数退避（最长 10 分钟）；接口异常返回空数据时会忽略本次结果。

库存事件 ID 为“毫秒时间戳 × 1000 + 序号”，跨区域唯一且按时间有序，历史页的分页（`?before=`）因此可以跨多个 Poller 合并。密码使用 PBKDF2-SHA256（10 万次迭代，Workers 上限）。

## 本地开发

```bash
npm ci
npm run build:web
cp .dev.vars.example .dev.vars
npm run dev          # http://localhost:8787
npm test             # 单元测试（test/testdata 为录制的 OVH 接口数据）
npm run typecheck
```

改 WebUI 时可在 `web/` 下 `npm run dev` 启动 Vite，`/api` 代理到 `:8787`。

本地是 HTTP，Telegram Webhook 不会注册；要测 Bot 命令，在 `.dev.vars` 里设 `TELEGRAM_WEBHOOK_SECRET`，然后带 `X-Telegram-Bot-Api-Secret-Token` 请求头 POST 到 `/telegram/webhook`。

## 实测（2026-10-28，本地 `wrangler dev`）

| 项 | 结果 |
| --- | --- |
| OVH 数据量 | availabilities：EU/CA 4.3 MB（约 3.7 万个配置×机房），US 6.6 MB（4.3 万）；catalog 10–12 MB |
| CPU | 每次轮询解析+对比约 35–45 ms/区域；库存矩阵页（读 3.7 万行并汇总）本地约 110–140 ms |
| 内存 | 128 MB 是**按 isolate** 的上限，同类 DO 可能共用一个 isolate。单区域常驻约 16 MB，解析 catalog 时临时再加约 30 MB；几个 Poller 恰好同时解析时可能接近上限，上线后在面板的内存指标里观察 |
| 存储 | 单个 EU 区域约 20 MB；首次基线写入约 3.7 万行/区域 |

### 注意

- 打开 WebUI 期间 Hub 会因 SSE 连接保持活跃，按 DO 时长计费。
- 改密码后所有会话失效。

### 语言服务器（Claude Code）

项目自带一个项目级 Claude Code 插件 `stockwatch-lsp`（`.claude/lsp/`，已在 `.claude/settings.json` 中启用），使用 `web/node_modules` 中 TypeScript 7 自带的原生 LSP（`tsc --lsp`），需先在 `web/` 下 `npm ci`。

首次打开项目时信任该目录，Claude Code 会提示安装插件；也可以手动执行：

```bash
claude plugin install stockwatch-lsp@stockwatch-local --scope project
```

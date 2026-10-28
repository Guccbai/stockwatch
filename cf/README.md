# StockWatch on Cloudflare Workers

StockWatch 的第二种部署方式：Workers + Durable Objects + Static Assets，免服务器运维。功能与 Go 版一致：WebUI 不变（同一个 `web/`），`/api` 与 Go 版兼容，支持 Telegram 与 Resend 通知、Bot 命令、SSE 实时刷新。

## 架构

```
Worker (src/index.ts)              /api/*（Cookie 登录）+ /telegram/webhook；其余路径由 Static Assets 提供 WebUI
  ├─ Hub DO "default" (src/hub.ts)
  │     设置、管理员密码与会话、订阅、冷却、通知日志；决定哪些区域要轮询；
  │     匹配订阅并发 Telegram / Resend；Bot 命令；SSE 推送
  └─ Poller DO "<provider>/<region>" (src/poller.ts)，每个区域一个
        该区域的库存状态、事件、商品目录；自己的 Alarm 定时轮询；每次轮询把状态和跃迁报给 Hub；
        库存矩阵、配置详情、下单链接也直接由它计算
```

| Go 版 | Cloudflare 版 |
| --- | --- |
| `monitor.loop` 协程 + 定时器 | Poller 的 Alarm（失败指数退避，最长 10 分钟） |
| `Monitor.state`（内存） | Poller 内只保留 status/raw/changedAt 的精简 Map，按需从 SQLite 加载 |
| SQLite 单库 | Hub 一个库 + 每个区域一个库（DO 内置 SQLite） |
| `monitor.Hub` SSE | Hub DO 持有 SSE 连接，Poller 每次轮询后由 Hub 推送 |
| Telegram `getUpdates` 长轮询 | Webhook，Hub 自动注册（需 HTTPS），密钥自动生成 |
| bcrypt | PBKDF2-SHA256，10 万次迭代（Workers 上限） |
| `SW_*` 环境变量 | Workers Secrets / Vars（名称去掉 `SW_` 前缀） |

库存事件 ID 为“毫秒时间戳 × 1000 + 序号”，跨区域唯一且按时间有序，历史页的分页（`?before=`）因此可以跨多个 Poller 合并。

## 部署

需要 Workers 付费计划（每次轮询一个 OVH 区域约 35–45 ms CPU，超过免费计划的 10 ms）。

```bash
cd cf
npm ci
npx wrangler login
npx wrangler secret put ADMIN_PASSWORD   # 首次登录密码，至少 8 位；之后在 WebUI 修改
npm run deploy                            # 构建 ../web 并部署
```

打开 Workers 地址登录，在「设置」里填写 Telegram / Resend。保存或打开仪表盘时，Hub 会自动为当前域名注册 Telegram Webhook；关闭「启用机器人命令」则删除 Webhook。

建议部署后先确认 OVH 不拦截 Cloudflare 的出口 IP：登录后访问 `/api/probe`（默认探测 eu、ca、us 三个区域）。

### 配置

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Secret | 首次登录密码，WebUI 中改过后不再使用 |
| `TELEGRAM_TOKEN` `TELEGRAM_CHAT_ID` | Secret，可选 | 覆盖 WebUI 中的设置 |
| `RESEND_API_KEY` `RESEND_FROM` `RESEND_TO` | Secret，可选 | 覆盖 WebUI 中的设置 |
| `TELEGRAM_WEBHOOK_SECRET` | Secret，可选 | 固定 Webhook 密钥；默认由 Hub 生成 |
| `TELEGRAM_API` `RESEND_API` | Var，可选 | API 地址（自建代理或测试替身） |
| `FAKE_PROVIDER` | Var | `true` 时加入每次轮询都翻转库存的演示服务商 |

轮询间隔、冷却、监控区域、保留天数在 WebUI「设置」中调整，与 Go 版相同。

## 本地开发

```bash
cd cf
npm ci
npm run build:web
cp .dev.vars.example .dev.vars
npm run dev          # http://localhost:8787
npm test             # 单元测试（共用 Go 版的测试数据）
npm run typecheck
```

本地是 HTTP，Telegram Webhook 不会注册；要测 Bot 命令，在 `.dev.vars` 里设 `TELEGRAM_WEBHOOK_SECRET`，然后带 `X-Telegram-Bot-Api-Secret-Token` 请求头 POST 到 `/telegram/webhook`。

## 实测（2026-10-28，本地 `wrangler dev`）

| 项 | 结果 |
| --- | --- |
| 功能 | 登录/限流/改密码/退出、仪表盘、库存矩阵与配置详情（含配置价格）、预选配置的下单跳转、订阅增删改、历史分页、设置、测试消息、SSE 实时刷新与补货提示、Telegram 与 Resend 通知、Bot 命令、跨站请求拦截，全部通过 |
| OVH 数据量 | availabilities：EU/CA 4.3 MB（约 3.7 万个配置×机房），US 6.6 MB（4.3 万）；catalog 10–12 MB |
| CPU | 每次轮询解析+对比约 35–45 ms/区域；库存矩阵页（读 3.7 万行并汇总）本地约 110–140 ms |
| 内存 | 128 MB 是**按 isolate** 的上限，同类 DO 可能共用一个 isolate。单区域常驻约 16 MB，解析 catalog 时临时再加约 30 MB；几个 Poller 恰好同时解析时可能接近上限，上线后在面板的内存指标里观察 |
| 存储 | 单个 EU 区域约 20 MB；首次基线写入约 3.7 万行/区域 |

### 未验证 / 已知差异

- **OVH 是否拦截 Cloudflare 出口 IP**：本地 dev 走本机网络，部署后用 `/api/probe` 确认。
- 打开 WebUI 期间 Hub 会因 SSE 连接保持活跃，按 DO 时长计费。
- 改密码后所有会话失效（与 Go 版相同）；旧版 bcrypt 哈希无法迁移，需要重新设置密码。
- 数据不与 Go 版互通，两种部署各自独立。

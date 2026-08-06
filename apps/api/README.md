# API v1.0.0

## 启动
1. 复制环境变量：`.env.example` -> `.env`
2. 初始化：`npm run prisma:generate` / `npm run prisma:migrate` / `npm run prisma:seed`
3. 开发启动：`npm run start:dev`
4. 生产启动：`npm run start`

## 主要模块
- `auth`: 登录、会话、密码修改
- `users` + `user-options`: 用户、角色、部门
- `skus` / `brands` / `sku-types` / `shops`: 产品主数据
- `shelves` / `boxes`: 仓位主数据
- `inventory`: 库存、FBA、看板、批量更新与CSV下载
- `batch-inbound` / `inbound`: 批量入库与入库流程
- `sku-edit-requests`: 编辑申请与确认
- `audit`: 操作日志
- `backups`: 数据备份与下载
- `amazon-sp-api`: 多店铺Amazon授权、FBM/FBA订单、FBA库存与看板快照自动同步

## 备份配置
- `BACKUP_ZIP_COMPRESSION_LEVEL`: ZIP 压缩等级，默认 `1`。如需尽量降低 CPU，可设为 `0`，仍会生成 ZIP 文件但不压缩。
- `BACKUP_SQL_ROW_BATCH_SIZE`: 数据库导出每批行数，默认 `200`。调小可降低单次查询和字符串处理峰值，调大会缩短备份耗时。

## 接口约定
- 前缀：`/api`
- 鉴权：JWT Bearer Token
- 返回：统一响应包装（`code/message/data/requestId/timestamp`）

## Amazon SP-API 自动同步

必须配置：

- `AMAZON_SP_API_LWA_CLIENT_ID` / `AMAZON_SP_API_LWA_CLIENT_SECRET`: 公开SP-API应用的LWA凭证。
- `AMAZON_SP_API_APPLICATION_ID`: Amazon公开应用ID，用于构造Seller Central OAuth同意地址。
- `AMAZON_SP_API_OAUTH_REDIRECT_URI`: HTTPS回调地址，必须与Amazon应用配置完全一致；生产地址为`https://wms.fulangke.cn/api/amazon-sp-api/oauth/callback`。
- `AMAZON_SP_API_OAUTH_RETURN_URL`: 授权完成后返回的WMS地址。
- `AMAZON_SP_API_OAUTH_DRAFT`: 未上架公开应用设为`true`；正式上架后改为`false`。
- `AMAZON_SP_API_SELLER_CENTRAL_URL`: 发起授权的Seller Central站点，日本站默认`https://sellercentral.amazon.co.jp`。
- `AMAZON_SP_API_ENCRYPTION_KEY`: 用于AES-256-GCM加密店铺Refresh Token，使用 `openssl rand -base64 32` 生成并持久保存。
- `AMAZON_SP_API_SYNC_CRON`: 默认 `0 0 11 * * *`，即每天11:00执行一次。
- `AMAZON_SP_API_SYNC_TIMEZONE`: Amazon同步任务时区，默认 `Asia/Shanghai`（中国时间）。
- `AMAZON_SP_API_INCLUDE_RECIPIENT`: 默认 `false`。取得FBM收件地址需要获批Direct-to-Consumer Shipping受限角色并完成PII安全控制后才能设为`true`。

管理员通过 `POST /api/amazon-sp-api/oauth/start` 获取Amazon官方授权地址。每个法律主体的Seller Central主用户分别确认授权；公开回调接口用一次性、10分钟有效且不可重放的state校验请求，再以授权码换取Refresh Token。Token使用AES-256-GCM加密落库，接口和浏览器均不会取得明文。公开应用授权记录365天后进入续期状态。同步采用Orders API `v2026-01-01`，`MERCHANT`写入现有亚马逊订单表，`AMAZON`写入FBA订单表；库存来自FBA Inventory API。

FBM订单采用“人工数据优先”规则：人工报告先导入、SP-API订单被人工编辑或已登记快递单号后，SP-API不再改写订单正文，只把Amazon最新状态保存到独立观察表并提示差异。用户删除的订单或明细会写入同步排除记录，管理员恢复排除记录后方可再次拉取。店铺看板合并人工报告与SP-API订单并按原始订单明细去重。

主要接口：

- `GET /api/amazon-sp-api/connections`
- `POST /api/amazon-sp-api/oauth/start`
- `GET /api/amazon-sp-api/oauth/callback`（Amazon公开回调，不使用WMS JWT，以一次性state验证）
- `PUT /api/amazon-sp-api/connections/:id`
- `POST /api/amazon-sp-api/connections/:id/test`
- `POST /api/amazon-sp-api/connections/:id/sync`
- `POST /api/amazon-sp-api/sync-all`（任意已登录用户立即同步所有已授权店铺，60秒冷却）
- `GET /api/amazon-sp-api/sync-runs`
- `GET /api/amazon-sp-api/coverage`
- `GET /api/amazon-sp-api/dashboard-snapshot/latest`
- `GET /api/orders/amazon/sync-exclusions`（管理员查看有效排除记录）
- `POST /api/orders/amazon/sync-exclusions/restore`（管理员恢复排除记录）

## 版本说明
- 正式版：`v1.0.0`（2026-02-25）
- 发布文档：`docs/RELEASE_v1.0.0.md`

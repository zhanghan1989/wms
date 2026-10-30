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
- `AMAZON_SP_API_SYNC_CRON`: 默认 `0 30 15 * * *`，即每天中国时间15:30（日本时间16:30）执行一次。
- `AMAZON_SP_API_SYNC_TIMEZONE`: Amazon同步任务时区，默认 `Asia/Shanghai`（中国时间）。
- `AMAZON_SP_API_INCLUDE_RECIPIENT`: 默认 `false`。取得FBM收件地址需要获批Direct-to-Consumer Shipping受限角色并完成PII安全控制后才能设为`true`。

管理员通过 `POST /api/amazon-sp-api/oauth/start` 获取Amazon官方授权地址。每个法律主体的Seller Central主用户分别确认授权；公开回调接口用一次性、10分钟有效且不可重放的state校验请求，再以授权码换取Refresh Token。Token使用AES-256-GCM加密落库，接口和浏览器均不会取得明文。公开应用授权记录365天后进入续期状态。同步采用Orders API `v2026-01-01`，`MERCHANT`写入独立的FBM API订单表，`AMAZON`写入独立的FBA API订单表，两者仅供“亚马逊店铺看板”使用，不会进入订单处理、库存总览需求统计、拣货、发货、导出或第三方推送；库存来自FBA Inventory API。

FBM订单采用数据库物理隔离规则：亚马逊店铺看板只读取 `amazon_fbm_order_items` 中的新SP-API数据；需要实际处理的订单仍由人工报告导入 `amazon_order_records`，并且不会出现在店铺看板中。旧订单表中已有的 `sourceKind=sp_api` 历史行保留但不再读取或更新。

“工厂备货建议”完全按Amazon侧数据计算，不读取WMS海外仓库存：建议数量 = 最近90天FBA与FBM销量合计 − FBA可售库存 − FBA入库中库存；仅展示90天销量合计超过10件且建议数量大于0的产品。

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
- 发布文档：`../../docs/archive/history/RELEASE_v1.0.0.md`


### 乐天工厂备货建议的材料口径

乐天看板汇总全部店铺近90天订单。肩带使用产品组成配置，按用量换算为肩带本体、肩带配件；共用材料按产品ID合并，材料直接销售的需求一并计入，库存只计一次。日均需求大于0.05件的材料参与建议计算，其他类型产品保持原产品口径。

每款肩带的实有成品库存先抵扣自己的待发货，再覆盖自己的未来销量；45天内有有效预计到仓日期的成品在途，从到仓日开始覆盖该款未来销量。成品不能拆零或跨款抵扣。剩余需求换算为材料，分别计算从今天起45天内的净需求和90天内的净目标需求。先以“材料库存−待发货占用＋45天内预计到仓在途”判断是否覆盖45天净需求；足够则建议0件，不足时才用90天净目标需求减去该备货判断库存，并向上取整。按日期推算的到货剩余仅用于缺货提醒，不再用于订货数量计算。页面和Excel显示类型、来源成品、成品抵扣需求；该抵扣量包含待发货及未来90天内由成品覆盖的材料需求，不是材料实物库存。

缺失或无效的肩带组成配置不回退为成品备货建议，须在页面及Excel的“待核实事项”中核对。在途未手动填写预计到仓日期时，按批量入库单登记时间（createdAt，日本日期）加45天推算，刷新或重新登录不重置该日期，手动日期优先。成品或材料在途逾期仍未入库时，标记“到货逾期、需核实”，相关建议订货量返回空值，页面及Excel显示核实提示而不自动生成重复订单数量。成品在途的日期无法确定或晚于新备货到仓日，也会提示核实。材料在途与成品在途分别处理，避免重复抵扣。


### 无箱号工厂在途预登记

批量入库页面可先导入仅含“产品ID、数量”的Excel/CSV，使用唯一采购批次号建立 `PRE-` 批次。提交前预览数量；更新必须选择原批次，保留登记日期（默认预计到仓仍为登记日＋45天），并校验预览后的并发修改。预登记数量只用于乐天工厂备货计算，不创建箱子、不增加实际库存，不要求国内物流单号。

装箱后在原批次上传包含箱号的完整装箱表，可逐次补齐部分箱号。文件必须保留已确认入库行，禁止修改已入库数量或使用其他批次/仓库占用的箱号。数量不得超过对应产品的预登记数量；有差异须先预览并更新原批次计划。每次只替换待入库明细，保留已入库明细及其ID。批次仍有未装箱数量时不能自动完成。

在途按“预登记数量−已确认明细的计划数量”计算，装箱明细不再额外累加；实际入库差异仍按原确认流程记录。可以取消剩余在途，保留已有库存与审计记录。上线前须运行 `20261020100000_batch_inbound_preregistration` 迁移；旧批次默认不属于预登记，保持原流程。

“未装箱转下一批”会按产品将预登记数量减去已导入装箱数量，转入自动新建的预登记单；原单保留已装箱明细。新单采用原单号加 `-NEXT-序号`，预计到仓日期需重新核对。

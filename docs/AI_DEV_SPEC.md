# AI 开发执行文档（WMS V1）

## 0. 文档元信息
- 项目代号：`wms-web-v1`
- 版本：`v1.0`
- 文档目标：让 AI 编码代理可直接按本文档拆分任务并实现系统
- 业务领域：网页版在库管理系统
- 当前日期：`2026-02-18`

## 1. 项目目标
构建一个适用于小团队（<=10 用户）、中等规模 SKU（<100,000）的仓储在库管理系统，支持入库、出库、抽盘、库存追踪与基础看板。

## 2. 角色与权限
### 2.1 角色
- `employee`（员工）
- `admin`（管理员）

### 2.2 权限
- `employee`：拥有全部业务功能权限（入库、出库、盘点、查询、看板、调整）
- `admin`：拥有全部业务功能权限，并可进行员工管理（新增员工、禁用员工、删除员工）

## 3. 业务范围（V1）
### 3.1 入库
- 批量待入库（Excel 导入：`箱号`、`SKU`、`数量`）
- 手工确认批量入库（仅整单确认）
- 标准入库单流程仅用于批量导入场景
- 手工入库/调整（页面直接操作；支持通过 `SKU/erpSKU/ASIN/FNSKU` 任意一项检索产品，并可新增/调整货架、箱号、产品后执行库存增减）
- 已确认入库单不可作废；差错通过库存调整单处理

### 3.2 出库
- 手工出库
- 出库时必须手动指定箱号

### 3.3 盘点
- 抽盘（按抽盘任务执行）

### 3.4 仓储结构
- 层级：`货架 -> 箱子 -> SKU`
- 一个箱子可包含多个 SKU
- 一个 SKU 可分布在多个箱子

### 3.5 扫码规则
- 只扫 `SKU 条码`
- 条码规则：`一物一码`（条码全局唯一）

### 3.6 看板指标
- 库存总量
- 当日入库量
- 当日出库量
- 滞销 SKU（规则：30 天无出库）
- 低库存预警（V1 预留，后续启用）

## 4. 非功能要求
- 并发：<= 10 活跃用户
- 数据规模：SKU < 100,000
- 部署：公司飞牛 NAS（Docker）
- 单位：固定 `件`
- 可审计：所有库存变化必须写库存流水
- 可追溯：所有数据库 `CREATE/UPDATE/DELETE` 操作必须保留历史记录（操作前后快照）

## 5. Excel 导入规范（批量待入库）
### 5.1 字段
- `箱号`
- `SKU`
- `数量`

### 5.2 校验规则
- 三字段均必填：`箱号`、`SKU`、`数量`
- `数量` 必须为正整数
- `箱号` 必须不存在于主数据（批量入库视为新箱入库）；若已存在则该文件导入失败
- `SKU` 可已存在；若不存在则自动创建一条 SKU 主数据（`sku`=导入值，其余字段为空或默认值）
- 同一文件中同一 `箱号+SKU` 可合并为一行（数量累加）
- 导入采用“全有或全无”：任一行失败则整文件失败，不生成入库单
- 导入成功时：一个文件生成一个 `pending_batch` 入库单

## 6. 数据模型（MySQL 8）
> 说明：以下为 AI 生成代码时的目标模型；字段可按实现微调，但语义不能变。

### 6.1 核心表
1. `users`
- `id` bigint pk
- `username` varchar(64) unique
- `password_hash` varchar(255)
- `role` enum('employee','admin')
- `status` tinyint
- `created_at` datetime
- `updated_at` datetime

2. `skus`
- `id` bigint pk
- `sku` varchar(128) unique
- `erp_sku` varchar(128)
- `asin` varchar(32)
- `fnsku` varchar(32)
- `model` varchar(255)
- `desc1` varchar(255)
- `desc2` varchar(255)
- `shop` varchar(128)
- `remark` varchar(255)
- `created_at` datetime
- `updated_at` datetime

3. `shelves`
- `id` bigint pk
- `shelf_code` varchar(64) unique
- `name` varchar(128)
- `status` tinyint
- `created_at` datetime
- `updated_at` datetime

4. `boxes`
- `id` bigint pk
- `box_code` varchar(128) unique
- `shelf_id` bigint fk -> shelves.id
- `status` tinyint
- `created_at` datetime
- `updated_at` datetime

5. `item_codes`
- `id` bigint pk
- `barcode` varchar(128) unique
- `sku_id` bigint fk -> skus.id
- `box_id` bigint fk -> boxes.id
- `status` enum('in_stock','outbound','frozen')
- `created_at` datetime
- `updated_at` datetime

6. `inventory_box_sku`
- `id` bigint pk
- `box_id` bigint fk -> boxes.id
- `sku_id` bigint fk -> skus.id
- `qty` int not null default 0
- unique key (`box_id`,`sku_id`)
- `updated_at` datetime

7. `inbound_orders`
- `id` bigint pk
- `order_no` varchar(64) unique
- `order_type` enum('pending_batch','manual_batch','manual_single')
- `status` enum('draft','confirmed','void')
- `remark` varchar(255)
- `created_by` bigint fk -> users.id
- `created_at` datetime
- `updated_at` datetime
- 说明：V1 仅使用 `pending_batch`

8. `inbound_order_items`
- `id` bigint pk
- `order_id` bigint fk -> inbound_orders.id
- `box_id` bigint fk -> boxes.id
- `sku_id` bigint fk -> skus.id
- `qty` int
- `source_row_no` int null
- `created_at` datetime

9. `outbound_orders`
- `id` bigint pk
- `order_no` varchar(64) unique
- `status` enum('draft','confirmed','void')
- `remark` varchar(255)
- `created_by` bigint fk -> users.id
- `created_at` datetime
- `updated_at` datetime

10. `outbound_order_items`
- `id` bigint pk
- `order_id` bigint fk -> outbound_orders.id
- `box_id` bigint fk -> boxes.id
- `sku_id` bigint fk -> skus.id
- `qty` int
- `created_at` datetime

11. `stocktake_tasks`
- `id` bigint pk
- `task_no` varchar(64) unique
- `scope_type` enum('sample')
- `status` enum('draft','in_progress','finished','void')
- `created_by` bigint fk -> users.id
- `created_at` datetime
- `updated_at` datetime

12. `stocktake_records`
- `id` bigint pk
- `task_id` bigint fk -> stocktake_tasks.id
- `box_id` bigint fk -> boxes.id
- `sku_id` bigint fk -> skus.id
- `system_qty` int
- `counted_qty` int
- `diff_qty` int
- `created_at` datetime

13. `stock_movements`
- `id` bigint pk
- `movement_type` enum('inbound','outbound','stocktake_gain','stocktake_loss','adjust')
- `ref_type` varchar(32)
- `ref_id` bigint
- `box_id` bigint
- `sku_id` bigint
- `qty_delta` int
- `operator_id` bigint
- `created_at` datetime

14. `inventory_adjust_orders`
- `id` bigint pk
- `adjust_no` varchar(64) unique
- `status` enum('draft','confirmed','void')
- `remark` varchar(255)
- `created_by` bigint fk -> users.id
- `created_at` datetime
- `updated_at` datetime

15. `inventory_adjust_order_items`
- `id` bigint pk
- `order_id` bigint fk -> inventory_adjust_orders.id
- `box_id` bigint fk -> boxes.id
- `sku_id` bigint fk -> skus.id
- `qty_delta` int
- `reason` varchar(128)
- `created_at` datetime

16. `operation_audit_logs`
- `id` bigint pk
- `entity_type` varchar(64)
- `entity_id` bigint
- `action` enum('create','update','delete')
- `event_type` enum(
  'box_created','box_field_updated','box_renamed','box_disabled','box_deleted','box_stock_increased','box_stock_outbound',
  'sku_created','sku_field_updated','sku_disabled','sku_deleted',
  'shelf_created','shelf_field_updated','shelf_disabled','shelf_deleted',
  'user_created','user_updated','user_disabled','user_deleted',
  'inbound_order_created','inbound_order_confirmed','inbound_order_voided',
  'outbound_order_created','outbound_order_confirmed','outbound_order_voided',
  'stocktake_task_created','stocktake_task_started','stocktake_task_finished','stocktake_task_voided',
  'inventory_adjust_created','inventory_adjust_confirmed','inventory_adjust_voided'
)
- `before_data` json
- `after_data` json
- `changed_fields` json null  # 字段级差异：[{field, before, after}]
- `operator_id` bigint fk -> users.id
- `request_id` varchar(64)
- `remark` varchar(255) null
- `created_at` datetime

### 6.2 索引建议
- `stock_movements (sku_id, created_at)`
- `stock_movements (box_id, created_at)`
- `inventory_box_sku (sku_id)`
- `item_codes (box_id, status)`
- `operation_audit_logs (entity_type, entity_id, created_at)`
- `operation_audit_logs (operator_id, created_at)`
- `operation_audit_logs (event_type, created_at)`

### 6.3 `event_type` 强约束清单
- 命名规则：统一 `entity_action` 小写下划线格式，禁止同义别名（如 `box_name_updated`）。
- 允许值白名单：仅允许第 6.1 节 `operation_audit_logs.event_type` 枚举中的值。
- 箱子相关：
- `box_created`、`box_field_updated`、`box_renamed`、`box_disabled`、`box_deleted`
- `box_stock_increased`（箱内 SKU 数量增加）
- `box_stock_outbound`（箱内 SKU 数量减少，含出库/负向调整）
- 产品相关：
- `sku_created`、`sku_field_updated`、`sku_disabled`、`sku_deleted`
- 其他主数据/单据：
- `shelf_*`、`user_*`、`inbound_order_*`、`outbound_order_*`、`stocktake_task_*`、`inventory_adjust_*`
- 事件映射强约束：
- 箱号变更只能使用 `box_renamed`，不得写 `box_field_updated`。
- 产品字段变更只能使用 `sku_field_updated`，且必须写 `changed_fields`。
- 库存数量变化：`qty_delta > 0` 记 `box_stock_increased`；`qty_delta < 0` 记 `box_stock_outbound`。
- 扩展流程：
- 新增 `event_type` 必须先更新本清单与数据库迁移，再允许业务代码使用。

### 6.4 后端常量规范（`AuditEventType`）
- 目标：所有审计事件在代码中只允许通过统一常量引用，禁止手写字符串。
- 常量类型名：`AuditEventType`
- 建议文件路径：`src/common/constants/audit-event-type.ts`
- 若前后端共享常量：`packages/shared/constants/audit-event-type.ts`
- 命名规范：常量键使用大写下划线（如 `BOX_CREATED`），常量值必须与 6.3 白名单完全一致（如 `box_created`）。
- 使用规则：写入 `operation_audit_logs.event_type` 时必须引用 `AuditEventType`，不得出现裸字符串。
- 变更流程：新增事件时，必须同时修改数据库枚举、`AuditEventType` 常量、6.3 清单与相关测试。

## 7. 关键业务规则
1. 任何入库/出库/盘点差异都必须同时更新：
- `inventory_box_sku`
- `stock_movements`
2. 出库必须指定箱号，禁止系统自动分配。
3. 出库数量不得超过该箱该 SKU 当前库存。
4. 单据 `confirmed` 后才能影响库存。
5. 单据 `void` 必须保证库存一致：未影响库存的草稿单可直接取消；已影响库存的单据需反向流水或等效保护。
6. 滞销 SKU 定义：最近 30 天无出库流水。
7. 库存数量真相源定义：
- `inventory_box_sku.qty` 为库存数量真相源（用于扣减与统计）。
- `item_codes` 为单件追踪明细（用于追溯与扫码）。
- 若启用 `item_codes`，确认入库/出库/盘点时必须与 `inventory_box_sku` 在同一事务内更新。
8. 幂等要求：
- 单据确认接口必须幂等；重复请求不可产生重复库存流水。
- 说明：同一单据多次点击“确认”，最终效果与确认一次完全一致（库存只变更一次、流水只记录一次）。
9. 入库导入与确认规则：
- 批量导入采用“全有或全无”，不允许部分成功。
- 入库确认仅支持整单确认，不支持按行部分确认。
- 已确认入库单不可作废；如需修正，必须走库存调整单。
10. 并发控制：
- 确认出库、盘亏扣减时，按 `box_id + sku_id` 执行行级锁（`SELECT ... FOR UPDATE`）。
- 库存不足返回 `409 CONFLICT`，且不产生任何库存变更。
11. 状态流转：
- 入库单：`draft -> confirmed|void`；`void` 仅允许草稿取消（未影响库存）。
- 入库单 `confirmed` 后禁止 `void`。
- 出库单：`draft -> confirmed|void`；`void` 视为终态。
- 盘点任务：`draft -> in_progress -> finished|void`；`void` 视为终态。
12. 作废策略：
- 入库单：仅 `draft` 可作废（取消），`confirmed` 不可作废。
- 出库单：已确认后作废时，必须写入一组反向 `stock_movements`，并回滚 `inventory_box_sku`。
- 反向流水需记录原始引用（`ref_type` + `ref_id`）以支持审计。
13. 流水约束：
- `stock_movements.qty_delta` 不得为 0。
- 入库/盘盈为正，出库/盘亏为负，调整按正负方向记录。
14. 统计口径：
- 涉及“当日”“30 天”的统计统一使用 `Asia/Shanghai` 时区与自然日边界。
15. 手工检索开箱调整规则：
- 支持通过 `sku`、`erp_sku`、`asin`、`fnsku` 任一字段检索产品。
- 检索命中多条时，必须由用户显式选择目标 SKU，不允许隐式命中。
- 手工入库页面允许新增/调整货架、箱号、产品主数据。
- 页面上的库存增减操作统一落为 `inventory_adjust_orders`（可自动创建并确认），`qty_delta` 可正可负。
- 正向调整可创建新的 `box_id + sku_id` 库存关系；负向调整要求该关系已存在且库存充足。
- 负向调整不得使箱内该 SKU 库存小于 0，违反时返回 `409 CONFLICT`。
16. 操作历史留痕规则：
- 所有业务表的 `CREATE/UPDATE/DELETE` 必须写入 `operation_audit_logs`。
- 日志写入与业务写入必须同事务提交，防止“数据已变更但无日志”。
- `before_data/after_data` 至少包含本次变更字段；`delete` 必须保留完整 `before_data`。
- 查询层必须支持“汇总查询”和“按实体查询”（至少支持按 `box`、`sku` 查询）。
17. 箱子维度必记事件：
- 谁在什么时候创建箱子（`box_created`）。
- 谁在什么时候往该箱子增加了什么产品及数量（`box_stock_increased`）。
- 谁在什么时候从该箱子对哪个产品执行出库及数量（`box_stock_outbound`）。
- 谁在什么时候修改了箱号（`box_renamed`，需记录旧箱号与新箱号）。
- 谁在什么时候废除/禁用了箱子（`box_disabled` 或 `box_deleted`）。
18. 产品维度必记事件：
- 谁在什么时候创建了产品（`sku_created`）。
- 谁在什么时候修改了产品字段（`sku_field_updated`）。
- 字段修改必须保留字段级差异（`changed_fields`：字段名、旧值、新值）。
- 谁在什么时候禁用/删除了产品（`sku_disabled` 或 `sku_deleted`）。

## 8. API 合同（REST）
### 8.0 通用约定
- 统一返回结构：`{ code, message, data, requestId, timestamp }`
- 列表接口统一支持：`page`、`pageSize`、`sortBy`、`sortOrder`
- 统一错误码建议：
- `400` 参数校验失败
- `401` 未登录或凭证失效
- `403` 无权限
- `404` 资源不存在
- `409` 库存冲突/并发冲突
- `422` 业务规则不满足（如非法状态流转）
- 对高风险写接口启用幂等键：`X-Idempotency-Key`
- 适用接口：导入、确认、作废/取消、手工一键增减
- 幂等键有效期建议：24 小时

### 8.1 认证
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### 8.2 基础资料
- `GET /api/skus`（支持按 `sku`、`erpSKU`、`ASIN`、`FNSKU` 任一字段检索）
- `POST /api/skus`
- `PUT /api/skus/:id`
- `GET /api/shelves`
- `POST /api/shelves`
- `GET /api/boxes`
- `POST /api/boxes`
- `GET /api/users`（管理员：员工列表）
- `POST /api/users`（管理员：新增员工）
- `PUT /api/users/:id`（管理员：修改员工信息/启禁用）
- `DELETE /api/users/:id`（管理员：删除员工）
- 说明：手工入库页面可直接调用以上主数据接口完成货架/箱号/产品的新增与调整

### 8.3 入库
- `POST /api/inbound/import-excel`（上传并解析）
- `POST /api/inbound/orders`（仅批量导入场景创建，不提供手工建单）
- `POST /api/inbound/orders/:id/confirm`
- `POST /api/inbound/orders/:id/void`（仅 `draft` 允许，语义为取消草稿）
- `POST /api/inventory/adjust-orders`
- `POST /api/inventory/adjust-orders/:id/confirm`
- `POST /api/inventory/manual-adjust`（手工页面一键增减；后台自动落调整单与流水）

### 8.4 出库
- `POST /api/outbound/orders`
- `POST /api/outbound/orders/:id/confirm`
- `POST /api/outbound/orders/:id/void`

### 8.5 盘点
- `POST /api/stocktake/tasks`
- `POST /api/stocktake/tasks/:id/start`
- `POST /api/stocktake/tasks/:id/records`
- `POST /api/stocktake/tasks/:id/finish`

### 8.6 查询与看板
- `GET /api/inventory/search`
- `GET /api/inventory/product-boxes`（按产品查询所在箱号与当前库存）
- `GET /api/dashboard/summary`
- `GET /api/dashboard/stagnant-skus`

### 8.7 操作历史
- `GET /api/audit-logs`（汇总查询：按实体类型、操作人、时间区间、动作筛选）
- `GET /api/boxes/:id/audit-logs`（箱子维度历史）
- `GET /api/skus/:id/audit-logs`（产品维度历史）
- 建议查询参数：`entityType`、`entityId`、`eventType`、`operatorId`、`dateFrom`、`dateTo`、`page`、`pageSize`
- 返回字段至少包含：`entityType`、`entityId`、`eventType`、`operator`、`createdAt`、`beforeData`、`afterData`、`changedFields`
- `eventType` 入参若不在第 6.3 节白名单内，返回 `400`

## 9. 前端页面（Vue 3）
- `/login`
- `/dashboard`
- `/admin/users`
- `/master/skus`
- `/master/shelves`
- `/master/boxes`
- `/audit/logs`（操作历史汇总）
- `/inbound/pending-import`
- `/inbound/orders`
- `/outbound/orders`
- `/stocktake/tasks`
- `/inventory/query`
- 说明：在箱子详情页与产品详情页展示该实体的历史记录时间线（操作者、时间、事件类型、变更前后值、字段级差异）

## 10. 技术方案
### 10.1 栈
- 前端：`Vue 3 + Vite + TypeScript + Pinia + Vue Router`
- 后端：`Node.js 20 + NestJS(推荐) + TypeScript + Prisma/TypeORM`
- 数据库：`MySQL 8`
- 缓存（可选）：`Redis`

### 10.2 部署（飞牛 NAS）
- 采用 `docker compose`。
- 服务：
- `web`（Nginx 托管 Vue 构建产物）
- `api`（Node.js）
- `db`（MySQL）
- `redis`（可选）
- 挂载持久化卷：`mysql_data`、`app_uploads`、`logs`

## 11. AI 执行任务拆解（可直接分配给代理）
### 11.1 任务清单
1. `TASK-001` 初始化 Monorepo 与工程规范（lint/test/commitlint）。
2. `TASK-002` 完成认证与 RBAC 中间件。
3. `TASK-003` 完成 SKU/货架/箱子 CRUD。
4. `TASK-004` 完成 Excel 导入解析与校验。
5. `TASK-005` 完成入库单流程（创建/确认/草稿取消，已确认不可作废）与库存调整单流程。
6. `TASK-006` 完成出库单流程（手动选箱、库存校验、确认）。
7. `TASK-007` 完成抽盘流程（创建任务、录入、差异）。
8. `TASK-008` 完成库存查询、流水查询与操作历史查询（汇总+实体维度）。
9. `TASK-009` 完成看板接口与前端可视化。
10. `TASK-010` 完成 Docker 化与 NAS 部署文档。

### 11.2 每个任务统一完成标准（DoD）
- 提供后端接口 + 前端页面/组件。
- 提供单元测试（核心逻辑）与最小集成测试（主流程）。
- 提供迁移脚本与回滚说明。
- 更新 `CHANGELOG`。

## 12. 测试用例基线
- 入库成功：库存增加，流水新增。
- 入库重复确认：幂等成功，不重复增加库存与流水。
- 入库已确认作废：返回 `422`，不改库存。
- Excel 导入箱号重复：若箱号已存在于系统，整文件失败。
- Excel 导入自动建 SKU：当 `SKU` 不存在时自动建档并继续入库。
- 手工检索：通过 `SKU/erpSKU/ASIN/FNSKU` 任一字段可检索到目标产品。
- 调整单确认：按 `qty_delta` 正负变更库存并写 `adjust` 流水。
- 手工正向调整：允许新增 `box_id + sku_id` 库存关系并增加库存。
- 手工负向调整失败：扣减后若库存将小于 0，返回 `409` 且不改库存。
- 出库成功：指定箱库存扣减，流水新增。
- 出库失败：库存不足返回 4xx，不改库存。
- 抽盘差异：生成盘盈/盘亏流水。
- Excel 导入：任一行失败则整文件失败（全有或全无）。
- 权限控制：非管理员访问员工管理接口返回 `403`。
- 任意主数据增改删：必须生成一条 `operation_audit_logs`，记录操作人和前后快照。
- 审计一致性：业务事务回滚时，不得留下孤立的操作历史记录。
- 历史查询：箱子页与产品页可分别查询到对应实体的变更历史。
- 箱子历史：创建箱子、箱内加货、箱内出库、改箱号、废除箱子均有对应事件记录。
- 产品历史：修改任意产品字段后，可看到字段名与旧值/新值。
- 审计事件命名：`event_type` 必须命中 6.3 白名单；非法值请求返回 `400`。

## 13. 风险与后续
- 风险：`一物一码` 数据量增大后，`item_codes` 体量增长快，需要索引与归档策略。
- 风险：Excel 数据质量不稳定，需前置模板校验与错误提示。
- 风险：全量操作历史日志增长快，需分区/归档与冷热数据策略。
- 后续：低库存预警策略（固定阈值 vs 动态阈值）在 V1.1 增加。

## 14. 给 AI 代理的执行指令（Prompt 模板）
```text
你是本项目的实现代理。请严格依据 docs/AI_DEV_SPEC.md 实现 TASK-00X。
约束：
1) 不改变业务规则与数据语义。
2) 先写迁移与实体，再写 service/controller，再写测试。
3) 提交前运行 lint + test。
4) 输出变更文件清单与接口示例。
```

## 15. 功能逐项分析与优化（用于评审与实现对齐）
> 目标：每个功能都给出“输入-处理-输出-异常-验收”闭环，减少开发返工。

### 15.1 认证与 RBAC
- 功能目标：保证仅授权用户访问对应功能。
- 输入：
- 用户名、密码；已登录态访问令牌。
- 处理：
- 登录成功后返回会话信息；后续请求按角色校验接口权限。
- 输出：
- 当前用户信息（含角色）可通过 `GET /api/auth/me` 获取。
- 异常：
- 登录失败 `401`；角色不满足 `403`。
- 验收：
- `employee` 与 `admin` 均可访问全部业务功能；仅 `admin` 可访问员工管理能力。

### 15.2 SKU/货架/箱子主数据管理
- 功能目标：维护可被业务单据引用的基础档案。
- 输入：
- 新增/修改 SKU、货架、箱子信息。
- 处理：
- 唯一性校验（`sku`、`shelf_code`、`box_code`）；状态控制禁用档案。
- 任意新增/修改/删除均写入 `operation_audit_logs`。
- 输出：
- 可分页查询，支持按关键字段搜索。
- 异常：
- 重复编码 `409`；引用中且尝试删除返回 `422`（建议软删除）。
- 验收：
- 单据选择器只能选择“启用”状态主数据。

### 15.3 批量待入库（Excel 导入）
- 功能目标：快速导入待入库明细，确保整批一致性。
- 输入：
- Excel 文件（仅 `箱号`、`SKU`、`数量` 三列），字段遵循第 5 节。
- 处理：
- 行级校验（`箱号` 必须为新箱；`SKU` 不存在时自动建档）、同文件 `箱号+SKU` 合并；通过校验后生成 1 张 `pending_batch` 入库单。
- 输出：
- 导入成功返回入库单信息；导入失败返回错误明细。
- 异常：
- 文件格式错误 `400`；关键字段缺失 `422`；箱号已存在 `422`；并发重复导入以幂等键抑制。
- 验收：
- 任一失败行导致整文件失败（全有或全无）。

### 15.4 入库单（创建/确认/草稿取消）
- 功能目标：把批量待入库转为可审计库存增加（标准入库单仅用于批量导入）。
- 输入：
- 入库单头、明细（箱号、SKU、数量）。
- 处理：
- `draft` 创建；`confirmed` 后写库存与流水；`void` 仅用于取消 `draft`。
- 输出：
- 返回单据状态与影响行数。
- 异常：
- 非法状态流转 `422`；重复确认幂等返回当前状态；已确认后作废返回 `422`。
- 验收：
- 每条确认明细都可在 `stock_movements` 追溯到来源单据。

### 15.5 出库单（手动选箱）
- 功能目标：按指定箱位精准扣减库存。
- 输入：
- 出库单头、明细（必填箱号、SKU、数量）。
- 处理：
- 确认时事务内锁定库存行，校验余额后扣减并写流水。
- 输出：
- 确认成功后返回扣减结果与最新库存快照（可选）。
- 异常：
- 库存不足 `409`；箱号与 SKU 不匹配 `422`。
- 验收：
- 系统不允许自动分配箱号；并发下不出现负库存。

### 15.6 抽盘任务
- 功能目标：通过抽盘发现并纠正库存差异。
- 输入：
- 抽盘范围、记录明细（箱号、SKU、实盘数）。
- 处理：
- 任务启动后录入实盘；结束时生成差异并写盘盈盘亏流水。
- 输出：
- 任务结果：差异条数、盘盈总量、盘亏总量。
- 异常：
- 非 `in_progress` 不允许录入或结束（`422`）。
- 验收：
- 盘点结束后，系统库存与实盘结果一致。

### 15.7 库存查询与流水查询
- 功能目标：支持按箱号/SKU 快速定位库存与变更历史。
- 输入：
- 查询条件：SKU、箱号、货架、时间区间、单据号。
- 处理：
- 联合查询 `inventory_box_sku` 与 `stock_movements`，支持分页与排序。
- 支持按 `box_id`、`sku_id` 查询 `operation_audit_logs`。
- 输出：
- 当前库存视图 + 流水明细。
- 异常：
- 时间范围非法 `400`。
- 验收：
- 任一库存结果都能追溯到对应流水来源。

### 15.8 看板（Dashboard）
- 功能目标：提供管理层日常运营概览。
- 输入：
- 统计日期（默认当日）与筛选维度（可选）。
- 处理：
- 统计库存总量、当日入库、当日出库、滞销 SKU。
- 输出：
- 汇总指标与滞销列表。
- 异常：
- 无数据返回空集合而非报错。
- 验收：
- 与查询模块在同一时间点下口径一致。

### 15.9 审计与追溯
- 功能目标：任何数据库增改删与库存变化都可定位到操作人、对象与前后差异。
- 输入：
- 业务操作触发数据库写入（含主数据与单据数据）。
- 处理：
- 库存变化落库 `stock_movements`（含类型、引用、操作人、时间）。
- `CREATE/UPDATE/DELETE` 落库 `operation_audit_logs`（含 `before_data/after_data`、操作人、时间）。
- 箱子事件至少覆盖：`box_created`、`box_stock_increased`、`box_stock_outbound`、`box_renamed`、`box_disabled|box_deleted`。
- 产品事件至少覆盖：`sku_created`、`sku_field_updated`、`sku_disabled|sku_deleted`。
- 所有事件命名必须命中第 6.3 节白名单，不允许临时字符串。
- 输出：
- 审计查询可按操作人、时间、实体类型、实体 ID、动作过滤。
- 产品字段变更可展示字段级差异（字段名、旧值、新值）。
- 异常：
- 任一审计写入失败则主事务回滚。
- 验收：
- 抽检任意 10 笔增改删操作，均可在汇总页与实体页追溯到完整历史。

### 15.10 部署与运维（NAS）
- 功能目标：可持续运行、可恢复、可排障。
- 输入：
- Docker Compose 配置、环境变量、持久化卷。
- 处理：
- 启动 `web/api/db(/redis)`；启用日志轮转和数据库备份。
- 输出：
- 部署文档、恢复演练说明、健康检查命令。
- 异常：
- 服务启动失败时可通过统一日志路径快速定位。
- 验收：
- 冷启动成功；数据库可按备份恢复到指定时间点（RPO/RTO 待定）。

### 15.11 库存调整单（手工开箱增减/入库差错修正）
- 功能目标：修正已确认入库造成的库存差异，并支持手工检索开箱后的库存增减。
- 输入：
- 检索键（`SKU/erpSKU/ASIN/FNSKU` 任一项）与调整单明细（箱号、SKU、`qty_delta`、原因）。
- 处理：
- 页面可先新增/调整货架、箱号、产品主数据，再执行库存增减；增减操作由系统自动创建并确认调整单，按 `qty_delta` 更新库存并写 `adjust` 流水。
- 输出：
- 返回单据状态、总调整量与明细结果。
- 异常：
- 检索无结果返回 `404`；负向调整库存不足返回 `409`；重复确认幂等返回当前状态。
- 验收：
- 任一调整明细都能在 `stock_movements` 中通过 `movement_type=adjust` 追溯。

## 16. 待确认清单（评审后固化为强规则）
1. `item_codes` 在 V1 是否全量启用：全量启用 or 仅预留结构不落地明细？
2. 会话方案：JWT（短期）+ 刷新令牌，还是服务端 Session？

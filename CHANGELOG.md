# Changelog

## v1.0.1 - 2026-02-26

### Added
- FBA outbound list export to Excel (`/api/inventory/fba-replenishments/outbound-excel`) with product extended fields.
- FBA panel download button placed next to outbound button.

### Changed
- Product search and homepage load path optimizations.
- Shelf/box code management switched to numeric style without `S-`/`B-` prefixes.
- Batch update inventory flow improved for missing box handling.

### Fixed
- FBA list display consistency (brand column and outbound express number rendering).
- Multiple UI and label-print layout adjustments for production use.

## v1.0.0 - 2026-02-25

### Added
- 系统看板页面与指标：
  - 库存健康（总库存、可用库存、锁定库存、在途库存、覆盖天数等）
  - 出库需求趋势（7/14/30天、Top SKU、异常波动）
  - 工厂备货建议、废弃产品建议、废弃箱子建议
- 数据备份能力：
  - 每周日 23:59 自动备份
  - 手动“立即备份”
  - 备份记录列表与ZIP下载
  - 仅保留最近 5 个 ZIP 文件可下载
- 海外仓管理增强：
  - 箱号管理、货架管理弹窗（新增/变更/删除）
  - 删除前检查与提示（箱号、货架）
  - 移动产品到新箱子支持 SKU 手动输入
- 产品与库存增强：
  - 产品检索与分页/滚动加载优化
  - rbSKU+库存下载
  - 批量更新库存入口与模板支持
  - 批量上传产品、批量入库模板下载能力
- 编辑申请流程增强：
  - rbSKU 变更规则
  - 批量确认能力
  - 详情确认按钮权限提示
- 日志展示优化：
  - 请求ID/动作列按需求隐藏
  - 事件与实体展示优化（中文化、业务名称化）

### Changed
- 统一备份与导出时间为 `Asia/Shanghai`
- 优化多个页面按钮位置、文案和弹窗布局
- 优化箱号与货架编码长度规则（箱号 3 位、货架 2 位）

### Fixed
- 备份 ZIP 存储持久化与保留策略逻辑修复
- 模板文件路径与命名不一致导致的下载失败修复
- 删除箱号/货架时的约束报错处理优化
- 多项中文/日文展示与编码问题修复

## 2026-02-18

### Added
- Initialized monorepo workspace (`apps/api`, `apps/web`, `packages/shared`).
- Implemented first runnable NestJS backend baseline with Prisma/MySQL.
- Added Prisma schema for WMS V1 core tables and strict audit `event_type` enum.
- Implemented auth (`login/logout/me`) with JWT.
- Implemented RBAC base (`employee`, `admin`) and admin-only user management APIs.
- Implemented master data APIs: `skus`, `shelves`, `boxes`.
- Implemented operation audit logging and query APIs:
  - `GET /api/audit-logs`
  - `GET /api/boxes/:id/audit-logs`
  - `GET /api/skus/:id/audit-logs`
- Added Docker deployment baseline (`docker-compose.yml`, `apps/api/Dockerfile`).
- Added Alibaba Cloud deployment assets:
  - `docker-compose.aliyun.yml` (API-only deployment)
  - `apps/api/.env.aliyun.example`
  - `docs/DEPLOY_ALIYUN.md`
- Added project documentation (`README.md`, `apps/api/README.md`) and seed script for default users.

### Changed
- Mounted static frontend assets under API root path (`/`).
- Added first web console pages for:
  - login/session overview
  - users
  - skus
  - shelves
  - boxes
  - audit logs
- Extended web console with:
  - inbound excel import and order confirmation
  - manual inventory adjust workflow
  - split manual adjust into `manual inbound` and `manual outbound` pages
  - show matched SKU locations (`box_code` + `shelf_code`) in manual inbound/outbound search results
  - hide visible `ID` fields from frontend pages and lists

### Added
- Inbound module APIs:
  - `POST /api/inbound/import-excel`
  - `GET /api/inbound/orders`
  - `POST /api/inbound/orders`
  - `POST /api/inbound/orders/:id/confirm`
  - `POST /api/inbound/orders/:id/void`
- Inventory adjust APIs:
  - `GET /api/inventory/search`
  - `GET /api/inventory/product-boxes`
  - `POST /api/inventory/adjust-orders`
  - `POST /api/inventory/adjust-orders/:id/confirm`
  - `POST /api/inventory/manual-adjust`
- Excel parsing dependency `xlsx` for batch inbound import.

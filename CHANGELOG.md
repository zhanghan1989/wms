# Changelog

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

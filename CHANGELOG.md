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

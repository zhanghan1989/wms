# WMS V1 First Build

This repository now contains the first runnable backend baseline for WMS V1.

## Structure

- `apps/api`: NestJS + Prisma backend
- `apps/web`: placeholder package for future Vue frontend
- `docs/AI_DEV_SPEC.md`: source product specification

## Quick Start

1. Copy env file:
   - `copy apps\\api\\.env.example apps\\api\\.env`
2. Start database stack:
   - `docker compose up -d db redis`
3. Generate Prisma client and run migrations:
   - `npm run -w api prisma:generate`
   - `npm run -w api prisma:migrate`
4. Seed default users:
   - `npm run -w api prisma:seed`
5. Start API:
   - `npm run start:api`

## Default Accounts

- admin / Admin@123
- employee / Employee@123

## Frontend Preview

- A lightweight web console is served by the API process.
- After startup, open `http://<server-ip>:3000/`.
- Login with `admin / Admin@123` to view:
  - users
  - skus
  - shelves
  - boxes
  - audit logs

## Implemented in First Build

- Auth: login/logout/me (JWT)
- RBAC base: employee/admin and admin-only user management APIs
- Master data APIs: skus, shelves, boxes
- Inbound workflow:
  - excel import (`boxCode`, `sku`, `qty`)
  - one file creates one `pending_batch` inbound order (draft)
  - whole-order confirm with idempotent behavior
  - draft void supported, confirmed order cannot be voided
- Inventory adjust workflow:
  - create/confirm adjust order
  - manual one-click adjust (`qtyDelta` positive/negative)
  - product search by `sku`/`erpSku`/`asin`/`fnsku`
- Audit system:
  - operation audit logs (`operation_audit_logs`)
  - summary query and entity-level query APIs
  - event type strict constants + schema enum
- Prisma schema covering WMS V1 core tables

## Verification Commands

- `npm run -w api build`
- `npm run -w api lint`
- `npm run -w api test`

## Deployment

- Local/standalone: `docker-compose.yml`
- Alibaba Cloud (ECS + RDS): `docker-compose.aliyun.yml` and `docs/DEPLOY_ALIYUN.md`

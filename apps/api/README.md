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

## 备份配置
- `BACKUP_ZIP_COMPRESSION_LEVEL`: ZIP 压缩等级，默认 `1`。如需尽量降低 CPU，可设为 `0`，仍会生成 ZIP 文件但不压缩。
- `BACKUP_SQL_ROW_BATCH_SIZE`: 数据库导出每批行数，默认 `200`。调小可降低单次查询和字符串处理峰值，调大会缩短备份耗时。

## 接口约定
- 前缀：`/api`
- 鉴权：JWT Bearer Token
- 返回：统一响应包装（`code/message/data/requestId/timestamp`）

## 版本说明
- 正式版：`v1.0.0`（2026-02-25）
- 发布文档：`docs/RELEASE_v1.0.0.md`

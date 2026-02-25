# WMS v1.0.0

WMS 项目第一个正式版（`v1.0.0`）代码仓库。

## 仓库结构
- `apps/api`: NestJS + Prisma + MySQL，包含 API 与前端静态页面
- `apps/web`: 预留目录
- `docs`: 部署、交接、模板与发布文档

## 正式版范围（v1.0.0）
- 用户与权限：登录、用户管理、角色/部门配置
- 海外仓管理：箱号管理、货架管理、移动箱子/移动产品
- 产品管理：单个新增、批量上传、编辑申请与确认
- 库存与 FBA：库存调整、FBA 补货申请/确认/出库
- 批量入库：采集箱号、上传校验、明细确认
- 系统看板：库存健康、需求趋势、备货建议、废弃建议
- 日志与备份：操作日志、我的日志、数据库备份与下载

## 快速启动
1. 复制环境变量文件  
`copy apps\\api\\.env.example apps\\api\\.env`
2. 启动依赖  
`docker compose up -d db redis`
3. 初始化数据库  
`npm run -w api prisma:generate`  
`npm run -w api prisma:migrate`  
`npm run -w api prisma:seed`
4. 启动服务  
`npm run start:api`
5. 访问系统  
`http://<server-ip>:3000/`

## 默认账号（仅用于初始化）
- `admin / Admin@123`
- `employee / Employee@123`

首次部署后请立即修改默认密码和密钥。

## 文档索引
- 文档总览：`docs/README.md`
- 发布说明：`docs/RELEASE_v1.0.0.md`
- GitHub Release 文案：`docs/GITHUB_RELEASE_v1.0.0.md`
- 部署文档：`docs/DEPLOY_ALIYUN.md`
- 交接记录：`docs/DEV_HANDOVER_2026-02-18.md`, `docs/DEV_HANDOVER_2026-02-19.md`
- 变更记录：`CHANGELOG.md`

## 校验命令
- `npm run -w api build`
- `npm run -w api lint`
- `npm run -w api test`

## CI/CD
- Workflow: `.github/workflows/deploy-ecs.yml`
- 触发方式：push `main` 或手动 `workflow_dispatch`

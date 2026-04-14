# 本地开发说明

## 推荐流程

1. 先运行 `npm run branch:sync-develop`
2. 在 `develop` 分支运行 `npm run work:start`
3. 开发并本地验证
4. 提交代码
5. 运行 `npm run push:branch`
6. 需要正式发布时，在 `develop` 分支运行 `npm run release:main`

## 分支约定

- `develop`：日常开发分支
- `main`：正式发布分支，push 后会触发 GitHub Actions 部署
- 如果 `main` 有热修复或其他更新，先运行 `npm run branch:sync-develop` 再继续开发

## 常用命令

- 同步最新 `main` 到 `develop`：`npm run branch:sync-develop`
- 开工作业：`npm run work:start`
- 结束作业：`npm run work:stop`
- 推送当前开发分支：`npm run push:branch`
- 从 `develop` 发布到 `main`：`npm run release:main`
- 直接推送 `main` 并触发部署：`npm run deploy:main`

## 当前本地环境

- Node：通过 `~/.zshrc` 加入本地路径
- MySQL：本地用户目录安装，监听 `127.0.0.1:3306`
- 数据库：`wms_v1`
- 默认开发账号：`root / root`
- 默认登录账号：`admin / Admin@123`

## 脚本行为

### `npm run work:start`

- 阻止在 `main` 分支直接开工
- 检查 `apps/api/.env`
- 检查依赖是否已安装
- 优先调用 `mysql-wms-start`
- 检查 `3000` 端口没有现成服务占用
- 以前台方式启动 `ts-node-dev`
- 代码变更后会自动热重载

启动成功后，可访问：

- `http://127.0.0.1:3000/`

### `npm run work:stop`

- 用于在你结束本次作业后做收尾
- API 由 `work:start` 所在终端通过 `Ctrl+C` 停止
- 默认保留 MySQL 继续运行
- 输出当前 `git status`

如果你也想顺手停掉数据库：

- `bash scripts/wms-work-stop.sh --stop-db`

## 发布脚本

### `npm run branch:sync-develop`

- 要求工作区干净
- 自动 `fetch origin`
- 自动切到 `develop`
- 先快进到最新 `origin/develop`
- 再把最新 `origin/main` merge 到 `develop`
- 适合每天开工前先执行一次

### `npm run push:branch`

- 禁止在 `main` 上使用
- 要求工作区干净
- 默认执行 `npm run prisma:generate:api`
- 然后执行 `lint`、`build`、`test`
- 通过后推送当前分支

如果只是临时快速推送，可加：

- `bash scripts/wms-push.sh --skip-checks`

### `npm run release:main`

- 只允许在 `develop` 上执行
- 要求工作区干净
- 要求本地 `develop` 与远程 `origin/develop` 同步
- 要求当前 `develop` 已包含最新 `origin/main`
- 默认执行 `npm run prisma:generate:api`
- 然后执行 `lint`、`build`、`test`
- 二次确认后将 `main` 快进到当前 `develop`
- 自动 `git push origin main`
- 该动作会触发 GitHub Actions 部署

快速确认模式：

- `bash scripts/wms-release-main.sh --yes`

### `npm run deploy:main`

- 只允许在 `main` 上执行
- 要求工作区干净
- 默认执行 `npm run prisma:generate:api`
- 然后执行 `lint`、`build`、`test`
- 二次确认后执行 `git push origin main`
- 该动作会触发 GitHub Actions 部署

快速确认模式：

- `bash scripts/wms-deploy-main.sh --yes`

这个命令更适合紧急情况下你已经明确在 `main` 上处理热修复时使用。

## 数据库说明

当前仓库的迁移链在空库上不能直接稳定执行 `prisma migrate dev`。

本地首启数据库时，更稳的方式是：

1. 建空库 `wms_v1`
2. 使用 `prisma db push` 同步 `schema.prisma`
3. 再执行 seed

如果只是日常开发，不需要每次重新初始化数据库。

## 手动数据库命令

- 启动 MySQL：`mysql-wms-start`
- 停止 MySQL：`mysql-wms-stop`
- 查看状态：`mysql-wms-status`

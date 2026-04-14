# 本地开发说明

## 推荐流程

1. 确认当前分支不是 `main`
2. 运行 `npm run work:start`
3. 开发并本地验证
4. 提交代码
5. 运行 `npm run push:branch`
6. 需要正式部署时，再切到 `main` 并运行 `npm run deploy:main`

## 常用命令

- 开工作业：`npm run work:start`
- 结束作业：`npm run work:stop`
- 推送当前开发分支：`npm run push:branch`
- 推送 `main` 并触发部署：`npm run deploy:main`

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

### `npm run push:branch`

- 禁止在 `main` 上使用
- 要求工作区干净
- 默认执行 `lint`、`build`、`test`
- 通过后推送当前分支

如果只是临时快速推送，可加：

- `bash scripts/wms-push.sh --skip-checks`

### `npm run deploy:main`

- 只允许在 `main` 上执行
- 要求工作区干净
- 默认执行 `lint`、`build`、`test`
- 二次确认后执行 `git push origin main`
- 该动作会触发 GitHub Actions 部署

快速确认模式：

- `bash scripts/wms-deploy-main.sh --yes`

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

# 阿里云部署说明

## 当前生产部署

当前生产使用根目录 `docker-compose.yml`：API 与 MySQL 独立容器运行，API 仅绑定 `127.0.0.1:3000`，由 Nginx 提供 HTTPS。管理页面位于 `apps/api/public`，已随 API 发布。Redis 默认不启动。

自动部署由 `.github/workflows/deploy-ecs.yml` 执行：推送 `main` 或手动触发，校验通过后在 GitHub Actions 构建镜像，传到 `production` 环境的 `ECS_HOST`，在服务器 `~/wms` 部署指定提交并默认执行 `prisma migrate deploy`。服务器根目录 `.env` 提供 Compose 配置，参考根目录 `.env.example`。

当前流程还发布公司官网，并配置乐天日本出口服务，因此新系统不能直接照搬当前部署任务。新服务器应使用独立数据库、密钥、域名、备份和 GitHub Environment；首次启用前核对店铺授权及自动同步设置。现有 Actions 不会因新服务器克隆仓库而自动部署到新服务器。

## 早期 RDS 部署方案（历史参考）

以下保留使用 `docker-compose.aliyun.yml` 和外部 RDS 的早期方案，区别于当前生产流程。该配置暂时保留供核对人工部署用途；不要将其作为当前生产配置直接执行。生产迁移应使用 `prisma migrate deploy`，种子初始化仅用于空白数据库。


## 1. 推荐架构

- 计算：`ECS`（仅跑 API 容器）
- 数据库：`RDS MySQL 8.x`
- 缓存（可选）：`阿里云 Redis`
- 域名与证书：`域名 + SSL 证书（可选）`

说明：以下为早期方案记录。

## 2. 阿里云资源准备

1. 创建 `ECS`（Ubuntu 22.04，2c4g 起步）。
2. 创建 `RDS MySQL` 实例（建议与 ECS 同 VPC 同可用区）。
3. 在 RDS 创建数据库：`wms_v1`。
4. 在 RDS 创建账号：如 `wms_user`，授予 `wms_v1` 权限。
5. 在安全组开放 ECS 入站端口：
- `22`（SSH）
- `3000`（仅测试阶段临时开放）
- 若走 Nginx：开放 `80/443`，并关闭 `3000` 公网访问

## 3. ECS 初始化

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg

# Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

重新登录一次 SSH，让 docker 组权限生效。

## 4. 上传项目

方式任选：
- `git clone` 仓库到 ECS
- 或本地打包上传（SCP/OSS）

假设目录为：`~/wms-v1`

```bash
cd ~/wms-v1
```

## 5. 配置阿里云环境变量

1. 复制模板：

```bash
cp apps/api/.env.aliyun.example apps/api/.env.aliyun
```

2. 编辑 `apps/api/.env.aliyun`：
- `DATABASE_URL` 改为 RDS 地址、账号、密码
- `JWT_SECRET` 改为高强度随机值

## 6. 启动 API（阿里云模式）

```bash
docker compose -f docker-compose.aliyun.yml up -d --build
```

## 7. 迁移与种子数据

```bash
docker compose -f docker-compose.aliyun.yml exec api npm run prisma:migrate:deploy
docker compose -f docker-compose.aliyun.yml exec api npm run prisma:seed
```

## 8. 验证

```bash
curl http://127.0.0.1:3000/api/auth/me
```

预期返回 `401`（未登录）表示 API 正常在线。

默认账号（如未改 seed）：
- `admin / Admin@123`
- `employee / Employee@123`

## 9. 常用运维命令

```bash
# 查看日志
docker compose -f docker-compose.aliyun.yml logs -f api

# 重启
docker compose -f docker-compose.aliyun.yml restart api

# 停止
docker compose -f docker-compose.aliyun.yml down
```

## 10. 上线建议（下一步）

1. 使用 Nginx/SLB 暴露 `80/443`，不要长期开放 `3000`。
2. RDS 白名单仅允许 ECS 私网访问。
3. 启用 HTTPS（证书托管在阿里云证书服务）。
4. 开启 ECS 与 RDS 监控告警。
5. 定期备份 RDS，并演练恢复。

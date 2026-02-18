# 阿里云部署说明（WMS V1 第一版）

## 1. 推荐架构

- 计算：`ECS`（仅跑 API 容器）
- 数据库：`RDS MySQL 8.x`
- 缓存（可选）：`阿里云 Redis`
- 域名与证书：`域名 + SSL 证书（可选）`

说明：当前第一版 API 已可直接部署；前端尚未正式实现，可先通过 API 验证业务。

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
docker compose -f docker-compose.aliyun.yml exec api npm run prisma:migrate
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

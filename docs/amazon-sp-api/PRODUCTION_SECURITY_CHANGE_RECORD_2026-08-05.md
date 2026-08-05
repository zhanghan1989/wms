# 生产安全变更记录（2026-08-05）

用途：Amazon SP-API Developer Profile 申请证据。本文只记录脱敏结果，不记录密码、Token、连接串或其他凭证。

## 已执行

- MySQL root 两个主机范围账号均轮换为随机 256-bit 密码；
- ECS `.env` 中的 root 密码已同步更新，文件权限保持 `600 root:root`；
- MySQL 容器按新的环境变量健康检查配置重建，状态恢复为 `healthy`；
- 新 root 密码验证成功，历史默认密码验证被拒绝；
- API 继续使用仅限 `wms_v1` 的独立 `wms_app`，未改变 XIYA/UOF 或 Amazon 业务凭证；
- ECS 安全组删除公网 RDP 与全部 8888 入站规则；
- UFW 删除 20/21、888、8888、18933、39000-40000 等历史规则，仅保留 22、80、443、3000；
- 公网 IP 的 80 端口改为 308 跳转官网，旧 IP:3000 继续 308 跳转 WMS 正式域名。
- 安装并启用 Fail2ban 的 `sshd` jail：10 分钟内认证失败 5 次即封禁 1 小时，服务随系统启动；首次核验时已自动封禁 1 个恶意扫描来源；
- 经业务确认，3000 端口暂时作为旧书签兼容入口保留，不直接提供 API，并继续仅执行到正式 HTTPS 域名的 308 跳转。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| MySQL 容器健康 | `healthy` |
| 旧 MySQL root 默认密码 | 已拒绝 |
| API / MySQL / Redis | 均运行中；MySQL/Redis/应用源端口仅绑定 `127.0.0.1` |
| `https://wms.fulangke.cn/` | HTTP 200 |
| `https://www.fulangke.cn/` | HTTP 200 |
| `http://8.134.176.116/` | HTTP 308 → `https://www.fulangke.cn/` |
| `http://8.134.176.116:3000/` | HTTP 308 → `https://wms.fulangke.cn/` |
| Fail2ban `sshd` jail | `active`；`maxretry=5`、`findtime=10m`、`bantime=1h` |

## 仍未完成

- 全网 SSH 规则仍为 GitHub Actions 动态 SSH 部署保留；切换固定出口、云助手或自托管 Runner 后删除；
- ECS 快照/独立备份尚未开通，尚未完成隔离恢复演练；
- 64 个系统软件包待在快照后维护升级；
- 阿里云安全中心高级主机防护、漏洞与告警能力尚未形成完整证据；
- XIYA/UOF 外部业务密钥仍需由服务提供方签发新密钥并撤销旧密钥。

执行记录的控制台截图和命令输出应保存在公司受控加密证据目录，不得提交到公开仓库。

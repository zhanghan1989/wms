# Amazon SP-API 申请证据索引

本索引用于 Developer Profile 提交、Amazon 补件和内部复审。截图或报告中不得包含密码、Refresh Token、API Key、MFA Secret、完整数据库连接串或买家个人信息。

| 控制/表单问题 | 当前证据 | 仍需归档 |
| --- | --- | --- |
| 法定主体与联系信息 | 营业执照、ICP备案 `鲁ICP备2026043725号-1`、官网主体信息 | 营业执照扫描件、备案截图、主账号授权证明 |
| 官网及公共政策 | `https://www.fulangke.cn/`、`/privacy/`、`/security/`、`/terms/` | 页面 PDF/截图和检查日期 |
| HTTPS 与安全响应头 | 生产域名 TLS、HSTS、CSP、Referrer Policy 已核验 | `curl -I` 与证书有效期输出 |
| 最小权限与账号隔离 | 管理员/普通用户角色、Seller ID 一对一绑定；数据库 `wms_app` 仅限 `wms_v1` | `ACCESS_REVIEW_RECORD.md` 签字、脱敏数据库授权输出 |
| MFA 与密码控制 | 代码和 UI 已实现 | 按 `MFA_ROLLOUT.md` 完成 18 个账号、强制开关和双角色登录截图 |
| 凭证安全 | ECS `.env` 权限 600；JWT/MFA/Amazon/数据库密钥已随机化 | XIYA/UOF 轮换证明、旧密钥撤销证明、Git 历史扫描结果 |
| 网络与主机安全 | `HOST_SECURITY_BASELINE.md` | 云安全中心、安全组、告警、补丁完成截图；主机/Web 扫描报告 |
| 漏洞管理 | `npm run check:security`、月度 GitHub Actions、`VULNERABILITY_MANAGEMENT.md` | `xlsx` 替换/风险批准、年度第三方渗透测试合同与报告 |
| 事件响应 | `INCIDENT_RESPONSE_PLAN.md`、`INCIDENT_RESPONSE_DRILL.md` | 首次演练签字、当前 Amazon DPP 报告渠道截图 |
| 备份与恢复 | `BACKUP_RESTORE_TEST.md` | 阿里云快照/OSS 策略、加密与保留截图、首次恢复测试签字 |
| 外部处理方 | `THIRD_PARTY_REGISTER.md` | 阿里云/GitHub条款归档，XIYA/UOF 安全与删除义务书面确认 |
| OAuth 与店铺隔离 | 一次性 state、加密 Token、Seller ID 绑定逻辑及自动测试 | Sandbox/Production OAuth 端到端截图和测试 Seller 记录 |
| 数据最小化 | 首期 `AMAZON_SP_API_INCLUDE_RECIPIENT=false`，不申请受限角色 | 生产配置脱敏输出、实际 API 返回字段抽查 |

## 建议证据目录命名

```text
amazon-application-evidence/
  01-company-and-website/
  02-access-and-mfa/
  03-host-and-network/
  04-vulnerability-and-penetration-test/
  05-backup-and-recovery/
  06-incident-response/
  07-third-parties/
  08-oauth-and-data-minimization/
```

证据包只保存在公司受控加密存储中，不提交到公开或多人可读的源代码仓库。

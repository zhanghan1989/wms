# Fulangke WMS · Amazon 申请就绪清单

更新日期：2026-08-05

证据归档映射见 `EVIDENCE_INDEX.md`。

## 已完成

- 法定主体、备案域名、官网、隐私政策、安全说明、服务条款及定价方式已公开；
- `wms.fulangke.cn` 已启用 HTTPS、HSTS、CSP、禁止 iframe 和严格 Referrer Policy；
- 公共应用 OAuth、一次性 state、Seller ID 与系统店铺一对一绑定已实现；
- Amazon Refresh Token 支持 AES-256-GCM 加密，且默认不请求买家 PII；
- MFA、12 位复杂密码及 365 天密码轮换功能已经实现；
- JWT、MFA 加密密钥和 Amazon 数据加密密钥已在 ECS 随机生成并与代码分离；
- 生产 API 已从 MySQL root 切换到仅限 `wms_v1` 的独立 `wms_app` 账号；
- MySQL root 已轮换为随机强密码，旧默认密码已失效，容器健康检查通过；
- ECS 安全组已删除公网 RDP/8888，UFW 已删除未使用历史端口，公网默认页已改为官网跳转；
- CI 在每次发布前执行依赖漏洞扫描、编译、自动测试和站点检查，并每月定时复查生产依赖。

## 阻止提交的事项

| 优先级 | 事项 | 完成标准 | 负责人/证据 |
| --- | --- | --- | --- |
| P0 | 全部 WMS 账号注册 MFA | 所有有效账号 `mfaEnabledAt` 有值，然后启用 `AUTH_REQUIRE_MFA=true` | 账号清单、设置截图、生产配置核验 |
| P0 | 启用密码轮换 | 设置 `AUTH_REQUIRE_PASSWORD_ROTATION=true`，旧密码用户按系统提示更新 | 生产配置核验、一次成功改密记录 |
| P0 | 轮换外部业务凭证 | XIYA 与 UOF 签发新密钥，旧密钥撤销并验证接口 | 对方确认、轮换日期、接口成功记录 |
| P0 | 阿里云主机和网络保护 | 公网 RDP/8888 与 UFW 历史规则已删除；云安全中心高级能力、全网 SSH 和 64 个待更新软件包仍需整改 | `HOST_SECURITY_BASELINE.md`、`PRODUCTION_SECURITY_CHANGE_RECORD_2026-08-05.md`、控制台截图 |
| P0 | 首次事件响应演练 | 按计划完成桌面演练，核验 Amazon 当前报告渠道和 24 小时要求 | `INCIDENT_RESPONSE_DRILL.md` 签字记录 |
| P0 | 首次备份恢复测试 | 当前 0 个快照/策略；先开通独立备份，再恢复到隔离环境并记录 RPO/RTO | `BACKUP_RESTORE_TEST.md`、快照策略截图 |
| P0 | 漏洞管理基线 | 依赖扫描和发布门禁已完成；继续完成主机、Web 扫描及年度渗透测试安排 | `VULNERABILITY_MANAGEMENT.md` |
| P1 | 外部处理方确认 | XIYA/UOF 的用途、字段、保留、删除、保密和事件通知义务书面确认 | `THIRD_PARTY_REGISTER.md` |
| P1 | 旧 Git 凭证风险处置 | 确认历史中出现的密钥均已撤销；保留扫描和轮换记录 | 密钥扫描结果、撤销证明 |
| P1 | `xlsx` 风险处置 | 替换依赖，或形成限权、限大小、来源限制和完成期限的批准记录 | 风险接受/迁移记录 |

## Amazon 审核阶段

1. 上述 P0 全部完成后，逐项复核 Developer Profile 回答；
2. 只申请非受限的 **Inventory and Order Tracking** 角色；
3. 提交 Developer Profile，预计标准角色审核通常需要一至两周；
4. 审核期间创建 Sandbox App 并保存测试证据；
5. 获批后创建 Production App，配置 Login URI 与 Redirect URI；
6. 使用单个测试 Seller 完成 OAuth 和 API 端到端测试；
7. 再逐店铺独立授权，首期不超过 10 个 Seller。

## 官方依据

- Developer Profile：https://developer-docs.amazon.com/sp-api/docs/onboarding-step-3-create-a-developer-profile
- Website Guidelines：https://developer-docs.amazon.com/sp-api/docs/website-guidelines
- Vulnerability Management：https://developer-docs.amazon.com/sp-api/docs/vulnerability-management
- Authorization Limits：https://developer-docs.amazon.com/sp-api/changelog/application-authorization-limits-and-listing-restrictions

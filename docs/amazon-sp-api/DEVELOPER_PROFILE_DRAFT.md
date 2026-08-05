# Amazon SP-API Developer Profile 提交草稿

> 状态：草稿。只有“提交前检查”全部完成后才提交 Amazon。方括号内状态不得复制到表单。

## 1. 主体与应用

- **组织法定名称**：乳山市弗朗克贸易有限公司
- **英文工作名称**：Rushan Fulangke Trading Co., Ltd.（如营业执照/官方材料有核准英文名，以核准名称为准）
- **统一社会信用代码**：91371083MA3R809Y61
- **地址**：山东省威海市乳山市城区深圳路95-18#
- **网站**：https://www.fulangke.cn/
- **隐私政策**：https://www.fulangke.cn/privacy/
- **安全说明**：https://www.fulangke.cn/security/
- **服务条款**：https://www.fulangke.cn/terms/
- **支持邮箱**：flachic0001@gmail.com
- **应用名称**：Fulangke WMS
- **解决方案类型**：公共解决方案提供商（Public Solution Provider）
- **初期方式**：邀请制、暂不在 Appstore 上架；不同法律主体分别通过 OAuth 授权，预计不超过 10 个 Seller 授权。Amazon 当前对未上架公共卖家应用设置 25 个 OAuth Seller 授权上限，因此首期规模在上限内；扩大前再申请上架。

## 2. 主要业务活动（500 字符以内）

建议提交英文：

> Rushan Fulangke Trading Co., Ltd. operates cross-border e-commerce and develops Fulangke WMS, a public OAuth-based order and inventory management service for independently owned Amazon sellers. Each seller authorizes its own account. The service synchronizes non-restricted FBM/FBA order status and FBA inventory for dashboards, replenishment, and warehouse workflows. It does not request buyer PII.

中文参考：

> 乳山市弗朗克贸易有限公司从事跨境电商运营并开发 Fulangke WMS，为不同主体的 Amazon 销售伙伴提供基于 OAuth 的订单、库存、补货和仓储协同。每个销售伙伴独立授权自己的账号。首期仅同步非受限的 FBM/FBA 订单运营字段与 FBA 库存，不请求买家个人身份信息。

## 3. 申请角色

只选择：

- **库存和订单追踪（Inventory and Order Tracking）**

首期不要选择商品信息、定价、买家沟通、财务、税务、Direct-to-Consumer Shipping 等其他或受限角色。当前业务所需接口为 Orders API 与 FBA Inventory API，非受限角色足够。

## 4. 使用案例（5000 字符以内）

建议提交英文：

> Fulangke WMS is an invitation-based public application for independently owned Amazon selling partners. Each organization signs in to its own Seller Central account and authorizes the application through Amazon OAuth. The application never asks for or stores Seller Central passwords. During authorization, the Amazon Seller ID is bound to exactly one internal shop record, and each shop has a separate encrypted refresh token.
>
> The application uses the Inventory and Order Tracking role to retrieve non-restricted order and inventory information. For FBM and FBA orders, it stores Amazon order identifiers, timestamps, order status, marketplace, fulfillment channel, SKU/ASIN, item quantity, price, and currency. For FBA inventory, it stores SKU/FNSKU/ASIN and available, reserved, inbound, and unfulfillable quantities. The first release does not request recipient names, addresses, phone numbers, buyer email addresses, or other restricted buyer PII.
>
> Authorized users use the data to monitor actual sales across their authorized stores, distinguish FBM and FBA fulfillment, view inventory coverage, prepare replenishment, and coordinate warehouse operations. Synchronization runs on a schedule and can also be triggered by an administrator. Data from one seller is not used to access another seller and is not sold, used for advertising, credit scoring, or unrelated analytics.
>
> The service is hosted on a controlled Alibaba Cloud environment in mainland China. HTTPS is required. OAuth refresh tokens are encrypted using AES-256-GCM, application credentials are injected through server-side secrets, and access is restricted by role. OAuth requests use short-lived, one-time state values and validate the expected Seller ID. Users may disable a connection or revoke authorization in Seller Central. On termination, tokens are deleted and Amazon information is deleted or anonymized according to the retention policy.

## 5. 授权用户受益说明（500 字符以内）

建议提交英文：

> Authorized sellers no longer need to download and combine reports from every store. Fulangke WMS automatically separates FBM and FBA orders, synchronizes FBA inventory, and provides a consolidated operational dashboard. This reduces manual import errors, identifies stale or failed store synchronization, improves replenishment decisions, and keeps each legal entity’s authorization and data isolated.

## 6. 安全问题作答状态

| Amazon 问题 | 当前应答 | 何时可选“是”/说明 |
| --- | --- | --- |
| 是否实施防火墙、IDS/IPS、防病毒/反恶意软件和网络分段？ | **暂选否** | 完成阿里云安全中心、主机恶意软件防护、告警和安全组证据后改为“是”。 |
| 是否按工作职责/业务职能限制 Amazon 信息访问？ | **是** | 管理员角色、唯一账号、店铺授权隔离；提交前补权限复审记录。 |
| 是否加密传输中的 Amazon 信息？ | **是** | 官网、WMS、OAuth 均为 HTTPS；提交前保存 TLS/响应头检查证据。 |
| 是否有明确职责、6 个月审查和 24 小时通知的事件响应计划？ | **待负责人批准后选是** | 采用 `INCIDENT_RESPONSE_PLAN.md`，完成首次桌面演练并签字。 |
| 是否在 24 小时内按 Amazon 指定渠道报告？ | **待负责人批准后选是** | 表单若仍显示 `security@amazon.com`，同时遵循表单要求；提交前依据当前 DPP/官方公告核验有效事件报告渠道，不能只依赖已宣布停用的历史邮箱。 |
| 是否强制 12 位复杂密码、MFA、365 天到期和年度轮换？ | **暂选否** | WMS 实现并启用 MFA、密码复杂度及轮换后才能选“是”。 |
| 凭证是否安全存储，不在公共仓库共享或硬编码？ | **暂选否** | 本地代码已移除硬编码；ECS 完成全部旧密钥轮换并验证仓库历史无有效密钥后改为“是”。 |

不要为通过审核而把“暂选否”改成“是”。先完成控制和证据，再提交表单。

## 7. 外部方共享说明（500 字符以内）

建议提交英文：

> Alibaba Cloud hosts the application, database, encrypted storage, network, and backups under our administrative control. GitHub is used for source code and CI/CD only and does not receive production Amazon data or credentials. When an authorized seller enables the related fulfillment workflow, limited order/product/logistics data may be sent to XIYA and tracking identifiers to UOF solely to provide fulfillment or tracking services. OAuth credentials are never shared. Providers are subject to confidentiality, security, deletion, and incident-notification requirements.

## 8. 外部（非 Amazon）信息来源（500 字符以内）

建议提交英文：

> Non-Amazon sources are: data entered or uploaded by authorized WMS users; product, order, and logistics records returned by the authorized XIYA integration; shipment tracking events returned by UOF; Yamato shipping files used by warehouse staff; and security, audit, and operational logs generated by Fulangke WMS and Alibaba Cloud infrastructure. These sources are used only for warehouse, fulfillment, inventory, and support workflows.

## 9. 生产应用配置

- **OAuth Login URI**：`https://wms.fulangke.cn/`
- **OAuth Redirect URI**：`https://wms.fulangke.cn/api/amazon-sp-api/oauth/callback`
- **Website**：`https://www.fulangke.cn/`
- **Privacy Policy**：`https://www.fulangke.cn/privacy/`
- **Support**：`flachic0001@gmail.com`
- **Restricted data**：首期不申请、不调用；`AMAZON_SP_API_INCLUDE_RECIPIENT=false`

## 10. 提交前检查

- [ ] ECS 已配置新的随机数据库、JWT、XIYA、UOF、Amazon LWA 和 Amazon 加密密钥；旧密钥全部撤销；
- [ ] 使用非 root 数据库应用账号并完成最小权限验证；
- [ ] MFA、密码复杂度和密码轮换已上线并对所有账号强制；
- [ ] 阿里云安全中心、恶意软件防护、安全组和告警有截图证据；
- [ ] 首次权限复审、备份恢复演练和事件响应演练已完成；
- [ ] XIYA/UOF 数据处理范围和安全义务已确认；
- [ ] OAuth Login URI 的 Seller Central → WMS 登录 → 选择店铺 → Amazon 确认 → Redirect URI 全流程通过；
- [ ] 一个 Seller ID 无法绑定两个系统店铺，不同店铺 Token 无法互用；
- [ ] 线上 `Referrer-Policy: no-referrer`、CSP、HSTS 和 TLS 检查通过；
- [ ] 官网主体、隐私政策、安全说明、服务条款和支持邮箱可公开访问；
- [ ] Developer Profile 所填内容与实际控制及证据一致。
- [ ] 完成旧版 `xlsx` 依赖替换或形成负责人批准的限权、限大小和迁移期限风险处置记录。

## 官方参考

- https://developer-docs.amazon.com/sp-api/docs/onboarding-step-1-prepare-for-registration
- https://developer-docs.amazon.com/sp-api/docs/onboarding-step-3-create-a-developer-profile
- https://developer-docs.amazon.com/sp-api/docs/onboarding-step-6-set-up-the-authorization-workflow
- https://developer-docs.amazon.com/sp-api/docs/website-guidelines
- https://developer-docs.amazon.com/sp-api/docs/role-mappings
- https://developer-docs.amazon.com/sp-api/changelog/application-authorization-limits-and-listing-restrictions
- https://developer-docs.amazon.com/sp-api/changelog/new-processes-for-reporting-security-incidents-and-informing-amazon-of-organizational-changes

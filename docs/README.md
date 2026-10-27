# Docs 索引

## 发布
- 正式版发布说明：`archive/history/RELEASE_v1.0.1.md`
- GitHub Release 文案：`archive/history/GITHUB_RELEASE_v1.0.1.md`
- 变更记录：`../CHANGELOG.md`

## 部署
- 磁盘写入、容量监测和日志维护：[优化说明](storage-optimization-20261028.md)
- 阿里云部署：`DEPLOY_ALIYUN.md`
- 本地开发：`LOCAL_DEV.md`
- 分支与发布流程：见 `LOCAL_DEV.md`

## 设计与规范
- `AI_DEV_SPEC.md`
- `UTF8_TEXT_COMMANDS.md`

## 开发交接
- `archive/history/订单管理续开发交接_20260416.md`

## Xiya 接口对接

- 当前中国发订单拉取与接收回执：[接口文档（2026-10-13）](xiya中国发订单拉取与回执接口文档_20261013.md)
- WMS 自动拉取 Xiya 运单号：[接口与亚马逊排查说明（2026-10-14）](xiya运单号自动拉取接口与亚马逊排查说明_20261014.md)
- 亚马逊与 TikTok 运单未同步：[生产调查与已确认原因（2026-10-14）](archive/history/亚马逊与TikTok运单号未同步调查_20261014.md)
- Xiya 运单同步动态名单：[新增、改名和停用的自动更新说明（2026-10-14）](xiya运单动态店铺名单说明_20261014.md)
- Xiya 向 WMS 创建手动订单（另一方向，历史说明）：`xiya手动订单批量创建接口文档_20260423.md`

## 模板文件
- `产品列表.xlsx`、`批量上传SKU.xlsx`
- `批量入库.xlsx`
- `批量更新库存.xlsx`

人工多包裹拆分的原乐天订单关联与新增迁移说明见 [乐天订单处理流程](rakuten-order-workflow.md)。

## 历史资料

- [历史发布、调查与交接资料](archive/history/README.md)
- 亚马逊申请材料：`archive/amazon-sp-api-application/`（仅留档，不参与生产镜像）。

生产镜像仅复制本目录的 Excel 模板；业务文档与历史资料不进入运行镜像。

# 乐天 RMS 日本出口

生产环境通过 Tailscale 用户空间容器，仅将乐天 RMS API 请求送到日本办公室飞牛 OS 的 Exit Node。
用户空间模式不会在阿里云 ECS 宿主机创建 `tailscale0`、修改路由或安装防火墙规则，因而避开阿里云
Workbench 和云助手使用的 `100.104.0.0/16` 与 Tailscale CGNAT 网段的冲突。

## 飞牛 OS

飞牛应用版 Tailscale 的 CLI 和 socket：

```text
/vol1/@appcenter/tailscale/bin/tailscale
/vol1/@appdata/tailscale/tailscaled.sock
```

启用并持久化 IP 转发，然后声明 Exit Node：

```sh
printf '%s\n' 'net.ipv4.ip_forward = 1' 'net.ipv6.conf.all.forwarding = 1' | sudo tee /etc/sysctl.d/99-tailscale-exit-node.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale-exit-node.conf
sudo /vol1/@appcenter/tailscale/bin/tailscale --socket=/vol1/@appdata/tailscale/tailscaled.sock set --advertise-exit-node
```

在 Tailscale Machines 页面批准 `cb-nas` 的 `Use as exit node`。飞牛 Tailscale IP 当前为
`100.87.11.96`。

## 阿里云 ECS

不要在 ECS 宿主机运行普通内核模式的 Tailscale。它的防火墙规则会把阿里云 Workbench/云助手的
`100.104.0.0/16` 流量视作 CGNAT 欺骗流量并丢弃。

生产部署使用 Compose profile `rakuten-egress`：

- 镜像固定为 `tailscale/tailscale:v1.98.4`。
- `TS_USERSPACE=true`，不会修改宿主机网络。
- HTTP 代理只存在于 Compose 内部网络，不映射宿主机或公网端口。
- 登录状态保存在外部卷 `rakuten_tailscale_state`。
- `TS_EXTRA_ARGS` 会在每次容器启动时重新选择飞牛 Exit Node。

部署脚本会将已验证的临时容器 `rakuten-tailscale-test` 迁移为正式服务 `wms_rakuten_egress`，并复用
同一个状态卷。API 内部代理地址固定为 `http://rakuten-egress:1055`。

验证：

```sh
docker exec wms_rakuten_egress tailscale status
docker exec wms_api node -e "const {ProxyAgent}=require('undici'); const agent=new ProxyAgent(process.env.RAKUTEN_RMS_API_PROXY_URL); fetch('https://api.rms.rakuten.co.jp/', {dispatcher:agent}).then(r=>console.log(r.status)).finally(()=>agent.close())"
```

只有 `RakutenRmsApiClient` 使用该代理，系统其他网络请求仍走原出口。代理连接使用 HTTPS CONNECT，
WMS 与乐天之间的 TLS 保持端到端加密。

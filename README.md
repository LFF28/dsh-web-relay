# dsh-web-relay

让远程设备经过认证后直接使用服务器上的 `dsh web`：不需要 VPN，也不需要在客户端做端口转发。

内网主机主动向一台公网中继（腾讯云 / 阿里云 VPS）拨出 SSH 反向转发，中继上用 Caddy 终止 TLS 并提供一层网关口令，DSH 侧保留权威绑定 Cookie。中继上不安装本项目的任何代码，只用到系统 `sshd` 与 Caddy。

## 当前状态

插件已实现，并已在一台真实中继（Ubuntu 26.04、`OpenSSH_10.2p1`、Caddy 2.11.4）上端到端验证过。本仓库包含实现、设计文档与中继侧配置模板：

```
src/       插件实现（host 半边 + 浏览器半边）
docs/      设计文档（单一事实来源）
deploy/    引导写入中继的配置模板
```

设计与代码落点都在 [docs/README.md](docs/README.md)：需求与约束、拓扑、首次使用流程、文档索引。后续项与各条设计假设的核对方式在 [docs/roadmap.md](docs/roadmap.md)。

## 安装

插件以 npm 包形式装进某个 profile，不修改 DSH 源码：

```
dsh plugin --profile web add file:/path/to/dsh-web-relay
dsh plugin --profile web remove dsh-web-relay
```

包结构与安装 / 卸载 / 升级的细节见 [docs/modules/plugin-bundle.md](docs/modules/plugin-bundle.md)。

## 使用

首次配置必须在**服务器本机**的 `http://127.0.0.1:<dshPort>` 页面上完成：DSH 对非 loopback 页面把设置持久化降级为内存，远程页面写不了设置。前提是中继上已经配好管理账号的公钥登录与免密 sudo——插件不配置中继的 SSH 认证，也不存管理口令。在 设置 ▸ 插件 ▸ Web Relay 填入中继地址、管理账号与网关口令，保存即触发自动引导；引导结束后终端上会打印一行 `dsh-web-relay: https://<权威>/relay/enter`，手机打开这一条并输入网关口令即可使用。完整流程见 [docs/README.md](docs/README.md)。

## 许可

未声明许可。仓库可以公开阅读，但未授予再分发或衍生使用的许可。

# dsh-web-relay

让远程设备经过认证后直接使用服务器上的 `dsh web`：不需要 VPN，也不需要在客户端做端口转发。

内网主机主动向一台有公网地址的中继服务器拨出 SSH 反向转发，中继上用 Caddy 终止 TLS 并提供一层网关口令，DSH 侧保留权威绑定 Cookie。中继上不安装本项目的任何代码，只用到系统 `sshd` 与 Caddy。

## 当前状态

插件已实现，并已在一台真实中继（Ubuntu 26.04、`OpenSSH_10.2p1`、Caddy 2.11.4）上端到端验证过。本仓库包含实现、设计文档与中继侧配置模板：

```
src/       插件实现（host 半边 + 浏览器半边）
docs/      文档：部署、配置、安全与排障
deploy/    引导写入中继的配置模板
```

文档索引见 [docs/README.md](docs/README.md)：工作原理、部署指南、配置项、插件改动了什么、安全设计、排障。实现记录与设计假设的核对方式在 [docs/internals/](docs/internals/README.md)。

## 安装

插件以 npm 包形式装进某个 profile，不修改 DSH 源码：

```
dsh plugin --profile web add file:/path/to/dsh-web-relay
dsh plugin --profile web remove dsh-web-relay
```

包结构与安装 / 卸载 / 升级的细节见 [docs/internals/packaging.md](docs/internals/packaging.md)。

## 使用

首次配置必须在**服务器本机**的 `http://127.0.0.1:<dshPort>` 页面上完成：DSH 对非 loopback 页面把设置持久化降级为内存，远程页面写不了设置。前提是中继上已经配好管理账号的公钥登录与免密 sudo——插件不配置中继的 SSH 认证，也不存管理口令。在 设置 ▸ 远程访问 填入中继地址、管理账号与网关口令，点「部署」即触发完整引导；引导结束后终端上会打印一行 `dsh-web-relay: https://<权威>/`，手机打开这一条并输入网关口令即可使用。完整流程见 [docs/deployment.md](docs/deployment.md)。

## 许可

[MIT](LICENSE)。

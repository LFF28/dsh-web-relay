# dsh-web-relay

`dsh-web-relay` 是一个独立的 DSH 插件包，让远程设备（手机 / 平板 / 另一台电脑）经过认证后直接使用服务器上运行的 `dsh web`，不需要 VPN，也不需要在客户端做端口转发。

插件以 npm 包的形式装进某个 profile，不修改 DSH 源码：

```
dsh plugin --profile web add file:/path/to/dsh-web-relay
```

本目录是设计文档，描述已实现的插件。文档按功能模块拆分，每个模块给出职责、接口、配置字段、失败模式，以及它复用的既有能力。

## 需求与约束

| 编号 | 约束 | 在设计中落点 |
| --- | --- | --- |
| 1 | 轻量化 | 一个 npm 包、两个半边（host 插件 + 设置菜单里的一个标签页）、host 侧 6 个模块；隧道复用系统 OpenSSH，公网入口复用 Caddy，不自研 TLS、协议、密码学 |
| 2 | 使用公网中继服务器（腾讯云 / 阿里云） | 服务器主动向中继拨出 SSH 反向转发；中继上只有系统 `sshd` 与 Caddy，不装本项目的任何代码 |
| 3 | 只服务我一个人，暴露在公网，必须安全 | 中继侧强制 TLS + 网关口令，且只有一个 HTTP 端口；DSH 侧保留权威绑定 Cookie，Cookie 缺的 `Secure` 由中继补上，见 [security.md](security.md) |
| 4 | 部署转发 `dsh web` | DSH 仍只监听 `127.0.0.1`；浏览器只接触中继，永不直连内网主机 |
| 5 | 暂无域名 | 中继用 Caddy 自带的本地 CA 为 IP 权威签发证书。**这是这条通路上唯一需要你决定的选项**：装 CA 消除证书警告；不装则每次访问都要手动点过警告，且没有身份验证，见 [security.md](security.md) |

非目标：多用户 / 多租户、按设备配对与逐个吊销、内网主机开放入站端口、桌面端（Electron 走 IPC 不开端口）、在任何客户端安装软件。

## 拓扑

```
 iPhone Safari
      │  https://<publicAuthority>            （唯一入口，公网）
      ▼
 ┌──────────────────────────────────────────────────────────┐
 │ 中继主机（VPS，腾讯云 / 阿里云）                            │
 │   Caddy :8443   ── TLS 终止 + 网关口令 + 反向代理           │
 │      │ http://127.0.0.1:18080   （Host 原样透传）           │
 │   sshd  loopback 上的反向转发端点                           │
 └──────────────────────────────────────────────────────────┘
      ▲
      │  ssh -N -R 127.0.0.1:18080:127.0.0.1:3080   （内网主机主动拨出）
      │
 ┌──────────────────────────────────────────────────────────┐
 │ 内网 DSH 主机                                              │
 │   dsh web  →  WebServer 127.0.0.1:3080（仅 loopback）      │
 │   dsh-web-relay 插件：守护 ssh 子进程 + 设置 ▸ 远程访问      │
 └──────────────────────────────────────────────────────────┘
```

两个方向性结论：

- 内网主机**不开任何入站端口**；连接方向永远由内网主机发起，第三方即使知道公网 IP 也连不到它。
- 中继上的 `127.0.0.1:18080` 只在 loopback 上，能连它的只有同一台机器上的 Caddy，见 [modules/relay-host.md](modules/relay-host.md)。
- 中继对外只有 `8443` 一个 HTTP 端口。Cookie 不按端口隔离（RFC 6265 第 8.5 节），多一个端口就多一条读到会话 Cookie 的路，见 [security.md](security.md)；发行版默认 Caddyfile 自带的 `:80` 站点要按 [modules/relay-host.md](modules/relay-host.md) 第 3 节删掉。

## 首次使用流程

**前提**：中继上你已经配好管理账号的公钥登录与免密 sudo。插件不配置中继的 SSH 认证，也不存管理口令，见 [configuration.md](configuration.md) 的"配置前的前提"。

1. 把插件装进 profile，重启 `dsh web`。这次启动不会自动部署——「随 DSH 启动自动部署」默认关，记录里也还没有成功过的部署，所以要在设置页点一次「部署」。
2. 在**服务器本机**用浏览器打开 `http://127.0.0.1:3080`。首次配置只能在这里做：DSH 的客户端在非 loopback 页面上把设置持久化降级为内存，远程页面写不了设置（见 [security.md](security.md)）。
3. 打开 **设置 ▸ 远程访问**，填入中继地址、管理账号与网关口令，点「部署」。部署会把表单写进设置，并在中继上完整跑一遍引导；同页的「随 DSH 启动自动部署」开关要这次部署成功才算数，打开它之后每次启动 `dsh web` 都会自动重跑一遍完整部署。
4. 这次部署自动完成：生成本机专用中继密钥 → 用管理账号登录中继 → 建受限中继用户与 `authorized_keys` → 安装并配置 Caddy → 为中继权威签发证书 → 把权威写进 DSH 的组合层（host trust）→ 拉起 SSH 反向隧道。终端上打印横幅，第一行是访问地址 `dsh-web-relay: https://<权威>/`，随后是中继 CA 指纹、中继主机密钥指纹与 Caddy 版本。引导第 10 步同时把中继上的 CA 根证书取回本机，存在 `$DSH_HOME/dsh-web-relay/ca/root.crt`。
5. 把 `$DSH_HOME/dsh-web-relay/ca/root.crt` 送到手机上并安装：公网 HTTP 面上没有提供根证书的端点（换票点只换会话，不返回任何文件），所以这一步走本机复制、隔空投送或聊天软件，装之前先与横幅或设置页状态区里的 `caFingerprint` 核对。**唯一需要你决定的是装不装中继 CA**：装了就消除证书警告，不装则每次访问都要手动点过警告且失去身份验证，见 [security.md](security.md) 的"证书与 CA"一节。
6. 手机用浏览器打开裸地址（`https://<权威>/`）并输入网关口令即可使用：中继会把这次访问在内部带到换票点，地址栏里不会出现 `/relay/enter`。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 端到端设计：组件职责、端口与监听、启动顺序、三条关键链路 |
| [configuration.md](configuration.md) | 配置参考：设置页字段、组合层 `Config`、优先级、一次部署做了什么 |
| [security.md](security.md) | 威胁模型、分层防御、不接受的做法、风险接受、已知限制 |
| [modules/plugin-bundle.md](modules/plugin-bundle.md) | 打包与分发：双半边结构、bundle patch、安装 / 卸载 / 升级 |
| [modules/settings.md](modules/settings.md) | 设置命名空间与设置页：字段、口令存储、状态回显、部署怎么被触发 |
| [modules/bootstrap.md](modules/bootstrap.md) | 引导：部署时用管理账号在中继上完成 sshd / Caddy / 证书配置（前提：公钥登录 + 免密 sudo） |
| [modules/trust.md](modules/trust.md) | 权威注册与自检：把"手机 403"变成"部署即报错" |
| [modules/tunnel.md](modules/tunnel.md) | SSH 反向隧道守护：子进程、重连、释放、诊断 |
| [modules/entry.md](modules/entry.md) | 裸地址入口与登录接续：不含秘密的访问地址、内部换票点 `/relay/enter`、CA 分发 |
| [modules/relay-host.md](modules/relay-host.md) | 中继侧的生效形态：sshd 加固、Caddyfile、防火墙、验证清单 |
| [modules/operations.md](modules/operations.md) | 运行手册、故障定位表、轮换与吊销 |
| [roadmap.md](roadmap.md) | 后续项与设计假设的核对方式 |

## 术语

| 术语 | 含义 |
| --- | --- |
| 中继主机 / VPS | 有公网地址、承载唯一入口的那台机器 |
| 内网主机 | 运行 `dsh web` 的机器，可以没有公网地址 |
| 权威（authority） | 浏览器地址栏里的 `host[:port]`，本文档中记作 `publicAuthority` |
| 网关 | 中继上的 Caddy 站点，负责 TLS 与口令层 |
| 访问地址 | `https://<publicAuthority>/`，不含任何秘密；Cookie 过期后重新打开它即自动续上 |
| 换票点 | 内网插件在 `/relay/enter` 上的一条路由，把"已过网关口令"换成 DSH 会话；由中继在内部改写到达，不进地址栏 |
| 引导 | 插件用管理账号在中继上自动完成的一次幂等配置动作 |

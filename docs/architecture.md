# 架构

`dsh-web-relay` 把一台内网主机上的 `dsh web` 暴露给远程设备。内网主机不开入站端口，连接方向永远由内网主机发起；公网侧只有一台跑系统 `sshd` 与 Caddy 的中继主机，中继上不安装本插件的任何代码。

## 端到端数据路径

```
 iPhone Safari
      │  ① https://<publicAuthority>            （唯一公网入口）
      ▼
 ┌───────────────────────────────────────────────────────────┐
 │ 中继主机（VPS）                                             │
 │   Caddy :8443    TLS 终止 → 网关口令 → 反向代理             │
 │      │  ② http://127.0.0.1:18080   Host 原样透传，不改写     │
 │   sshd           loopback 上的反向转发端点                   │
 └───────────────────────────────────────────────────────────┘
      ▲
      │  ③ ssh -N -R 127.0.0.1:18080:127.0.0.1:3080  （内网主机拨出）
      │
 ┌───────────────────────────────────────────────────────────┐
 │ 内网 DSH 主机                                               │
 │   dsh web            WebServer 127.0.0.1:3080（仅 loopback） │
 │   dsh-web-relay 插件  守护 ③（含预检）+ 自动引导 + 设置卡片  │
 └───────────────────────────────────────────────────────────┘
```

② 的 Host 必须原样透传：Caddy 一旦 `header_up Host` 改写成 loopback，DSH 的权威围栏就会把"声明式信任"变成"伪造 loopback 信任"，见 [modules/trust.md](modules/trust.md)。Caddy 只改响应里的一处：给上游的每个 `Set-Cookie` 补上 `Secure`（DSH 自己不下发这一位），见 [modules/relay-host.md](modules/relay-host.md)。

③ 是中继上唯一被允许监听 `18080` 的东西：`GatewayPorts no` 加上 `permitlisten="127.0.0.1:18080"` 让它只出现在 loopback，能连它的只有同机 Caddy，见 [modules/relay-host.md](modules/relay-host.md)。主机侧异常中断会让旧会话的端点残留在同一个端口上，由转发前预检清掉，见 [modules/tunnel.md](modules/tunnel.md)。

## 两条配置平面

插件把配置刻意分成两层，因为它们的写入者、生命周期和保密级别都不同。

| 平面 | 载体 | 写入者 | 内容 |
| --- | --- | --- | --- |
| 行为旋钮 | 包内 `cordis.patch.yml` 的行 `config` | 包作者 | 超时、退避序列、入口与自检开关、日志标签；都带默认值，无需配置即可运行 |
| 部署参数 | settings 命名空间 `web-relay` | 用户在设置卡片里填 | 中继地址、管理账号与其私钥路径、网关口令、主机密钥指纹固定 |
| 运行记录 | settings 命名空间 `web-relay-record` | 插件 | 引导状态、观察到的指纹、访问地址、CA 指纹、引导步骤结果 |

把部署参数放进 settings 而不是 patch 文件，有三个直接后果：

- 密钥与口令不进 patch 文件，拿到一次 `cordis.patch.yml` 副本的人不会同时拿到凭据。
- 用户在设置卡片里改地址或口令，插件在同一进程内完成重配置，不需要编辑 YAML、不需要重启 `dsh web`。
- 插件在加载期几乎没有可失败的自包含校验，因此不会因为填错地址把 profile 变成起不来的状态；错误在引导步骤里以文本呈现。

字段参考见 [configuration.md](configuration.md)，机制见 [modules/settings.md](modules/settings.md)。

## 行与行序

插件的 bundle patch 做两件事：

```yaml
- id: connection
  inject: [webRuntime, webRelay]
  config:
    trustedHosts: !!js [...ctx.webRuntime.trustedHosts, ...ctx.webRelay.trustedHosts]

- insert:
    - id: web-relay
      name: dsh-web-relay
```

`connection` 行原本只注入 `webRuntime`；patch 把 `webRelay` 追加进 `inject`，并把权威围栏的受信列表接上插件提供的权威。`insert` 没有 `id`，所以 `web-relay` 行被追加到组合列表末尾，排在 `connection` 行之后。

行序在 cordis 里是"先创建先启动"，但**未满足的必需注入不会阻塞后续行**：`connection` 行创建后因缺 `webRelay` 停在 PENDING，`Entry._start` 立刻返回，树继续创建后面的行；`web-relay` 行的 `apply` 同步 `ctx.provide('webRelay', …)` 后，Cordis 的 `reflect.notify` 让 `connection` 行重新解析配置并按新值激活。所以插件不需要抢行序，也不需要动态插入行。

`connection` 行的 `config` 只有 `trustedHosts` 一个键，patch 替换整份 `config` 是完备的。

## 插件内部模块

Host 半边（`lib/index.js`）暴露一个 `dsh-web-relay` 插件，内部按职责分文件：

| 模块 | 职责 |
| --- | --- |
| `settings` | 注册两个命名空间，把用户字段规范化成一份 `Deployment`（地址、账号、路径） |
| `bootstrap` | 幂等引导：登录中继、建受限用户、装 Caddy、发证书、取回 CA，见 [modules/bootstrap.md](modules/bootstrap.md) |
| `trust` | 把 `publicAuthority` 变成围栏受信项（改权威时重解析 `connection` 行），并跑启动自检，见 [modules/trust.md](modules/trust.md) |
| `tunnel` | 转发前预检（清掉上一轮残留的监听端点）、SSH 反向转发子进程的生命周期、退避、健康判定、拆除，见 [modules/tunnel.md](modules/tunnel.md) |
| `entry` | `/relay/enter` 一条精确路由（换票点）：只把启动令牌换成 DSH Cookie；中继把裸地址上的文档导航在内部改写到它，见 [modules/entry.md](modules/entry.md) |

Client 半边（`lib/client.js`）只做一件事：向 `plugins.item` 注册一张以 `web-relay` 为 `id` 的设置卡片。卡片自绘表单与状态区，只依赖平台模块表里的 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`，其余全部走服务：`ctx.slots`、`ctx.settingsScope`、`ctx.locale`。

## 服务

插件通过 `ctx.provide('webRelay', …)` 暴露一个服务，供 `connection` 行的配置表达式读取：

| 成员 | 说明 |
| --- | --- |
| `trustedHosts: string[]` | 当前应当被围栏接受的权威，取自 settings；未配置时为空数组。每次读取返回新数组，表达式可以安全展开 |
| `authority(): string \| undefined` | 当前权威，形状为 `host[:port]` |
| `status(): RelayStatus` | 引导状态、隧道状态、最近错误、观察到的指纹、最近一次转发前预检，供运行手册与诊断引用 |

## 启动时序

1. `web-relay` 行 `apply`：读 `ctx.webServer.port` 得到本机端口，注册 `/relay/enter` 一条精确路由（`entry.enabled` 为假时它回 `403`，路由本身仍在），同步 `provide` `webRelay`。
2. `apply` 内用 `ctx.inject(['settings'], …)` 注册两个命名空间。settings 已在更早的基础层行里就绪，回调同步执行，因此**已知的权威在第一次解析 `connection` 行时就可用了**。
3. `connection` 行按注入出现而激活，围栏拿到权威列表。
4. 若 settings 里部署参数齐全，`autoStart` 打开时插件按 [modules/bootstrap.md](modules/bootstrap.md) 的顺序引导并拉起隧道；若上次运行已完成引导，则直接拉起隧道。
5. 引导改变权威时，`trust` 重解析 `connection` 行，围栏在数毫秒内接受新权威。

## 不变量

- DSH 永远只监听 `127.0.0.1`；内网主机永远不监听公网。
- 公网访问地址（裸权威）不含任何秘密；换票点这条路径不经操作者的手，网关口令从不出现在 URL、书签或浏览器历史里。
- 没带 DSH 会话 Cookie 的文档导航一定被带进换票点：中继改写在前、失效 Cookie 的 `401` 恢复跳转在后；带 Cookie 的请求不被改写（没有这条判据就会每次取界面都换一次票）。
- Caddy 永远不改写 Host / Origin / Referer。
- 中继上只有一个 HTTP 端口（`gateway.port`），且只有 loopback 上的 `18080` 作为它的上游。
- 每个经过中继的 `Set-Cookie` 都带 `Secure`；DSH 自己不下发这一位，由上游定义里的 `header_down` 补上。
- 中继上的反向转发端点永远只在 loopback。
- 转发前预检只对持有 `tunnel.relayPort`、`/proc/<pid>/exe` 是 `sshd` 或 `sshd-session`、且属主为 `relay` 的进程动手；其余情况一律停手并记录。
- 浏览器只与中继说话，永不直连内网主机。
- 插件在中继上留下的每样东西都在 `/etc/dsh-web-relay` 与 `/etc/caddy/Caddyfile` 的两个带标记的托管块里，卸载路径见 [modules/operations.md](modules/operations.md)。

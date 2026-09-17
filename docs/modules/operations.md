# 模块：运维

职责：把"出问题了怎么定位"和"需要变更时怎么做"写成可照抄的步骤。本设计的复杂度主要不来自代码，而来自四个位置（内网主机、隧道、中继 sshd、中继 Caddy）之间的耦合，因此运维文档是交付物的一部分。

## 可观测性

| 观测点 | 位置 | 内容 |
| --- | --- | --- |
| 设置卡片状态区 | 服务器本机浏览器 | 引导状态、权威、书签、CA 指纹与下载地址、逐步引导结果、最近一次错误 |
| 启动横幅 | 内网主机 `dsh web` 终端 | 公网 URL、稳定书签、CA 指纹、隧道状态、自检结果 |
| 隧道日志 | 内网主机 `dsh web` 终端 | `ssh` 进程每次退出的退出码与 stderr 摘要 |
| 隧道状态 | `ctx.webRelay.status()` | `state` / `since` / `connectedCount` / `lastExit` |
| 引导步骤结果 | 记录的 `steps` | 每步 `ok` / `failed` / `skipped` 与一句话说明 |
| 访问日志 | 中继 `/var/log/caddy/dsh-relay-access.log` | JSON 单行；`remote_ip`、状态码、耗时；`key` 参数已打码，Cookie 默认打码 |
| 认证失败 | 同上 | 401 覆盖 Caddy 的 `basic_auth` 失败与 DSH 的 Cookie 失败；两者都是可疑信号 |
| fail2ban | 中继 | 依据访问日志封 IP |
| 隧道端点 | 中继 `ss -ltnp \| grep 18080` | 必须是 `127.0.0.1:18080` |

内网主机日志的保留策略沿用 `dsh web` 自身的输出方式（终端 / 你已有的日志方案）；本插件不写日志文件，也不需要轮转配置。

## 故障定位

从症状出发。每一行给出"先看哪里"，避免在四个位置之间乱猜。

| 症状 | 最可能的原因 | 先看 |
| --- | --- | --- |
| 卡片显示某一步 `failed` | 引导停在那一步，后续步骤是 `skipped` | 卡片状态区的该步说明；它带着 `ssh` 原文 |
| 手机打不开，Safari 报证书错误 | 客户端未信任中继 CA，或未在"证书信任设置"里开启完全信任 | 用 `/relay/ca.crt` 重新取根证书，与卡片显示的 SHA256 指纹核对 |
| 手机弹出重复的用户名/密码框 | 网关口令错，或换过口令后 Safari 缓存了旧的 | 卡片里改 `gateway.password` 并保存；在 Safari 里清除该站点数据 |
| 页面加载出 403 | 权威没进 `trustedHosts`（`vps.host` + `gateway.port` 与 Caddy 站点地址不一致） | 内网启动日志的自检第 ① 项；它直接指出两个值的差异 |
| 页面加载出 401 | 权威进了 `trustedHosts`，但 Cookie 不对（过期 / 换了权威 / 换了签名密钥） | 用稳定书签重新走一次 `/relay/enter` |
| Caddy 返回 502 "隧道未连接" | 内网主机的隧道没起来，或端口不一致 | 内网隧道日志的 `lastExit.message`；再查中继的 `permitlisten` 与 Caddy 上游地址 |
| 隧道日志反复出现 `remote port forwarding failed for listen port 18080` | 中继上该端口已被占用（残留的旧 sshd 会话、或另一个进程） | 中继 `ss -ltnp \| grep 18080`；必要时杀掉残留进程 |
| 隧道日志出现 `Host key verification failed` | 中继换了主机密钥 | 核对云控制台指纹后清空记录的 `observedHostKeyFingerprint` 并重新引导 |
| 隧道日志出现 `Permission denied (publickey)` | 中继上的 `authorized_keys` 托管块被改过，或引导没跑到第 5 步 | 中继 `/etc/dsh-web-relay/authorized_keys` 与 `/var/log/auth.log` |
| 隧道连不上，同时手动 `ssh` 也连不上中继 | 内网主机的公网出口 IP 已被 sshd 的来源惩罚（OpenSSH ≥ 9.8）或 fail2ban 的 sshd jail 封禁——反复的公钥失败会触发它 | 中继 `sshd -T \| grep -i persource` 确认惩罚是否启用；`fail2ban-client status sshd`。修好公钥后等封禁到期，或把出口 IP 加入 `PerSourcePenaltyExemptList` / `ignoreip` |
| 隧道显示 running 但公网连不上 | 安全组没开 `gateway.port`，或 Caddy 没监听 | [relay-host.md](relay-host.md) 的验证清单 |
| 页面加载出 401，且响应里没有 `www-authenticate` | 网关 Cookie 没带上，或 Caddy 那一层没放行 | 中继访问日志里该请求的状态码 |
| 浏览器显示一片空白，状态码是 200 且响应体为空 | Host 与站点地址不匹配，请求没进权威站点。兜底站点生效后这里应该是 421 加一段文字；看到空白说明兜底站点没写进去 | 中继 `curl -H 'Host: <权威>' https://<权威>/`；比对 `vps.host` 与 `gateway.port` |
| 页面加载出 421 | Host 与权威不匹配（兜底站点接住了） | 核对客户端地址栏里的 host:port 与卡片显示的权威是否逐字一致 |
| 认证成功后 `set-cookie` 里没有 `Secure` | 上游片段里的 `header_down` 掉了，或被改写成了不起作用的站点级 `header` | 中继 `/etc/caddy/Caddyfile` 的 `(dsh-relay-upstream)` 段；见 [relay-host.md](relay-host.md) 第 3 节 |
| 中继上出现了 `gateway.port` 之外的 HTTP 监听 | 别的服务后来被装上来了（多一条读到会话 Cookie 的路） | 中继 `ss -ltnp`；能用别的方式提供服务就撤掉这个端口，否则必须接受这条风险 |
| 页面能开但对话不刷新 | 长连接被中间设备或 `stream_timeout` 切断 | 中继访问日志里该连接的耗时；`stream_timeout` 已设为 24h，运营商也会切断空闲连接，DSH 客户端会重连 |

**一条通用原则**：403 与 401 的区分是最有用的信号。403 永远是权威问题，401 永远是凭据问题。这个区分来自 DSH 自身的设计，本插件只是把它在启动时主动暴露出来。

## 必须本地完成的操作

设置卡片在远程页面上是只读的（原因见 [security.md](../security.md) 的已知限制）。下面这些只能在服务器本机的 loopback 页面上做：

| 操作 | 位置 |
| --- | --- |
| 改部署参数（地址、账号、网关口令） | 本机页面 ▸ 设置 ▸ 插件 ▸ Web Relay ▸ 保存 |
| 重新引导 / 重新拉起隧道 / 轮换书签 | 同上，三个按钮 |
| 作废全部 DSH 会话 Cookie | 本机，删 `$DSH_HOME/.credentials.yaml` 里的 `client-connection/browser-session` 记录后重启 profile |
| 改权限的**默认**预设、模型与模型设置、导入导出设置 | 本机，本地浏览器打开 `dsh web` |
| 中继侧的任何手工改动 | SSH 到中继主机 |

## 运行手册

### 改部署参数（本机页面）

在卡片里改字段、点保存。插件在 `onChange` 里规范化，并按 [configuration.md](../configuration.md) 的"改动的影响面"表决定要重做什么：地址变化重算权威并重新引导，口令变化重新哈希，隧道参数变化重连。**不需要编辑 YAML，也不需要重启 `dsh web`。**

### 换网关口令

卡片里改 `gateway.password` 并保存，插件重跑引导第 8–9 步：重新计算 bcrypt 哈希、重写 Caddyfile、`caddy validate` 通过后 reload。同时要换掉会话 Cookie 的比对值 `gateway.sessionSecret`，否则已拿到旧 Cookie 的客户端继续免密——重新引导时这个值默认保持不变（避免无谓地让手机重新登录），因此换口令时要在记录里把它清空，或直接重启一次引导。手机需要在 Safari 里清除该站点数据，否则会用缓存里的旧凭据自动重试并一直失败。

引导不可用时的手工等价操作：

```
# 中继主机
caddy hash-password --plaintext        # 交互输入新口令，输出 bcrypt 串
vim /etc/caddy/Caddyfile               # 替换托管块里的 basic_auth 哈希
caddy validate --config /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile
```

注意下一次"重新引导"会用设置里的口令覆盖手工改动，因此手工改完也要把卡片里的口令一起改掉，两边保持一致。

### 轮换入口口令

卡片上点"轮换书签"。插件生成新的 `entryKey`，旧书签立刻 404，需要重新收藏。不依赖远程访问是否可用——"需要轮换"的场景往往就是"远程访问出了问题"。

卡片用不了时的等价操作：

```
# 内网主机，先停掉 dsh web
# 编辑 $DSH_HOME/settings.yaml，清空 web-relay-record 的 entryKey
# 重新启动 dsh web --profile web，横幅会打印新口令
```

### 作废全部会话

```
# 内网主机，先停掉 dsh web
# 编辑 $DSH_HOME/.credentials.yaml，删除 client-connection/browser-session 这条记录
# 重新启动 dsh web --profile web
```

重启本身**不足以**作废 Cookie——签名密钥是持久化的凭据记录，只有删掉它才会轮换。所有设备都需要重新走一次 `/relay/enter`。

### 轮换中继的隧道公钥

由引导完成，不需要手工操作：清空记录的 `state` 并点"重新引导"，第 1 步发现私钥已存在会跳过生成，第 5 步用托管块替换 `authorized_keys` 那一行。要换掉钥匙本身，先删掉 `$DSH_HOME/dsh-web-relay/ssh/relay_ed25519` 再重新引导——第 1 步会生成新的密钥对，第 5 步把新公钥写进托管块。旧公钥随托管块一起消失，因此不需要单独回收。

### 换公网地址 / 权威

1. 卡片里改 `vps.host` 或 `gateway.port` 并保存。
2. 插件重算权威、重解析 `connection` 行、重新引导（Caddy 站点地址、证书、`permitlisten` 都跟着新地址走）。
3. 客户端更新书签。

**换权威会让所有旧 Cookie 立刻失效**，因为 Cookie 的名字与签名负载都绑定权威。这是设计使然，不是缺陷。

### 续签 TLS 证书

Caddy 用内置签发者自动续签，90 天的有效期在此之上留了足够余量，正常情况不需要手工动作。"客户端不再信任证书"时通常是根证书被重新生成过（例如换过权威），这时重新取一次 `/relay/ca.crt` 并核对卡片上的指纹即可。

### 卸载后清理中继

`dsh plugin --profile web remove dsh-web-relay` 只影响内网主机。中继上留下的东西要手工删：

```
# 中继主机
# 1. 删掉 authorized_keys 里的托管块
rm -f /etc/dsh-web-relay/authorized_keys        # 或删掉引用它的那一行
# 2. 删掉 sshd 片段并重载
rm -f /etc/ssh/sshd_config.d/60-dsh-web-relay.conf
sshd -t && systemctl reload ssh
# 3. 删掉 Caddyfile 里的托管块并重载
caddy validate --config /etc/caddy/Caddyfile && caddy reload --config /etc/caddy/Caddyfile
# 4. 删掉 CA 与账号
userdel -r relay
```

隧道是内网主机主动拨出的，所以删掉 `authorized_keys` 那一行之后，隧道会在下一次重连时**立刻**失败——这是最快的收回方式。

### 升级 DSH

升级后必须对照两件事：

1. `@deepseek-ai/dsh-client-connection` 的 `connection` 行是否新增了配置 key。patch 替换的是整行 `config`，新增的 key 会在本插件的覆盖下回落到默认值。
2. 权威围栏与 Cookie 命名规则是否变化（`api-request-trust.ts` / `browser-auth.ts`）。这两个文件是本设计依赖的接口，发布说明里若有相关改动就要重读。

插件自身用 peer 依赖的版本范围约束这两个包，但版本范围只能保证"装的是兼容版本"，不能保证"配置 key 没变"。

## 容量与限额

| 项 | 设计值 | 说明 |
| --- | --- | --- |
| 隧道子进程数 | 1 | 单实例；重连前必须确认旧句柄已 `done` |
| 重连退避上限 | 30s | 稳定失败时以 30s 周期重试，不刷屏 |
| 隧道 stderr 保留 | 每进程最后 8 KiB | 只进日志摘要，不落盘 |
| 入口口令失败计数 | 20 次 / 15 分钟（进程内） | 防误触；真正的爆破防护在中继的 fail2ban |
| 单个引导步骤上限 | 120s（`bootstrap.stepTimeoutMs`） | 覆盖 `apt` 安装；超时即判该步失败 |
| fail2ban | 5 次 / 10 分钟 → 封 1 小时 | `bantime.increment` 可选 |
| 会话 Cookie | 30 天（DSH 默认） | 改 `connection` 行的 `cookieMaxAgeDays` 可调整 |
| 网关 Cookie（`cookie` 模式） | 30 天 | 与上一条对齐，避免两者错位造成"一会能开一会不能" |
| 中继证书有效期 | 90 天（Caddy 内置签发者，插件显式覆盖） | 自动续签 |
| 长连接上限 | 24h（`stream_timeout`） | 到期后客户端重连 |

单用户场景下这些值都不需要调优；它们的作用是让异常（重连风暴、爆破）有一个已知的上界。

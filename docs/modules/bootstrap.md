# 自动引导

引导是插件用管理账号在中继主机上把服务配置好的一串幂等动作。用户要做的只有在设置 ▸ 远程访问页填好参数并点一次「部署」；之后中继上的 `sshd` 加固、受限账号、Caddy、证书、DSH 的权威注册与隧道拉起都由插件完成。

## 触发时机

| 时机 | 行为 |
| --- | --- |
| 用户在设置 ▸ 远程访问页点一次「部署」 | 把表单值一次性写进 `web-relay`，跑一次完整引导（第 0–13 步） |
| `$DSH_HOME/settings.yaml` 被改成不同的值 | 走同一条提交路径：任何一次真实的文档变更都跑一次完整引导，手工编辑与点部署等效 |
| 启动 profile，且「随 DSH 启动自动部署」打开（`deploy.autoDeploy`）、上次部署成功（记录 `state === 'ready'`） | 自动跑一次完整引导，与点部署完全一样（第 0–13 步）；一次启动最多跑一次，引导失败就停在失败上，不重试 |
| 启动 profile，且开关关着或记录不是 `ready`（从未部署成功，包括上次部署失败） | **不部署、不起隧道**：只把当前权威注册进 Host/Origin 围栏，再补一次回环自检（从 `127.0.0.1` 打一次 `/api`，期望 401）并打一行结论；公网入口返回中继那行"隧道未连接"的 502 |
| `Deployment` 不齐全（缺少 `vps.host` 或 `gateway.password`） | 不引导，记录显示等待配置 |

引导只在**服务器本机**触发，因为设置页只在 loopback 页面上注册，见 [settings.md](settings.md)。

## 命令通道

引导的每一条远程命令都是一次独立的 `ssh` 调用，不复用控制连接、不留 socket。进程用 `ctx.subprocess.spawn` 起，`stdio` 的 stdout/stderr 走有界收集，stdin 按下面三种形态之一提供。

所有调用共享的选项：

```
-o UserKnownHostsFile=$DSH_HOME/dsh-web-relay/ssh/known_hosts
-o StrictHostKeyChecking=yes
-o BatchMode=yes
-o ConnectTimeout=<bootstrap.connectTimeoutSec>
-o NumberOfPasswordPrompts=0
-o LogLevel=ERROR
-i <vps.identityFile>            （仅当设置里给了路径）
-N 之外的每一次调用都是命令模式，不用 -N
```

**普通脚本。** 命令是 `sh`，脚本全文走 stdin。脚本里只出现非密信息。

**提权脚本。** 命令是 `sudo -n sh`，脚本全文走 stdin。`-n` 强制非交互：账号免密时直接执行，需要口令时立即失败并报出 `sudo: a password is required`，不会挂起等一个永远不来的输入。管理账号是 `root`（或 `id -u` 报 0）时不用 `sudo`，脚本直接交给 `sh`。

## 托管块

插件在中继上只写三处内容，每处都用带标记的块，块外内容原样保留：`/home/relay/.ssh/authorized_keys`、`/etc/ssh/sshd_config.d/60-dsh-web-relay.conf`（或主配置里的同名块）、`/etc/caddy/Caddyfile`。

每个块由同一段脚本模板写入：先 `awk` 过滤掉旧块得到临时文件，再用**引号定界的 heredoc** 追加新块（引号定界保证块内容零展开），补一个结尾换行后 `install` 到目标路径并设权限，最后删临时文件。写完之后插件立刻把文件读回来比对块内容，比对失败即判该步失败——静默写入失败比写入失败更难查。

## 步骤

每一步都有 id、标题、状态（`ok` / `failed` / `skipped`）与一段原文摘要，写进 `web-relay-record.steps`。任何一步硬失败即停止本次引导，记录 `state: 'failed'`。

| # | 步骤 | 幂等依据 | 失败后果 |
| --- | --- | --- | --- |
| 0 | 本地工具检查 | 只读 | 缺 `ssh` / `ssh-keygen` / `scp` 时停在这里，报出缺哪个 |
| 1 | 生成中继密钥对 | 私钥文件存在即跳过 | 停在这里，公钥没生成 |
| 2 | 固定中继主机密钥 | `known_hosts` 已有该主机即比对 | 指纹与用户给定值不符时停下，不建立任何后续连接 |
| 3 | 管理连接与能力探测 | 只读 | 密钥被拒 / 不可达 / 无免密 sudo / 缺 `ss` 时停在这里，报 `ssh` 原文 |
| 4 | 创建受限账号 `relay` | `getent passwd relay` 命中即跳过 | 停在这里，隧道账号不存在 |
| 5 | 写 `authorized_keys` 托管块 | 块级替换 | 停在这里；已有内容不受影响 |
| 6 | 写 `sshd` 片段并校验重载 | 块级替换 + `sshd -t` | `sshd -t` 不通过就不重载，回滚该文件 |
| 7 | 安装 Caddy 与 fail2ban | `command -v caddy` / `command -v fail2ban-server` 命中即跳过 | Debian/Ubuntu 之外停在这里，打印需要手动执行的命令 |
| 8 | 计算网关口令哈希 | 每次都重算（口令可能刚改） | 停在这里，Caddyfile 不更新 |
| 9 | 写 Caddyfile、格式化、校验并 reload，再写 Caddy 侧 fail2ban filter 与 jail 并 reload fail2ban | 块级替换 + `caddy validate` | 校验不通过就不重载，公网入口保持旧配置 |
| 10 | 取回 CA 根证书 | 文件已存在即跳过取回 | 停在这里；服务仍可用，只是拿不到根证书 |
| 11 | 注册权威并自检 | 幂等赋值 | 停在这里，手机打开会 403 |
| 12 | 拉起隧道 | 见 [tunnel.md](tunnel.md) | 停在这里，公网入口返回隧道不可达页面 |
| 13 | 公网自检、报告中继对外监听并输出访问地址 | 只读 | 记录里标出每一跳观察到的状态码与对外监听清单，服务可能已可用 |

### 0–3 建立可信连接

`ssh-keyscan -p <port> -t ed25519,rsa,ecdsa <host>` 的输出写进一个临时 `known_hosts`，用 `ssh-keygen -lf` 算出 `SHA256:` 指纹并打印到日志。设置里给了 `vps.hostKeyFingerprint` 就逐字比对，不符立刻停止；没给就按 TOFU 接受，把指纹写进记录并高亮提示——这一步是整条链上唯一一次机会让用户核对指纹，所以无论哪种情况都把指纹摆到最显眼的位置。

此后每次调用都用 `StrictHostKeyChecking=yes`，而 `known_hosts` 里只有这一台主机，因此后续连接全部是严格校验的。

探测命令读 `id -u` 与 `/etc/os-release` 的 `ID`/`VERSION_ID`，并试跑 `sudo -n true` 与 `command -v ss`，据此决定：是否走 `sudo`、包管理器是 `apt` 还是 `dnf`、`sshd` 的单元名是 `ssh` 还是 `sshd`，以及转发前预检能不能在中继上跑。三者中任何一条不成立都在这里停下并报原文：密钥被拒、`sudo` 需要口令、`ss` 不在。

同一次探测还读一遍 `SSH_CONNECTION` 的第一个字段，也就是内网主机在这一跳上对外的地址。它在**提权之前**读（`sudo` 会把 `SSH_CONNECTION` 清掉），第 9 步写 Caddy 侧 jail 时填进 `ignoreip`——公网自检本身会让 Caddy 记一次 `basic_auth` 失败，没有这一条，反复重启就可能把操作者自己封掉。取不到时留空，jail 退回默认封禁规则。

这条探测是"插件不配置管理登录"的兑现方式——公钥登录与免密 sudo 由用户事先准备好，插件只读地确认它们成立。探测不到已知发行版时如实报告"自动安装 Caddy 仅支持 Debian/Ubuntu"，其余步骤继续。

### 4–5 受限账号与隧道公钥

```
getent passwd relay || useradd --create-home --shell /usr/sbin/nologin relay
install -d -m 0700 -o relay -g relay /home/relay/.ssh
```

`authorized_keys` 的块内容只有一行：

```
restrict,port-forwarding,permitlisten="127.0.0.1:18080" ssh-ed25519 <本机中继公钥> dsh-web-relay
```

`restrict` 关掉 pty、agent、X11、exec 与全部转发，`port-forwarding` 只把转发能力还回来；`permitlisten` 把能监听的目标钉死在 loopback 的 `tunnel.relayPort` 上。

### 6 sshd 片段

Debian/Ubuntu 的 `sshd_config` 里有 `Include /etc/ssh/sshd_config.d/*.conf` 时写 `/etc/ssh/sshd_config.d/60-dsh-web-relay.conf`，否则写同一段内容到主配置的托管块里。

```
Match User relay
    AllowTcpForwarding remote
    PermitOpen none
    GatewayPorts no
    X11Forwarding no
    AllowAgentForwarding no
    PermitTunnel no
    PermitTTY no
    ClientAliveInterval 15
    ClientAliveCountMax 3
```

`AllowTcpForwarding remote` 只允许远端口转发（内网主机拨出要的正是这个），`PermitOpen none` 禁掉本地转发，`GatewayPorts no` 保证监听不绑到公网接口。`ClientAliveInterval 15` 与 `ClientAliveCountMax 3` 让对端已经消失的转发会话在约 45 秒内被丢弃，不然它会一直占着中继上的监听端点。

校验顺序是硬的：先 `sshd -t`，通过才 `systemctl reload ssh`。`sshd -t` 不通过就不重载并回滚文件——一台把自己锁在门外的中继比没配置好的中继糟得多。重载后再用 `sshd -T -C user=relay,host=relay,addr=127.0.0.1` 读一遍生效值，逐个确认 `gatewayports`、`permitopen`、`allowtcpforwarding`、`permittty`、`clientaliveinterval`、`clientalivecountmax`、`unusedconnectiontimeout` 七项；`unusedconnectiontimeout` 是全局选项，不能写进 `Match` 块，引导只报它的生效值 `none`，不设它，命令原文见 [relay-host.md](relay-host.md)。

### 7 安装 Caddy 与 fail2ban

`command -v caddy` 命中即跳过 Caddy 安装，`command -v fail2ban-server` 命中即跳过 fail2ban 安装，两者独立判断。Debian/Ubuntu 上走 Caddy 官方 apt 仓库：

```
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
systemctl enable --now caddy
```

Ubuntu 26.04 的 universe 里有 `caddy 2.6.2-14`，而这个 `deb … any-version main` 源发布 2.11.4，`apt` 按版本取胜，因此最终装到的是 2.11.4。全新的 26.04 主机上既没有 `caddy` 可执行文件也没有 `/etc/caddy` 目录，两者都由这个包提供。

那两条 `chmod o+r` 来自官方安装说明，不是可省的客套：Caddy 以 `caddy` 账号运行，密钥环与源列表不可读时会牵连后续的 `apt` 操作。

走包管理器而不是下载静态二进制，是为了白拿三样东西：systemd 单元、`caddy` 账号、`/var/lib/caddy` 数据目录。Caddy 的本地 CA 就落在那个数据目录里，手写单元和自建账号反而更容易出错。

fail2ban 用发行版包（`apt-get install -y fail2ban`）即可，`deploy/fail2ban/` 里的 filter 与 jail 依赖它的 `filter.d` / `jail.d` 目录约定。

其他发行版停在这一步，并把需要手动执行的等价命令打进 `detail`；用户装好后点一次「部署」即可继续。

### 8–9 网关口令与 Caddyfile

`caddy hash-password` 从 stdin 读明文，输出 `$2a$14$…`。明文不写文件、不进 argv、不出现在 Caddyfile 里。**stdin 必须以换行结尾**：不带结尾换行时命令报 `Error: EOF` 且不输出哈希，配成空字符串会让 Caddyfile 校验失败在一个看不出原因的地方。

站点内容由模板生成，权威、端口、端口哈希、会话密钥、`tunnel.relayPort` 是仅有的几个变量，完整文本见 [relay-host.md](relay-host.md)。写入按托管块进行，用户在这台机器上原有的其他站点行不受影响。模板里的上游片段带一行 `header_down Set-Cookie "$" "; Secure"`，它给 DSH 自己不下发 `Secure` 的 Cookie 补上这一位；这一行不能换成站点级 `header`，理由见 [relay-host.md](relay-host.md) 第 3 节。

写入前先检查块外是否已经存在全局选项块（`auto_https`、`pki`、`default_sni` 中的任意一项）。Caddy 只允许一个全局选项块，用户已经有一个时托管块必然冲突；这种情况下停下并把检测到的那一行作为 `detail` 报出来，让用户自己去合并，插件不擅自改写别人的全局配置。具名片段 `(dsh-relay-upstream)` 的名字在整个文件里也必须唯一，以及块外已经存在监听 `gateway.port` 的站点时，都按同样的方式停下。

写完后先 `caddy fmt --overwrite`，再校验：`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`。校验要在 `caddy` 账号的环境里跑（`XDG_DATA_HOME=/var/lib/caddy/.local/share`、`XDG_CONFIG_HOME=/var/lib/caddy/.config`），否则本地 CA 的数据目录解析不到，校验会报出一个与配置无关的错。校验通过才 `systemctl reload caddy`；reload 是优雅的，失败时旧配置继续服务。

Caddy reload 之后，同一步再写 Caddy 侧的 fail2ban filter 与 jail（`deploy/fail2ban/`，端口与 `logpath` 由模板代入，`ignoreip` 里的本机出口地址来自第 3 步，见 [relay-host.md](relay-host.md) 第 3 节），然后 `fail2ban-client reload`。jail 写坏不会影响已经工作的入口，因此它的失败不阻断引导，只在步骤结果里标出。

### 10 CA 根证书

Caddy 的本地 CA 在配置装载时就生成，根证书在 `/var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/root.crt`。插件用提权读取它，写到 `$DSH_HOME/dsh-web-relay/ca/root.crt`（`0644`，公开信息），并用 `openssl x509 -noout -fingerprint -sha256` 算出指纹写进记录。

站点块里 `lifetime 2160h` 与 `intermediate_lifetime 8760h` 必须成对出现：叶子的有效期被中间证书截断，只覆盖叶子时实测仍只有 7 天。

文件还没出现时（配置装载与 CA 生成之间的时间差）重试若干次；仍不出现就用一次本地 TLS 握手逼出签发：`openssl s_client -connect 127.0.0.1:<gateway.port> -servername <vps.host>`。

### 11 注册权威

`publicAuthority` 是 `<vps.host>:<gateway.port>`。插件用 DSH 自己的权威解析规则校验它的形状，不合格时把 DSH 的原话报出来——`trustedHosts` 里放一个带 scheme 或带路径的串不会在启动时报错，只会在运行时被丢掉，最后表现成手机 403。

校验通过后按 [trust.md](trust.md) 重解析 `connection` 行，并立刻跑一次本机自检：请求 `http://127.0.0.1:<dshPort>/` 并带上 `Host: <publicAuthority>`，期望不是 403。

### 12–13 隧道与公网自检

隧道按 [tunnel.md](tunnel.md) 拉起，等它活过 `tunnel.healthyAfterMs` 再判成功。随后做一次真实公网请求：`curl -sS -o /dev/null -w '%{http_code}' https://<publicAuthority>/`，带上第 10 步取回的根证书作 `--cacert`；根证书没取到时退回 `-k` 并把这一点写进记录，因为这条证据这时只说明"链路上有人应答"，不说明对端身份。期望 401（未带网关口令）或 200（带了）。

公网探测之后，第 13 步再在中继上跑一次 `sudo -n ss -ltnpH`，把结果追加进该步记录的 `detail`，写成 `中继对外监听：…`。本地地址落在 `127.0.0.0/8` 或等于 `[::1]` 的监听被跳过，其余一律列出——`*:8443`、`0.0.0.0:22`、`[::]` 以及某个具体地址都会出现。验证过的中继上原始输出是 `*:80、*:8443、0.0.0.0:22、127.0.0.53%lo:53、127.0.0.54:53、[::]:22`，过滤后的清单是 `*:80、*:8443、0.0.0.0:22、[::]:22`。

最后写完整记录，并向 stdout 打印一行 `dsh-web-relay: https://<publicAuthority>/`；逐步进度走 harness 日志，权威、CA 指纹、隧道 PID 与本次引导的步骤摘要都落在记录里。

## 重入与部分失败

每一步都设计成可以重复执行，所以一次部署就是把整串从头再跑一遍，不需要游标。已就绪的步骤只花几次 `ssh` 往返；唯一昂贵的一步是安装 Caddy，它由 `command -v caddy` 挡住。

中途失败时，已经写下的东西保留在原来的状态：托管的块要么是旧的要么是新的（写入是"临时文件 + install"的原子替换），`sshd` 与 Caddy 只在校验通过后才 reload。用户看到的是一张逐步表、失败那一步的原文摘要，和一个「部署」按钮。

## 不进日志、不进 argv 的东西

| 材料 | 传输方式 | 落盘位置 |
| --- | --- | --- |
| `gateway.password` | `caddy hash-password` 的 stdin | 只在 `settings.yaml`（`0600`）；中继上只有 bcrypt 哈希 |
| 中继私钥 | 不传输（生成在本机） | `$DSH_HOME/dsh-web-relay/ssh/`（`0600`） |
| 中继公钥、端口、模板文本 | 脚本 stdin 或 argv | 中继上的托管块 |
| `gateway.sessionSecret` | 由插件生成 | `settings.yaml` 的记录命名空间（`0600`） |

日志是 `scrubbedParentEnv` 之下的子进程 stderr 有界收集加上插件自己的日志行，两者都不含 `gateway.password`；脚本模板里也不含，所以即使日志级别被调高也不会漏。管理登录走密钥，插件手里没有可以漏的管理口令。

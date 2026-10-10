# 实现：引导

引导是插件用管理账号在中继主机上把服务配置好的一串幂等动作。它覆盖第 0–10 步；第 11–13 步（注册权威、拉起隧道、公网自检）由 `service.ts` 按顺序接手。

## 触发时机

| 时机 | 行为 |
| --- | --- |
| 在设置页点一次「部署」 | 把表单值一次性写进配置，跑一次完整引导 |
| profile 补丁里的 `deployment` 被改成不同的值 | 同一条提交路径，与点部署等效 |
| 启动 profile，开关打开且上次部署成功 | 自动跑一次完整引导；一次启动最多一次，失败不重试 |
| 启动 profile，开关关着或上次不是成功态 | 不部署、不起隧道，只注册权威并补一次回环自检 |
| `Deployment` 不齐全 | 不引导，记录显示"等待配置" |

引导只在服务器本机触发，因为设置页只在 loopback 页面上注册。

## 命令通道

每条远程命令都是一次独立的 `ssh` 调用（一个联网步骤一条），但整轮**复用同一条 TCP 连接**。进程用 DSH 的 `ctx.subprocess.spawn` 起，stdout/stderr 走有界收集（保留尾部，因为 `ssh` 的报错在尾部），stdin 有三种形态：

- **普通脚本**：命令是 `sh -s`，脚本全文走 stdin。
- **提权脚本**：命令是 `sudo -n sh -s`，脚本全文走 stdin。`-n` 强制非交互：免密时直接执行，需要口令时立即失败并报出 `sudo: a password is required`，不会挂起等一个永远不来的输入。
- **单条命令**：例如第 8 步的 `caddy hash-password`。

所有调用共享的选项：

```
-o UserKnownHostsFile=$DSH_HOME/dsh-web-relay/ssh/known_hosts
-o StrictHostKeyChecking=yes
-o BatchMode=yes
-o NumberOfPasswordPrompts=0
-o LogLevel=ERROR
-o ConnectTimeout=<bootstrap.connectTimeoutSec>
-o ControlMaster=auto                       （管理路径；隧道不带这三项）
-o ControlPath=$DSH_HOME/dsh-web-relay/ssh/cm/%C
-o ControlPersist=60
-i <vps.identityFile>                       （仅当设置里给了路径）
```

`ControlMaster`、`ControlPath`、`ControlPersist` 与 `BatchMode` 同级列入保护选项，`tunnel.extraOptions` 改不掉它们。

### 为什么复用连接

一次引导要开十几条短命令，而到中继的路径可能丢包。独立握手越多，整轮失败率越高：单连接失败率 25% 时十几条全部成功只有约 3%，失败率 12% 时约 22%。这正是失败总停在**随机**步骤的原因，而不是某一步有缺陷。复用之后整轮成功率在 25% 丢包下从约 3% 升到约 75%。

几个刻意的取舍：

- **用 `auto` 而不是 `yes`。** 套接字文件还在但 master 已死时，`auto` 退回直连，`yes` 直接报错。
- **`ControlPersist=60`。** 空闲 60 秒后 master 自行退出并删掉套接字；一次引导的十几条命令集中在几十秒内跑完，够覆盖整轮，又不留长期后台进程。
- **用 `%C` 而不是自己拼 `user@host:port`。** `%C` 是「本机、远端、端口、账号」的短哈希，因此管理账号与隧道的 `relay` 账号天然落在两个套接字上，键名里也不含可读的主机名与账号。
- **套接字目录必须预先存在。** 目录缺失时 `ssh` 不是回退而是直接以 255 失败，所以 `ssh/cm`（`0700`）在启动与每次部署前都会补建。
- **路径放不下就退回直连。** `ControlPath` 是 unix 套接字路径，`%C` 展开后达到 108 字节时 `ssh` 在连上之前就拒绝启动。`adminTarget` 按展开长度检查——复用是优化，直连才是保底。
- **隧道不共用。** 它是常驻进程，挂在一条为"十几条短命令"设计的 master 上会让隧道重连与管理脚本互相牵连。

## 托管块

插件在中继上只写四处内容，前两处是托管块，块外内容原样保留：

| 位置 | 所有权约定 |
| --- | --- |
| `/home/relay/.ssh/authorized_keys` | 托管块（`# BEGIN dsh-web-relay` … `# END dsh-web-relay`） |
| `/etc/ssh/sshd_config.d/60-dsh-web-relay.conf`（或主配置里的同名块） | 托管块 |
| `/etc/caddy/Caddyfile` | 托管块（放在文件最前面，因为全局选项块必须是第一个） |
| `/etc/fail2ban/{filter.d,jail.d}/caddy-dsh-relay.conf` | 整文件；首行没有 `dsh-web-relay` 标记时停下、不覆盖 |

托管块由同一段脚本模板写入：用 `awk` 过滤掉旧块得到"块外内容"，再用**引号定界的 heredoc** 追加新块（引号定界保证块内容零展开），补一个结尾换行后 `install` 到目标路径并设权限，最后把文件读回来比对块内容。比对失败即判该步失败——静默写入失败比写入失败更难查。

声明了校验命令的目标（`sshd -t`、`caddy validate`）会先备份目标，校验不通过就恢复备份并以退出码 5 失败，因此同一段脚本里跟在后面的 `systemctl reload` 根本不会执行。这是"先验证再重载，验证不过就回滚"的实现方式。

## 步骤

每一步都有 id、标题、状态（完成 / 失败 / 未执行）与一段原文摘要，写进运行记录的 `steps`。任何一步硬失败即停止本次引导，记录 `state: 'failed'`，其后的步骤标为"未执行"。

| # | 步骤 | 幂等依据 | 失败后果 |
| --- | --- | --- | --- |
| 0 | 本地工具检查 | 只读 | 缺 `ssh` / `ssh-keygen` / `ssh-keyscan` / `openssl` 时停在这里，报出缺哪个 |
| 1 | 生成中继密钥对 | 私钥文件存在即跳过（并核对公钥） | 停在这里，公钥没生成 |
| 2 | 固定中继主机密钥 | `known_hosts` 已有该主机即比对 | 指纹与用户给定值不符时停下，不建立任何后续连接 |
| 3 | 管理连接与能力探测 | 只读 | 密钥被拒 / 不可达 / 无免密 sudo / 缺 `ss` / 缺 `systemctl` / 找不到 sshd 单元时停在这里 |
| 4 | 创建受限账号 `relay` | `getent passwd relay` 命中即跳过 | 停在这里，隧道账号不存在 |
| 5 | 写 `authorized_keys` 托管块 | 块级替换 | 停在这里；已有内容不受影响 |
| 6 | 写 `sshd` 片段并校验重载 | 块级替换 + `sshd -t` | `sshd -t` 不通过就不重载，回滚该文件 |
| 7 | 安装 Caddy 与 fail2ban | `command -v` 命中即跳过，两者独立判断 | 非 Debian/Ubuntu 停在这里，打印需要手动执行的命令 |
| 8 | 计算网关口令哈希 | 每次都重算（口令可能刚改） | 停在这里，Caddyfile 不更新 |
| 9 | 写 Caddyfile、格式化、校验并 reload；再写 Caddy 侧 fail2ban 规则 | 块级替换 + `caddy validate` | 校验不通过就不重载，公网入口保持旧配置 |
| 10 | 取回 CA 根证书 | 每次都读一次并覆盖本机副本 | 停在这里；服务仍可用，只是拿不到根证书 |
| 11 | 注册权威并自检 | 幂等赋值 | 停在这里，设备打开会 403 |
| 12 | 拉起隧道 | 见 [tunnel.md](tunnel.md) | 停在这里，公网入口返回隧道不可达页面 |
| 13 | 公网自检、报告中继对外监听、输出访问地址 | 只读 | 记录里标出每一跳观察到的状态码与对外监听清单 |

### 0–3 建立可信连接

第 2 步用 `ssh-keyscan` 取回中继主机公钥写进本机专用的 `known_hosts`，用 `ssh-keygen -lf` 算出 `SHA256:` 指纹并打印。设置里给了期望指纹就逐字比对，不符立刻停止；没给就按 TOFU 接受，把指纹写进记录并高亮提示——这是整条链上唯一一次机会让用户核对指纹，所以无论哪种情况都把它摆在显眼位置。此后每次调用都 `StrictHostKeyChecking=yes`，而 `known_hosts` 里只有这一台主机。

第 3 步的探测只输出 `KEY=VALUE`，读 `id -u`、`/etc/os-release`、`ss` / `apt-get` / `systemctl` 是否可用、`sudo -n true` 是否成功、`sshd_config` 是否 `Include` 了 `sshd_config.d`、以及 sshd 的单元名是 `ssh` 还是 `sshd`。据此决定是否走 `sudo`、包管理器是否可用、以及后续写到哪个路径。

同一次探测还读一遍 `SSH_CONNECTION` 的第一个字段，也就是内网主机在这一跳上对外的地址。它在**提权之前**读（`sudo` 会把它清掉），第 9 步写 Caddy 侧 jail 时填进 `ignoreip`——公网自检本身会让 Caddy 记一次口令失败，没有这一条，反复重启就可能把操作者自己封掉。取不到时留空，jail 退回默认封禁规则。

这一步是"插件不配置管理登录"的兑现方式：公钥登录与免密 sudo 由用户事先准备好，插件只读地确认它们成立。

### 4–5 受限账号与隧道公钥

```
getent passwd relay || useradd --create-home --shell /usr/sbin/nologin relay
install -d -m 0700 -o relay -g relay /home/relay/.ssh
```

`authorized_keys` 的块内容只有一行：

```
restrict,port-forwarding,permitlisten="127.0.0.1:<relayPort>" ssh-ed25519 <本机中继公钥> dsh-web-relay
```

`restrict` 关掉 pty、agent、X11、exec 与全部转发，`port-forwarding` 只把转发能力还回来，`permitlisten` 把能监听的目标钉死在 loopback 的转发端口上。

### 6 sshd 片段

`sshd_config` 里有 `Include /etc/ssh/sshd_config.d/*.conf` 时写 `/etc/ssh/sshd_config.d/60-dsh-web-relay.conf`，否则写同一段内容到主配置的托管块里。片段内容与逐条理由见 [relay-host.md](relay-host.md#sshd_config-片段)。

重载后再用 `sshd -T -C user=relay,host=relay,addr=127.0.0.1` 读一遍生效值并写进步骤说明，逐个确认七个选项。

### 7 安装 Caddy 与 fail2ban

`command -v caddy` 与 `command -v fail2ban-server` 分别判断，命中即跳过对应安装。Debian/Ubuntu 上走 Caddy 官方 apt 仓库：

```
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg ca-certificates
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
systemctl enable --now caddy
```

那两条 `chmod o+r` 来自官方安装说明：Caddy 以 `caddy` 账号运行，密钥环与源列表不可读时会牵连后续的 `apt` 操作。

走包管理器而不是下载静态二进制，是为了白拿 systemd 单元、`caddy` 账号与 `/var/lib/caddy` 数据目录——Caddy 的本地 CA 就落在那里，手写单元和自建账号反而更容易出错。

fail2ban 用发行版包即可，`deploy/fail2ban/` 里的 filter 与 jail 依赖它的目录约定。

### 8–9 网关口令与 Caddyfile

`caddy hash-password` 从 stdin 读明文，输出 `$2a$14$…`。明文不写文件、不进 argv、不出现在 Caddyfile 里。**stdin 必须以换行结尾**：不带结尾换行时命令报 `Error: EOF` 且不输出哈希。

站点内容由模板渲染，变量只有权威、主机名、网关端口、转发端口、会话密钥与 bcrypt 哈希。写入按托管块进行。写入前先检查块外是否已经存在全局选项块（`auto_https`、`pki`、`default_sni` 中的任意一项）、是否已有同名具名片段、是否已有站点监听同一端口；命中任何一条就停下并报出那一行，让用户自己合并。

写完先 `caddy fmt --overwrite`，再校验：`caddy validate` 要在 `caddy` 账号的数据目录环境下跑（`XDG_DATA_HOME=/var/lib/caddy/.local/share`、`XDG_CONFIG_HOME=/var/lib/caddy/.config`），否则本地 CA 的数据目录解析不到，校验会报一个与配置无关的错。校验通过才 `systemctl reload caddy`；reload 是优雅的，失败时旧配置继续服务。

Caddy reload 之后再写 Caddy 侧的 fail2ban filter 与 jail 并 reload fail2ban。jail 写坏不会影响已经工作的入口，因此它的失败不阻断引导，只在步骤结果里标出。

### 10 CA 根证书

Caddy 的本地 CA 在配置装载时生成，根证书在 `/var/lib/caddy/.local/share/caddy/pki/authorities/dsh-relay/root.crt`。插件用提权读取它，写到本机的 `ca/root.crt`（`0644`），并用 `openssl x509 -noout -fingerprint -sha256` 算出指纹。

文件还没出现时（配置装载与 CA 生成之间的时间差）重试若干次；仍不出现就用一次本地 TLS 握手把签发逼出来。

站点块里叶子的有效期与中间证书的有效期必须**成对**出现：叶子的有效期会被中间证书的上限截断，只覆盖叶子时站点证书仍只有 7 天。

## 重入与部分失败

每一步都设计成可以重复执行，所以一次部署就是把整串从头再跑一遍，不需要游标。已就绪的步骤只花几次 `ssh` 往返；唯一昂贵的一步是安装 Caddy，由 `command -v` 挡住。

中途失败时，已经写下的东西保留在原来的状态（托管文件要么是旧的要么是新的，`sshd` 与 Caddy 只在校验通过后才 reload）。用户看到的是一张逐步表、失败那一步的原文摘要，和一个「部署」按钮。

## 不进日志、不进 argv 的东西

| 材料 | 传输方式 | 落盘位置 |
| --- | --- | --- |
| 网关口令 | `caddy hash-password` 的 stdin | 只在 profile 补丁（`0600`）；中继上只有 bcrypt 哈希 |
| 中继专用私钥 | 不传输（生成在本机） | `$DSH_HOME/dsh-web-relay/ssh/`（`0600`） |
| 中继公钥、端口、模板文本 | 脚本 stdin 或 argv | 中继上的托管块 |
| 网关会话密钥 | 由插件生成 | `$DSH_HOME/dsh-web-relay/record.json`（`0600`）；不出网 |

日志是清洗过环境的子进程 stderr 有界收集加上插件自己的日志行，两者都不含口令；脚本模板里也不含，所以即使日志级别被调高也不会漏。

## 相关

- 中继上的目标状态与逐条理由：[relay-host.md](relay-host.md)
- 权威注册与自检：[public-entry.md](public-entry.md)
- 模板文件本身：`deploy/`，占位符清单见 `deploy/README.md`

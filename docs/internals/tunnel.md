# 实现：隧道守护与转发前预检

隧道的职责是把中继主机上的 loopback 端口指回本机的 `dsh web` 端口，并在链路抖动的整个过程中保持这个映射可用，同时保证插件被卸载时不留残余进程。

## 复用

- `ctx.subprocess.spawn(spec)`：DSH 既有的子进程 seam。规格完全显式（`argv` / `cwd` / `stdio` / `graceMs` / `signal` / `env`，无默认值）。
- `ctx.timer`（由基础层提供）：定时器注册在 fiber 上，fiber 释放时自动清理。
- 系统自带的 OpenSSH 客户端：隧道协议实现。

本模块不引入任何 npm 依赖。

## 参数从哪来

隧道要连的是中继上的受限账号，用的是引导第 1 步生成的**本机专用私钥**，不是管理身份。

| 参数 | 来源 |
| --- | --- |
| 中继地址、SSH 端口 | 部署参数 `vps.host` / `vps.port` |
| 隧道登录账号 | 固定 `relay` |
| 隧道私钥 | `$DSH_HOME/dsh-web-relay/ssh/relay_ed25519` |
| 远端端点端口 | 包内 `tunnel.relayPort`（默认 `18080`）；必须与中继侧的转发限制和 Caddy 上游一致 |
| 本机目标端口 | `ctx.webServer.port`，每次连接前现取（端口可能由 OS 分配） |
| 重连退避、健康阈值、拆除宽限、附加选项 | 包内 `tunnel.*` |

但这条通路还有一处用到管理身份：转发前预检要用管理密钥连上中继做端口探测并在需要时清掉残留。因此"管理账号被撤销不影响隧道"只剩一半成立——端口空闲时隧道照旧建立，只有从端口残留里恢复才需要它。

## 子进程规格

`argv` 由配置拼出，逐项固定，不做 shell 拼接：

```
ssh
  -N                                  # 不执行远程命令，纯转发
  -T                                  # 不分配 pty
  -o ExitOnForwardFailure=yes         # 端口没绑上就退出，而不是"连上了但没转发"
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o RequestTTY=no
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile=<knownHostsFile>
  -o ConnectTimeout=<connectTimeoutSec>
  -o IdentitiesOnly=yes               # 只在指定了身份文件时
  -i <relay_ed25519>                  # 同上
  -R 127.0.0.1:<relayPort>:127.0.0.1:<dshPort>
  -p <sshPort> relay@<host>
  --
```

要点：

- `-N -T` 保证这条连接只做转发；`BatchMode=yes` 与 `StrictHostKeyChecking=yes` 一起把"首次连接询问指纹"变成**启动失败**而不是静默挂起等待输入。一个会等待 stdin 的守护进程在后台等于死锁。
- `knownHostsFile` 是本机专用文件，不复用 `~/.ssh/known_hosts`。它由引导第 2 步写入，之后由严格校验强制。
- 远程侧显式写 `127.0.0.1:<relayPort>` 而不是只写端口：绑定地址显式化，配合中继侧的 `GatewayPorts no` 与转发限制形成三道一致的约束。
- `stdio` 三个流都必须显式声明：`stdin: 'ignore'`、`stdout` 与 `stderr` 都是有界收集（8 KiB）且保留**尾部**——正好是 `ssh` 报错信息所在的位置，且不需要临时文件。
- `env` 写一项 `{ SSH_AUTH_SOCK: undefined }`。这一项是必要的：seam 会先清洗父环境（剥掉名字像密钥/口令的项与全部 `DSH_*`），但保留 `SSH_AUTH_SOCK`；不删掉它，`ssh` 仍可能从 agent 取到别的钥匙。
- `tunnel.extraOptions` 追加成额外的 `-o key=value`。与上表冲突的键以上表为准：那几项是安全与可用性的前提，不允许被覆盖。
- 隧道**刻意不复用**管理路径的连接复用：隧道是常驻进程，把它挂在一条为"十几条短命令"设计的 master 上，会让隧道重连与管理脚本互相牵连；而它的退避与 `ExitOnForwardFailure` 语义都需要独立管一条连接。

## 转发前预检

`sshd` 为反向转发绑的监听端点属于**中继上处理那次连接的会话子进程**。主机侧异常中断（断电、休眠、网络切换、NAT 重绑定）不发出 FIN，中继察觉不到对端已经消失，那个子进程会继续占着端口。中继的 sshd 片段设了保活，所以这种会话在约 45 秒内被丢弃、监听端点随之消失；在此之前任何新的反向转发都在服务端以 `bind: Address already in use` 失败，客户端因 `ExitOnForwardFailure=yes` 退出并进入退避。

因此每轮 spawn 之前先做一次预检：

```
1. 用管理身份连中继，问一次端口是否被占（不带特权）
2. 输出为空        → 端口空闲，直接 spawn
3. 输出非空        → 提权读出持有者 pid，核对它的可执行文件是 sshd 或 sshd-session，且属主是 relay
4. 核对通过        → 发信号清掉它，轮询（上限 2 秒）到端口消失，再 spawn
5. 核对不通过，或预检本身出错 → 不动手，记录原因，照常 spawn
```

只有第 3 步之后才需要 `sudo`：常见路径是端口空闲，那一段代码根本不碰提权。

`-n` 是有意的：账号免密时直接执行，需要口令时立即失败并记录为"未执行"，不会挂起等一个永远不来的输入。

**为什么清掉它是安全的。** 按前提，能建立反向转发的只有内网主机那把公钥，所以这个端口上的 sshd 端点只可能来自本部署的旧会话。预检不把这个推论当结论，而是逐条核对持有者：可执行文件必须是 `sshd` 或 `sshd-session`，进程属主必须是 `relay`。两条有一条不成立就停手——那个端口上可能是别的东西，清掉它属于越界。

这道核对限制的是**插件自己的失误**，不是攻击者：内网主机本来就持有管理私钥与中继上的免密提权能力，攻击者不需要经过预检。

**预检失败不是致命错误。** 它是一次修复，不是一道门。管理身份不可用（密钥被撤销、账号被禁用、`sudo` 需要口令、`ss` 没装）时预检记录原因后跳过，spawn 照常进行：端口空闲时隧道照旧建立，端口被占时按原有方式失败。

**不做开关。** 预检只在端口确实被占时动手，且只认"sshd + `relay` 属主"这一种持有者，因此不提供配置项；关掉它只会让残留退回人工清理。

远程命令是一段固定的 POSIX shell 片段，转发端口是里面唯一的变量，且在校验为合法端口号之后才拼进去。

## 状态机

| 当前状态 | 事件 | 下一状态 | 动作 |
| --- | --- | --- | --- |
| — | `start` | `starting` | 立即开始第一轮：转发前预检，然后 spawn |
| `starting` | 预检结束（空闲、已释放或跳过） | `starting` | 写 `lastPreflight`，继续 spawn |
| `starting` | spawn 成功 | `running` | 记录起算时间；启动健康计时 |
| `starting` | spawn 同步抛错 | `backing-off` | 记录退出摘要；取退避序列下一项 |
| `running` | 子进程结束（非 0 或信号） | `backing-off` | 记录退出码与 stderr 尾部 |
| `running` | 存活超过健康阈值 | `running` | 退避序列复位到第一项 |
| `backing-off` | 退避计时到 | `starting` | 重新预检并 spawn |
| 任意 | fiber 释放 | `stopping` → `stopped` | 见下文；不再重试 |

- **单实例**：任何时刻最多一个隧道子进程，预检子进程与它串行、不并发。每轮开始前必须确认上一轮的句柄都已经结束。
- **两种 `starting` 失败**：`spawn()` 同步抛错，或子进程立刻以非 0 退出（认证失败、端口被占）。两者都进入 `backing-off`。
- **退避**：默认 `[1000, 2000, 5000, 15000, 30000]` 毫秒，用尽后停在最后一项。稳定的失败（配置错、公钥不在中继上）会以 30 秒周期重试并把 stderr 打出来，一眼可见且不刷屏。
- **健康判据**：仅凭"进程还活着"不足够，因为 `ssh -N -R` 在转发建立后会长期存活——这没问题，`ExitOnForwardFailure=yes` 已经保证"转发没成功就退出"。因此用"存活超过健康阈值"作为重置退避的信号。这个判据是启发式的，所以退避序列必须有小起点，不能一上来就 30 秒。
- **首轮不等退避**：参数齐全时立即开始，因为部署末段的公网自检需要一个已经在走的隧道。

## 什么时候起、什么时候停

| 条件 | 行为 |
| --- | --- |
| 部署参数不齐全（缺地址） | 不起隧道，记录显示等待配置 |
| 引导走到第 12 步 | 起隧道，并等它活过健康阈值才判该步成功 |
| 启动时记录已是成功态且开关打开 | 自动跑一遍完整部署，隧道由那次部署的第 12 步建立 |
| 启动时开关关着，或上次不是成功态 | 不起隧道；公网入口返回隧道不可达页面，要点一次部署才恢复 |
| 连接参数变化（经一次部署） | 停掉旧子进程，用新参数重新起，不需要重启 profile |

隧道只在一次部署里被建立——人工点的那次，或启动自动跑的那次。它是一条活的连接，不随进程重启存活。

## 生命周期与释放

按防御性设计的既有要求（DSH 仓库的 `docs/defensive-patterns.md`，本插件遵循同一套约定），释放必须到达静默：

```ts
ctx.effect(() => {
  const setupAbort = new AbortController()          // 只关"启动/重连"这条线
  let child: SubprocessHandle | undefined           // 隧道子进程
  let preflight: SubprocessHandle | undefined       // 预检子进程
  let stopped = false

  const loop = async () => { /* 退避 → 预检 → spawn → 等结束/等进程范围为空 → 循环 */ }
  const run = loop()                                 // 首轮不 await；释放路径负责收敛

  return async () => {
    stopped = true
    setupAbort.abort()                               // 1. 先让重连循环停止产生新子进程
    for (const handle of [preflight, child]) {
      if (handle) {
        handle.terminate()                           // 2. 再终止活着的子进程
        await Promise.race([handle.done, handle.waitForExit()]).catch(() => {})   // 3. 谁先落地
        await waitForEmptyProcessRange(graceMs + 1000)                              // 4. 有界地等进程范围变空
      }
    }
    await run.catch(() => {})                        // 5. 等循环自身落到终态
  }
})
```

顺序是有要求的：先关掉"会产生新子进程"的那条线，再终止已有的，最后等所有 await 落地。反过来的话，循环可能在终止与确认范围为空之间又起一个新的，那个子进程将不属于任何人的清理范围。两种子进程都要走这一遍。

拆除的等待是**有界**的：先中断循环，再对当前句柄发终止信号，然后以宽限加 1 秒为上限等这个进程范围变空。必须等到它真的消失，是因为转发的监听端点在中继上，只有进程退出时才会被释放；不等它就起下一次连接，新连接会因端口仍被占而失败。

参数变化时的重建走同一条路径：先按上面的顺序拆掉当前这一份，再用新参数注册一份新的。旧的一份不到静默就不建新的，因此不会出现两个子进程同时持有同一个远端监听。

每一次连接尝试也不是只等子进程的"完成"事件：它以完成事件与"进程范围变空"谁先落地为准，随后再确认范围为空才把句柄忘记。这样即使某个完成事件永不落地，也不会让上报的状态卡在"已连接"而实际没有任何监听。

## 诊断

`ssh` 的 stderr 是唯一能区分"认证失败 / 端口被占 / 主机密钥变了 / 网络不通"的信息源。

- stderr 以有界方式收集，把每个子进程最后一段输出留在内存里；退出时连同退出码一起写日志，并在 `status()` 里保留最后一次失败摘要。
- **不转储到文件**，也不把 stderr 塞进 `status()` 的返回结构体内（它可能包含主机路径）。
- 日志里同时打印一次人类可读的复现命令，让操作者能手工跑一次看到完整输出。

### 转发失败怎么分辨原因

转发限制被拒与端口被占在客户端产生**同一条**消息：两者都是服务端的转发请求失败，`ExitOnForwardFailure=yes` 把它变成"remote port forwarding failed"并让客户端退出。区分只看中继侧的 sshd 日志：

| 原因 | 中继 sshd 日志 | 预检能否修复 |
| --- | --- | --- |
| 端口被残留会话占着 | `bind [127.0.0.1]:<port>: Address already in use` | 能，这正是预检存在的理由 |
| 转发限制与插件端口不一致 | `... but the request was denied.` | 不能，属于配置错 |

第二种会一直失败到配置被改正——这是有意的：改配置是引导步骤的职责，不该由隧道守护在运行期猜。

## `status()`

```ts
export interface RelayStatus {
  /** 引导与隧道的合并状态。 */
  state: 'unconfigured' | 'bootstrapping' | 'ready' | 'failed'
  /** 已生效的权威；未配置时为空。 */
  authority: string
  /** 隧道状态。 */
  tunnel: 'starting' | 'running' | 'backing-off' | 'stopped'
  /** 本次连接已经活了多久（毫秒）；未连接时为 undefined。 */
  tunnelUptimeMs?: number
  /** 最近一次转发前预检的结果；从未运行时为 undefined。 */
  lastPreflight?: {
    /** `free` 空闲；`released` 清掉了残留；`skipped` 预检没跑成；`refused` 被占但不是本部署的残留。 */
    outcome: 'free' | 'released' | 'skipped' | 'refused'
    /** `skipped` 与 `refused` 的原因原文。 */
    message?: string
  }
  /** 最近一次失败的原文摘要，成功时为空。 */
  lastError: string
}
```

`status()` 返回快照（每次调用新建对象），不返回内部可变结构。

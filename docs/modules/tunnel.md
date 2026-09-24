# 模块：隧道守护

职责：把中继主机上的 loopback 端口指回本机的 `dsh web` 端口，并在链路抖动的整个过程中保持这个映射可用，同时保证插件被卸载时不留残余进程。

## 复用

- `ctx.subprocess.spawn(spec)`：DSH 既有的子进程 seam。规格是完全显式的（`argv` / `cwd` / `stdio` / `graceMs` / `signal` / `env`，无默认值），返回句柄带 `done`、`terminate()`、`waitForExit(signal?)`。
- `ctx.timer`（`@deepseek-ai/cordis-plugin-timer`，`base` 层提供）：定时器注册在 fiber 上，fiber 释放时自动清理，不需要自己维护 `clearTimeout` 台账。
- 系统自带的 OpenSSH 客户端：隧道协议实现。

本模块不引入任何 npm 依赖。

## 参数从哪来

隧道的目标端口来自 DSH 自己，不是配置：`ctx.webServer.port` 是 `dsh web` 实际监听的端口，`ctx.webServer.host` 用于断言只绑在 loopback（不是 loopback 时只记一条日志，见 [trust.md](trust.md)）。

其余参数分两处：

| 参数 | 来源 | 缺省行为 |
| --- | --- | --- |
| 中继地址、SSH 端口、账号 | `web-relay` 的 `vps.host` / `vps.port` / `vps.user` | `Deployment` 不齐全时不启动隧道 |
| 管理账号私钥 | `web-relay` 的 `vps.identityFile` | 留空则走系统身份解析（`~/.ssh/config`、默认私钥、agent） |
| 转发前预检的连接身份 | 同上的 `vps.host` / `vps.port` / `vps.user` / `vps.identityFile` | `Deployment` 不齐全时跳过预检，直接 spawn |
| 远端端点端口 | 包内 `tunnel.relayPort`（默认 `18080`） | 有默认值，必须与中继的 `permitlisten` 与 Caddy 上游一致 |
| 重连退避、健康阈值、拆除宽限 | 包内 `tunnel.*` | 见 [configuration.md](../configuration.md) |

隧道本身用的是**中继专用账号**与**本机专用私钥**（引导第 0–1 步生成在 `$DSH_HOME/dsh-web-relay/ssh/relay_ed25519`，`0600`），不是 `vps.user` 的管理身份。但这条通路还有一处用到管理身份：转发前预检要用 `vps.user` 的密钥连上中继，以 `sudo -n` 做端口探测并在需要时清掉残留（见下）。因此"管理账号被撤销不影响隧道"只剩一半成立——端口空闲时隧道照旧建立，只有从端口残留里恢复才需要它。

## 子进程规格

`argv` 由配置拼出，逐项固定，不做 shell 拼接：

```
ssh
  -N                                  # 不执行远程命令，纯转发
  -T                                  # 不分配 pty
  -o ExitOnForwardFailure=yes         # 端口没绑上就退出，而不是"连上了但没转发"
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o ConnectTimeout=10
  -o BatchMode=yes                    # 禁止任何交互式提问
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile=<knownHostsFile>
  -o IdentitiesOnly=yes               # 仅在指定了 vps.identityFile 时
  -i <identityFile>                   # 仅在指定了 vps.identityFile 时
  -o RequestTTY=no
  -R 127.0.0.1:<relayPort>:127.0.0.1:<dshPort>
  -p <sshPort> <user>@<host>
  --
```

要点：

- `-N -T` 保证这条连接只做转发；`BatchMode=yes` 与 `StrictHostKeyChecking=yes` 一起把"首次连接询问指纹"变成**启动失败**而不是静默挂起等待输入。这是有意的：一个会等待 stdin 的守护进程在后台等于死锁。
- `knownHostsFile` 是本机专用文件 `$DSH_HOME/dsh-web-relay/ssh/known_hosts`，不复用 `~/.ssh/known_hosts`。它由引导第 2 步写入，之后由 `StrictHostKeyChecking=yes` 强制校验。
- 远程侧显式写 `127.0.0.1:<relayPort>` 而不是只写端口。绑定地址显式化，配合中继侧 `GatewayPorts no` 与 `permitlisten` 形成三道一致的约束。
- `stdio` 三个流都必须显式声明（该 seam 不提供默认值）：`stdin: 'ignore'`（fd 0 指向 `/dev/null`）、`stdout: { maxBytes: 8192 }`、`stderr: { maxBytes: 8192 }`。`maxBytes` 形式的 collect 保留的是**尾部**，正好是 `ssh` 的报错信息所在的位置，且不需要临时文件（不写 `spill`）。`stdin: 'ignore'` 与 `BatchMode=yes` 是同一件事的两道保险。
- `graceMs`（`tunnel.graceMs`，默认 3000）决定释放时 `TERM` 到 `KILL` 的宽限。SSH 客户端收到 `TERM` 会主动拆掉转发再退出，因此正常情况下几毫秒内结束。
- `env` 在指定了 `vps.identityFile` 时写一项 `{ SSH_AUTH_SOCK: undefined }`。这一项是必要的：seam 会用 `scrubbedParentEnv()` 先清洗父环境，它剥掉名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的项和全部 `DSH_*`，但保留 `SSH_AUTH_SOCK`；不删掉它，`ssh` 仍可能从 ssh-agent 取到别的钥匙。`undefined` 是该 seam 定义的"删除一个环境变量"（墓碑值），不是"没设置"。留空 `vps.identityFile` 时不写这一项——那时 agent 正是我们要用的身份来源。
- `tunnel.extraOptions`（`Record<string, string>`）追加成额外的 `-o key=value`。键与上表冲突时以上表为准：`BatchMode`、`StrictHostKeyChecking`、`UserKnownHostsFile`、`ExitOnForwardFailure`、`ConnectTimeout` 这几项是安全与可用性的前提，不允许被覆盖。

## 转发前预检

`sshd` 为 `-R` 绑的监听端点属于**中继上处理那次连接的会话子进程**。主机侧异常中断（断电、休眠、网络切换、NAT 重绑定）不发出 FIN，中继察觉不到对端已经消失，那个子进程会继续占着 `127.0.0.1:<relayPort>`。中继的 `sshd` 片段给 `relay` 用户设了 `ClientAliveInterval 15` 与 `ClientAliveCountMax 3`，所以这种会话在约 45 秒内被丢弃、监听端点随之消失；在此之前任何新的 `-R` 都在服务端以 `bind: Address already in use` 失败，客户端因 `ExitOnForwardFailure=yes` 退出并进入退避。

因此每轮 spawn 之前先做一次预检，把端口腾出来：

```
1. 用 vps.* 的身份连中继，运行 sudo -n ss -ltnH 'sport = :<relayPort>'
2. 输出为空              → 端口空闲，直接 spawn
3. 输出非空              → 读出持有者 pid，核对它的可执行文件是 sshd 或 sshd-session，且属主是 relay
4. 核对通过              → sudo kill，轮询（上限 2 秒）到端口消失，再 spawn
5. 核对不通过，或预检本身出错 → 不动手，记录原因，照常 spawn
```

预检连接复用隧道的 SSH 参数（`BatchMode=yes`、`StrictHostKeyChecking=yes`、同一个 `knownHostsFile`、`ConnectTimeout`），只把身份从 `relay` 换成 `vps.user`。

预检的每一步都经管理账号的 `sudo -n` 执行：端口探测是 `sudo -n ss -ltnH 'sport = :<relayPort>'`，读出持有者 pid（带 `-p` 的 `ss`）与读 `/proc/<pid>/exe` 同样需要 root——不加 `sudo` 时 `users:(...)` 整列不会出现。`-n` 是有意的：账号免密时直接执行，需要口令时立即失败并记录 `skipped`，不会挂起等一个永远不来的输入。

**为什么杀它是安全的。** 按 [security.md](../security.md) 的前提，能建立反向转发的只有内网主机那把公钥，所以这个端口上的 `sshd` 端点只可能来自本部署的旧会话。预检不把这个推论当结论，而是逐条核对持有者：`/proc/<pid>/exe` 必须是 `sshd` 或 `sshd-session`，进程属主必须是 `relay`。验证过的中继上持有转发监听端点的就是 `/usr/lib/openssh/sshd-session`（属主 `relay`，`ss` 显示为 `users:(("sshd-session",pid=N,fd=12))`）。两条有一条不成立就停手——那个端口上可能是别的东西，杀掉它属于越界。这道核对限制的是**插件的失误**，不是被入侵的内网主机：那台主机本来就持有 `vps.identityFile` 与中继上的免密 `sudo` 权限，见 [security.md](../security.md) 的"中继侧的最小权限"。

**预检失败不是致命错误。** 它是一次修复，不是一道门。管理身份不可用（密钥被撤销、账号被禁用、`sudo` 需要口令、`ss` 没装）时预检记录原因后跳过，spawn 照常进行：端口空闲时隧道照旧建立，端口被占时按原有方式失败。这样"端口空闲"这条常见路径不依赖管理身份。

**不做开关。** 预检只在端口确实被占时动手，且只认"sshd + `relay` 属主"这一种持有者，因此不提供配置项；关掉它只会让残留退回人工清理，见 [operations.md](operations.md)。

远程命令是一段固定的 POSIX shell 片段，`tunnel.relayPort` 是里面唯一的变量，且在校验为 1–65535 的整数之后才拼进去，不做字符串拼接。

## 状态机

| 当前状态 | 事件 | 下一状态 | 动作 |
| --- | --- | --- | --- |
| — | `apply` 返回 | `starting` | 立即开始第一轮：转发前预检，然后 spawn |
| `starting` | 预检结束（空闲、已释放或跳过） | `starting` | 写 `lastPreflight`，继续 spawn |
| `starting` | spawn 成功 | `running` | 记录 `since`；启动健康计时 |
| `starting` | spawn 同步抛错 | `backing-off` | 记录退出摘要；取退避序列下一项 |
| `running` | `done` 解析（非 0 或信号） | `backing-off` | 记录 `exitCode`/`signal`/stderr 尾部 |
| `running` | 存活超过 `tunnel.healthyAfterMs` | `running` | 退避序列复位到第一项；`connectedCount++` |
| `backing-off` | 退避计时到 | `starting` | 重新预检并 spawn |
| `starting` / `running` / `backing-off` | fiber 释放 | `stopping` → `stopped` | 见下"生命周期与释放"；不再重试 |

- **单实例**：任何时刻最多一个隧道子进程，预检子进程与它串行、不并发。每轮开始前必须确认上一轮的句柄都已经 `done`，不允许叠加。
- **`starting` 的两种失败**：`spawn()` 同步抛错（例如 `cwd` 无效），或子进程立刻以非 0 退出（认证失败、端口被占）。两者都进入 `backing-off`。
- **退避**：`tunnel.backoffMs` 默认 `[1000, 2000, 5000, 15000, 30000]`，用尽后停在最后一项。稳定的失败（配置错、公钥不在中继上）会以 30s 周期重试并把 stderr 打出来，一眼可见且不刷屏。
- **健康判据**：仅凭"进程还活着"不足够，因为 `ssh -N -R` 在转发建立后会长期存活——这没问题，`ExitOnForwardFailure=yes` 已经保证"转发没成功就退出"。因此"存活超过 `tunnel.healthyAfterMs`"作为重置退避的信号。`running` 只表示"进程已经活过 `healthyAfterMs`"，不表示此刻有请求真的穿过隧道。这个判据是启发式的，所以退避序列必须有小起点（1s），不能一上来就 30s。
- **首轮不等退避**：参数齐全时立即开始第一轮（预检 → spawn），不延迟。启动自检需要一个已经在走的隧道。

## 什么时候起、什么时候停

| 条件 | 行为 |
| --- | --- |
| `Deployment` 不齐全（缺 `vps.host`） | 不起隧道，记录显示等待配置 |
| `Deployment` 齐全，引导尚未成功 | 引导第 12 步起隧道 |
| 启动时记录已是 `ready`、权威一致，且 `tunnel.autoStart` 为真 | 重新拉起隧道 |
| 启动时记录已是 `ready`、权威一致，但 `tunnel.autoStart` 为 `false` | 不起隧道；公网入口返回隧道不可达页面，要点一次部署才恢复 |
| `vps.host` / `vps.port` / `vps.user` / `vps.identityFile` 变化（经一次部署） | 停掉旧子进程，用新参数重新起（不需要重启 profile）；新凭据同时用于预检 |
| `ctx.webServer` 的端口变化 | 同上；端口只在 DSH 重启时才会变，实际等于一起重启 |

重启 DSH 从不重跑引导，只做恢复：记录已是 `ready`、权威一致且 `tunnel.autoStart` 为真时，隧道会被重新建立——它是一条活的连接，不随进程重启存活。`tunnel.autoStart` 只在这一刻生效；部署不看它，引导第 12 步总会建立隧道并等它健康，那一步同时是"转发确实通了"的验证。要再跑一遍引导只能在设置页点一次「部署」。

## 生命周期与释放

按防御性设计的既有要求（DSH 仓库的 `docs/defensive-patterns.md`，本插件遵循同一套约定），释放必须到达静默（quiescence）：

```ts
ctx.effect(() => {
  const setupAbort = new AbortController()          // 只关"启动/重连"这条线
  let child: SubprocessHandle | undefined           // 隧道子进程
  let preflight: SubprocessHandle | undefined       // 预检子进程
  let stopped = false

  const loop = async () => { /* 退避 → 预检 → spawn → 等 done/waitForExit → 确认范围为空 → 循环 */ }
  const run = loop()                                 // 首轮同步起预检，不 await；释放路径负责收敛

  return async () => {
    stopped = true
    setupAbort.abort()                               // 1. 先让重连循环停止产生新子进程
    for (const handle of [preflight, child]) {
      if (handle) {
        handle.terminate()                           // 2. 再终止活着的子进程
        await Promise.race([handle.done, handle.waitForExit()]).catch(() => {})   // 3. done 与 waitForExit 谁先落地
        await waitForEmptyProcessRange(graceMs + 1000)                            // 4. 有界地等进程范围变空
      }
    }
    await run.catch(() => {})                        // 5. 等循环自身落到终态
  }
})
```

`ctx.effect` 的回调在注册时立即执行，`loop()` 的第一轮在第一个 `await` 之前同步跑到预检连接的 `spawn()`，因此 `apply` 返回时预检已经在跑，无需把 `apply` 变成异步。循环体内部的每次重试都由 `setupAbort` 与 `stopped` 守卫。

顺序是有要求的：先关掉"会产生新子进程"的那条线，再杀已有的，最后等所有 await 落地。反过来的话，循环可能在杀进程与确认范围为空之间又起一个新的，那个子进程将不属于任何人的清理范围。两种子进程都要走这一遍：预检可能停在 `ss` 的输出上，隧道可能停在转发上，各自都要等到进程范围为空才算拆除完成。

拆除的等待是**有界**的：`stop()` 先 `setupAbort.abort()` 让重连循环停止产生新子进程，再对当前句柄调 `terminate()`，然后以 `tunnel.graceMs` 加 1 秒为上限，等这个进程范围变空。必须等到它真的消失，是因为转发的监听端点在中继上，只有进程退出时才会被释放；不等它就起下一次连接，新连接会因端口仍被占而 `ExitOnForwardFailure` 失败。`graceMs` 用尽后 seam 会升级到 `SIGKILL`；`done` 只在 spawn 或 provider 层失败时 reject，所以拆除要等到进程范围真的为空，而不是只等 `done` 落地。

参数变化时的重建走同一条路径：先按上面的顺序拆掉当前这一份，再用新参数注册一份新的。旧的一份不到静默就不建新的，因此不会出现两个子进程同时持有同一个远端监听。

每一次连接尝试也不是只等 `done`：它以句柄的 `done` promise 与 `waitForExit()` 谁先落地为准，随后再确认进程范围为空，才把句柄忘记。这样即使某个 `done` 永不落地，也不会让上报的状态卡在 `running` 而实际没有任何监听。

## 诊断

`ssh` 的 stderr 是唯一能区分"认证失败 / 端口被占 / 主机密钥变了 / 网络不通"的信息源。

- `stderr` 以 `maxBytes` 收集，把每个子进程最后一段输出留在内存里；退出时连同 `exitCode` 一起写日志，并在 `status()` 里保留最后一次失败摘要。
- **不转储到文件**，也不把 stderr 塞进 `status()` 的返回结构体内（它可能包含主机路径）。日志一行摘要足够定位。
- 日志里同时打印一次人类可读的复现命令（把 `argv` 原样拼出来），让操作者能手工跑一次看到完整输出。

### 转发失败怎么分辨原因

`permitlisten` 被拒与端口被占在客户端产生**同一条**消息：两者都是服务端的 `SSH2_MSG_REQUEST_FAILURE`，`ExitOnForwardFailure=yes` 把它变成 `remote port forwarding failed for listen port <relayPort>` 并让客户端退出。区分只看中继侧的 `sshd` 日志：

| 原因 | 中继 `sshd` 日志 | 预检能否修复 |
| --- | --- | --- |
| 端口被残留会话占着 | `bind [127.0.0.1]:<port>: Address already in use` | 能，这正是预检存在的理由 |
| `permitlisten` 与 `tunnel.relayPort` 不一致 | `Received request from <ip> port <p> to remote forward, but the request was denied.` | 不能，属于配置错 |

第二种会一直失败到配置被改正——这是有意的，改配置是引导步骤的职责，不该由隧道守护在运行期猜。

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
    /** `free` 空闲；`released` 杀掉了残留；`skipped` 预检没跑成；`refused` 被占但不是本部署的残留。 */
    outcome: 'free' | 'released' | 'skipped' | 'refused'
    /** `skipped` 与 `refused` 的原因原文。 */
    message?: string
  }
  /** 最近一次失败的原文摘要，成功时为空。 */
  lastError: string
}
```

`status()` 返回快照（每次调用新建对象），不返回内部可变结构。它与 `trustedHosts`、`authority()` 一起在同一个同步 `provide` 里给出，因此设置页与自检在 `apply` 返回后立刻就能读它。

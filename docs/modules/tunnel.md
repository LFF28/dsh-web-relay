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
| 远端端点端口 | 包内 `tunnel.relayPort`（默认 `18080`） | 有默认值，必须与中继的 `permitlisten` 与 Caddy 上游一致 |
| 重连退避、健康阈值、拆除宽限 | 包内 `tunnel.*` | 见 [configuration.md](../configuration.md) |

隧道用的是**中继专用账号**与**本机专用私钥**（引导第 0–1 步生成在 `$DSH_HOME/dsh-web-relay/ssh/relay_ed25519`，`0600`），不是 `vps.user` 的管理凭据。管理凭据只在引导期间使用，隧道与它无关——隧道因此能在管理口令换掉、或管理账号被禁用之后继续工作。

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

## 状态机

| 当前状态 | 事件 | 下一状态 | 动作 |
| --- | --- | --- | --- |
| — | `apply` 返回 | `starting` | 立即 spawn 第一个子进程 |
| `starting` | spawn 成功 | `running` | 记录 `since`；启动健康计时 |
| `starting` | spawn 同步抛错 | `backing-off` | 记录退出摘要；取退避序列下一项 |
| `running` | `done` 解析（非 0 或信号） | `backing-off` | 记录 `exitCode`/`signal`/stderr 尾部 |
| `running` | 存活超过 `tunnel.healthyAfterMs` | `running` | 退避序列复位到第一项；`connectedCount++` |
| `backing-off` | 退避计时到 | `starting` | 重新 spawn |
| `starting` / `running` / `backing-off` | fiber 释放 | `stopping` → `stopped` | 见下"生命周期与释放"；不再重试 |

- **单实例**：任何时刻最多一个 `ssh` 子进程。每次重连前必须确认旧句柄已经 `done`，不允许叠加。
- **`starting` 的两种失败**：`spawn()` 同步抛错（例如 `cwd` 无效），或子进程立刻以非 0 退出（认证失败、端口被占）。两者都进入 `backing-off`。
- **退避**：`tunnel.backoffMs` 默认 `[1000, 2000, 5000, 15000, 30000]`，用尽后停在最后一项。稳定的失败（配置错、公钥不在中继上）会以 30s 周期重试并把 stderr 打出来，一眼可见且不刷屏。
- **健康判据**：仅凭"进程还活着"不足够，因为 `ssh -N -R` 在转发建立后会长期存活——这没问题，`ExitOnForwardFailure=yes` 已经保证"转发没成功就退出"。因此"存活超过 `tunnel.healthyAfterMs`"作为重置退避的信号。这个判据是启发式的，所以退避序列必须有小起点（1s），不能一上来就 30s。
- **首轮不等退避**：参数齐全时立即 spawn，不延迟。启动自检需要一个已经在走的隧道。

## 什么时候起、什么时候停

| 条件 | 行为 |
| --- | --- |
| `Deployment` 不齐全（缺 `vps.host`） | 不起隧道，记录显示等待配置 |
| `Deployment` 齐全，引导尚未成功 | 引导第 12 步起隧道 |
| 引导已是 `ready`，`tunnel.autoStart` 为真 | 启动时直接起隧道 |
| `tunnel.autoStart` 置为 `false` | 停隧道，且不再自动拉起；公网入口返回隧道不可达页面 |
| `vps.host` / `vps.port` / `vps.user` / `vps.identityFile` 变化 | 停掉旧子进程，用新参数重新起（不需要重启 profile） |
| `ctx.webServer` 的端口变化 | 同上；端口只在 DSH 重启时才会变，实际等于一起重启 |

## 生命周期与释放

按防御性设计的既有要求（DSH 仓库的 `docs/defensive-patterns.md`，本插件遵循同一套约定），释放必须到达静默（quiescence）：

```ts
ctx.effect(() => {
  const setupAbort = new AbortController()          // 只关"启动/重连"这条线
  let child: SubprocessHandle | undefined
  let stopped = false

  const loop = async () => { /* 退避 → spawn → await done → 循环 */ }
  const run = loop()                                 // 首轮同步 spawn，不 await；释放路径负责收敛

  return async () => {
    stopped = true
    setupAbort.abort()                               // 1. 先让重连循环停止产生新子进程
    const handle = child
    if (handle) {
      handle.terminate()                             // 2. 再终止活着的子进程
      await handle.done.catch(() => {})              // 3. 等到它真的结束
    }
    await run.catch(() => {})                        // 4. 等循环自身落到终态
  }
})
```

`ctx.effect` 的回调在注册时立即执行，`loop()` 的第一轮在第一个 `await` 之前同步跑到 `spawn()`，因此 `apply` 返回时隧道已经在建立，无需把 `apply` 变成异步。循环体内部的每次重试都由 `setupAbort` 与 `stopped` 守卫。

顺序是有要求的：先关掉"会产生新子进程"的那条线，再杀已有的，最后等所有 await 落地。反过来的话，循环可能在杀进程与等 `done` 之间又 spawn 一个新的，那个子进程将不属于任何人的清理范围。

`graceMs` 用尽后 seam 会升级到 `SIGKILL`；`await done` 仍然会解析（`done` 只在 spawn 或 provider 层失败时 reject）。

参数变化时的重建走同一条路径：先按上面的顺序拆掉当前这一份，再用新参数注册一份新的。旧的一份不到静默就不建新的，因此不会出现两个子进程同时持有同一个远端监听。

## 诊断

`ssh` 的 stderr 是唯一能区分"认证失败 / 端口被占 / 主机密钥变了 / 网络不通"的信息源。

- `stderr` 以 `maxBytes` 收集，把每个子进程最后一段输出留在内存里；退出时连同 `exitCode` 一起写日志，并在 `status()` 里保留最后一次失败摘要。
- **不转储到文件**，也不把 stderr 塞进 `status()` 的返回结构体内（它可能包含主机路径）。日志一行摘要足够定位。
- 启动横幅里同时打印一次人类可读的复现命令（把 `argv` 原样拼出来），让操作者能手工跑一次看到完整输出。

### `ExitOnForwardFailure=yes` 会掩盖的一类问题

转发成功但"中继上的目标端口已经有人占了"会在服务端拒绝，客户端退出并打印 `remote port forwarding failed for listen port <relayPort>`。这类问题靠日志识别；主动探测推迟到 v1.1，见 [roadmap.md](../roadmap.md)。

## `status()`

```ts
export interface RelayStatus {
  /** 隧道状态。 */
  state: 'starting' | 'running' | 'backing-off' | 'stopped'
  /** 本状态开始的时刻（毫秒时间戳）。 */
  since: number
  /** 累计成功建立转发的次数。 */
  connectedCount: number
  /** 最近一次退出的退出码与 stderr 摘要；从未退出时为 undefined。 */
  lastExit?: { exitCode: number | null; signal: string | null; message: string }
}
```

`status()` 返回快照（每次调用新建对象），不返回内部可变结构。它与 `trustedHosts`、`authority()` 一起在同一个同步 `provide` 里给出，因此卡片与自检在 `apply` 返回后立刻就能读它。

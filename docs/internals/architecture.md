# 实现：模块、配置层与运行时

`dsh-web-relay` 是一个 DSH 插件包，分两个半边：宿主侧的 Cordis 插件（`src/*.ts`）与浏览器侧的设置页（`src/client/`）。这一篇讲它们怎么接线，机制的理由只写到够用的程度。

## 宿主侧模块

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 插件入口：`name` / `inject` / `Config` / `apply`，只做接线 |
| `config.ts` | `Config` schema、部署参数的交叉字段校验、默认值兜底 |
| `deployment.ts` | 把设置里的原始值规范化成一份不可变 `Deployment`（权威、主机名等） |
| `settings.ts` | 部署参数的只读门面（volatile 引用） |
| `authority.ts` | 权威形状校验与规范化助手（`isBareAuthority`、`canonicalAuthority`、`canonicalHostname`） |
| `bootstrap.ts` | 幂等引导：第 0–10 步 |
| `trust.ts` | 权威注册（重解析 `connection` 行）与自检 |
| `tunnel.ts` | 隧道子进程的生命周期、退避、健康判定、拆除 |
| `preflight.ts` | 转发前预检：清掉上一轮残留的监听端点 |
| `ssh.ts` | 所有 `ssh` / `ssh-keygen` 参数构造与一次性远程命令执行 |
| `templates.ts` | `deploy/` 模板的加载、占位符替换、托管块写入脚本生成 |
| `paths.ts` | 插件在 `$DSH_HOME` 下的每一条路径 |
| `record.ts` | 运行记录的类型、落盘与浏览器视图（白名单） |
| `service.ts` | `RelayRuntime`：编排引导、隧道、预检、记录与服务面 |
| `entry.ts` | 换票点 `/relay/enter` |
| `namespaces.ts` | 宿主与浏览器两半共用的两个常量（纯常量，无 `node:` 导入） |

插件名是短名 `web-relay`，patch 行用完整包名 `dsh-web-relay`——与仓库既有约定一致。

## 浏览器侧

`src/client/index.ts` 向 `settings.section` 注册一个以 `web-relay` 为 `id` 的标签页（**设置 ▸ 远程访问**）。页面自绘表单与状态区，只依赖平台模块表里的 `react`、`react/jsx-runtime` 与 `@deepseek-ai/dsh-client-ui-primitives`，其余能力走服务：`ctx.slots`、`ctx.configForms`、`ctx.locale`。

页面挂载时读一次设置，之后的编辑只留在浏览器内存里；点「部署」才把表单值连同递增的部署计数写成一次 `mutate`。把保存绑在输入事件上会让中继上出现一串互相打断的引导。

记录只在必要时轮询：挂载时取一次，之后只在"引导进行中"或"隧道正在连接/重连"时按 1.5 秒轮询，落定即停。

## 配置层与行序

插件的 `cordis.patch.yml` 做两件事：

```yaml
- id: connection
  inject: [webRuntime, webRelay]
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts.concat(ctx.webRelay.trustedHosts)

- insert:
    - id: web-relay
      name: dsh-web-relay
```

三点机制：

1. **后层覆盖前层，按行 `id` 匹配。** patch 替换的是整行 `config`，不是深合并（`target[key] = value`）。`connection` 行在 `web-app` 里只写了 `trustedHosts`，所以这里只重述它是完备的；**upstream 若给那一行新增 key，本插件的覆盖会让它们回落到默认值**，升级时要对照。
2. **行级 `inject` 与模块级 `inject` 叠加**（`Inject.resolve(entry.options.inject, fiber.inject)`），所以覆盖 `inject` 不会丢掉模块自己声明的依赖。
3. **`!!js` 表达式在该行的注入满足之后才求值**（Cordis 的 `internal/config`）。因此 `web-relay` 行必须在 `apply` 返回之前**同步** `ctx.provide('webRelay', …)`，不能先 `await` 再 provide。

`insert` 没有 `id`，所以 `web-relay` 行被追加到组合列表末尾。行序不影响正确性：未满足的必需注入不会阻塞后续行——`connection` 行因缺 `webRelay` 停在 PENDING，等插件 provide 之后 Cordis 的 `reflect.notify` 让它重新解析配置并按新值激活。插件因此不需要抢行序，也不需要动态插入行。

`!!js` 表达式必须写成**普通标量**：写成流式序列会让 YAML 把标签判成未知而拒绝加载。

## `webRelay` 服务面

```ts
export interface WebRelayHandle {
  /** 当前应当被围栏接受的权威（规范化后的 host[:port]）；未配置时为空数组。 */
  readonly trustedHosts: readonly string[]
  /** 当前权威；未配置时为空字符串。 */
  authority(): string
  /** 引导与隧道状态快照。 */
  status(): RelayStatus
  /** 当前运行记录的浏览器视图（已剔除敏感字段）。 */
  record(): RecordView
}
```

服务面刻意很小：`trustedHosts` 是配置表达式唯一需要的东西；`authority()` 是引导、自检与设置页共用的单一权威来源；`status()` 给日志与诊断；`record()` 给设置页。`trustedHosts` 每次读取返回新数组，表达式展开不会泄漏内部状态。

需要 `connection` 的功能（换票点里的令牌交换、记录接口）放在独立的 `ctx.inject(['connection'], …)` 子 fiber 里注册，**不放进顶层 `inject`**：`connection` 行反过来要注入 `webRelay`，放进去会形成等待环。子 fiber 的等待不影响插件自身激活。

## 启动时序

1. `apply` 读 `ctx.webServer.port`，同步 `provide('webRelay', …)`。
2. 注册 `internal/config` 瀑布做交叉字段校验（见下）。
3. 注册设置页归属（`settings.configure({ auto: false })`）、`loader/volatile-update` 监听、记录接口与入口路由。
4. `runtime.start()`：建目录、备好网关会话密钥、读一次记录恢复内存状态，然后异步 `#restore()`。
5. `#restore()` 先把当前权威注册进围栏；再按合取式决定动不动手——记录里 `state === 'ready'` **且** `deploy.autoDeploy` 为真时自动跑一遍完整部署，否则什么都不做，只补一次回环自检打一行结论。

一次启动最多尝试一次，失败不重试。`tunnelState` 描述的是活着的子进程，而子进程从不跨重启存活，所以启动时无条件把它按事实写成 `stopped`。

## 一次部署

```
点部署（或手工改 profile 补丁里的 deployment）
  → 一次原子写入：vps.*、gateway.*、deploy.request + 1、deploy.autoDeploy
  → Loader 提交 volatile 子树并派发 loader/volatile-update
  → 部署入口（串行排队）读到当前设置，跑完整引导第 0–13 步
  → 每步结果、状态与指纹逐次写回 record.json
```

排队的是**整个部署**而不是每个步骤：提交可能连着来，而两次引导同时在同一条隧道上动手会互相拆台。

`Deployment` 不齐全（缺地址或口令）时不引导、不起隧道，记录写成"等待配置"。

`deploy.request` 只做一件事：设置服务对解析后的值做深层相等短路，写入与现值完全相同时既不通知观察者也不推进修订号。有它，"一个字都没改也要重来一遍"才是一次真实的文档变更。宿主读都不读这个字段。

## 交叉字段校验

两条规则挂在 `internal/config` 瀑布上：地址必须是裸的 `host[:port]`；填了地址就必须有口令。

挂在这个瀑布上是因为它同时覆盖两条写入路径：volatile 提交（`_commitVolatile` 在提交值**之前**跑它）与设置页写文档（`configEditor.edit`）。失败时前者保留旧引用并记一行 warn，后者把异常抛回客户端，因此不会落下"存了但用不了"的值。

回调里 `if (this !== ctx.fiber) return raw` 的过滤是必要的：这个瀑布对整棵树上每一行都触发，不过滤时别的插件解析自己的配置也会跑一遍我们的校验。

## 设置通道

部署参数是插件 `Config` 里的一棵 volatile 子树：

```
Config = z.object({
  logLabel, tunnel, bootstrap, entry, selfCheck,   // 包内旋钮，随包发布
  deployment: Deployment.default({}).volatile(),   // 用户填的部署参数
})
```

**为什么整棵子树标 volatile。** 两条约束合起来只剩这一个写法：设置表单的写入只接受 volatile 路径，而 schemastery 拒绝 volatile 里再套 volatile。于是 `deployment` 必须是**一层** volatile 容器。普通旋钮不属于 volatile，因此根本不出现在设置页里——它们随包发布，改了要重挂载，本来就该由包作者动。

设置页用逐字段写入而不是整体覆盖：整体覆盖会连网关口令一起抹掉，而那个字段从来就没到过浏览器。

`gateway.password` 用 `role('secret')` 声明，设置描述符在遮蔽时把这个字段整体移出 `value`/`base`/`user`，只报"在哪些路径上已设置"。于是口令值从不进入发给浏览器的响应，页面无法显示也无法回填它。

## 运行记录通道

记录由插件写、体量随引导步骤增长，而设置文档只接受 volatile 字段的写入，所以它走插件自己的通道：

- 落点：`$DSH_HOME/dsh-web-relay/record.json`（`0600`，目录 `0700`），走"写临时文件再 `rename`"的原子替换。
- 出口：`GET /api/web-relay.record`，经 `ctx.connection.fetch.register` 注册在 DSH 共享 API 通道下，因此在 `connection` 的信任与认证围栏之后：未认证回 401、权威不受信回 403。插件因此不需要、也不应该自开一条绕过认证的接口。
- 读取不走磁盘：`RelayRuntime` 持有内存副本，刚写完的记录立刻可见；文件只用于跨重启恢复，读不出来（首次启动、半截 JSON）一律当成空记录。

**白名单是唯一的出口。** `recordView()` 逐字段构造视图，而不是展开整个记录：记录里有网关会话 Cookie 的比对值，迁移后没有 schema 遮蔽兜底，遮蔽完全由白名单承担。新增记录字段不会自动跟着漏出去。

| 字段 | 说明 |
| --- | --- |
| `state` | `unconfigured` / `bootstrapping` / `ready` / `failed` |
| `tunnelState` | `stopped` / `starting` / `running` / `backing-off` |
| `updatedAt` | 最近一次记录更新的 ISO 时间 |
| `publicAuthority` | 已生效的权威；空串表示尚未生效 |
| `observedHostKeyFingerprint` | 观察到的（或按固定值校验通过的）中继主机公钥指纹 |
| `caFingerprint` | 中继 CA 根证书的 SHA256 指纹 |
| `caPem` | 根证书 PEM 全文，供设置页「下载根证书」按钮存成本地文件。刻意不剔除：只有公钥材料 |
| `gateway.sessionSecret` | 网关会话 Cookie 的比对值。**绝不离开宿主**，白名单把整个 `gateway` 一节挡在响应之外 |
| `steps` | 最近一次引导的逐步结果（id / title / status / detail） |
| `lastError` | 最近一次失败的原文摘要 |
| `lastPreflight` | 最近一次转发前预检的结果 |

## 相关

- 引导的每一步动作：[bootstrap.md](bootstrap.md)
- 中继上的目标状态：[relay-host.md](relay-host.md)
- 包与依赖声明：[packaging.md](packaging.md)

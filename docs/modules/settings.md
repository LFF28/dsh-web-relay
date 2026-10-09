# 配置、运行记录与设置页

插件的状态分成性质完全不同的两半，迁移到 0.2 之后它们走两条通道：

| | 部署参数 | 运行记录 |
| --- | --- | --- |
| 写入者 | 用户（设置页） | 插件 |
| 落点 | profile 的 `cordis.patch.yml`，即插件 `Config.deployment` | `$DSH_HOME/dsh-web-relay/record.json`（`0600`） |
| 读法 | `ctx.configForms`（浏览器）／`Volatile.get()`（宿主） | `GET /api/web-relay.record` |
| 生命周期 | volatile：提交后原地换值，不重挂载插件 | 每次引导与状态变化逐次合并写入 |

分开的理由是这两份文档的写入者与语义对不上：混在一份文档里，"用户清空一个字段"与"插件更新一次记录"会互相覆盖。

## 部署参数是插件 `Config` 里的一棵 volatile 子树

```
Config = z.object({
  logLabel, tunnel, bootstrap, entry, selfCheck,   // 包内旋钮，随包发布
  deployment: Deployment.default({}).volatile(),   // 用户填的部署参数
})
```

设置命名空间就是 Loader 条目 id（`web-relay`，由插件自己的 `cordis.patch.yml` 那一行决定）。0.2 不再有 `ctx.settings.register`，表单直接长在 `Config` 上。

**为什么整棵子树标 volatile，而不是逐字段标。** 两条约束合起来只剩这一个写法：

- `SettingsForms.write` 只接受 volatile 路径（`isVolatilePath`），普通字段的写入会被拒。
- schemastery 拒绝 volatile 里再套 volatile（`volatile fields require a fixed object path without an enclosing volatile field`）。

于是 `deployment` 必须是**一层** volatile 容器。`Volatile<T>` 只有 `get()`，写由 Loader 完成：提交时 `_commitVolatile()` 把新值写进运行中 fiber 的这一个引用，然后派发 `loader/volatile-update`。

**普通旋钮不会被 volatile 带走。** `volatileForm` 只为 volatile 路径生成表单，所以 `logLabel`、`tunnel`、`bootstrap`、`entry`、`selfCheck` 根本不出现在设置页里——它们随包发布，改了要重挂载，本来就该由包作者动。

### 交叉字段校验挂在 `internal/config` 瀑布上

两条规则（地址必须是裸的 `host[:port]`、填了地址就必须有口令）在 `validateDeployment()` 里，挂载点是 `internal/config`：

```
ctx.on('internal/config', function (this, _raw, next) {
  const raw = next()
  if (this !== ctx.fiber) return raw          // 瀑布对整棵树上每一行都触发
  … validateDeployment(deployment 的内容) …
  return raw
})
```

这个瀑布同时覆盖两条写入路径：volatile 提交（`_commitVolatile` 在提交值**之前**跑它）与 `configEditor.edit`（设置页写文档时跑）。失败时前者保留旧引用并记一行 warn，后者把异常抛回客户端，所以不会落下"存了但用不了"的值。

`if (this !== ctx.fiber)` 的过滤是必要的：不过滤的话，别的插件解析自己的配置时也会触发我们的校验。

### 路径与写入

设置页把表单值连同部署计数写成**一次** `form.mutate(ops)`。路径的第一段是 `deployment`——volatile 子树在 `Config` 里的位置：

```
['deployment','vps','host'] … ['deployment','gateway','password']
['deployment','deploy','request']  ← 每次点部署加一
['deployment','deploy','autoDeploy']
```

逐字段写而不是整体覆盖：整体覆盖会连 `gateway.password` 一起抹掉——那个字段从来就没到过浏览器。一次 `mutate` 共享同一次修订栅栏、同一次校验与同一次落盘。

`deploy.request` 只做一件事：设置服务对解析后的值做深层相等短路，写入与现值完全相同时既不通知观察者也不推进修订号；有一个每次加一的字段，"一个字都没改也要重来一遍"才是一次真实的文档变更。宿主读都不读它。

## 运行记录走插件自己的已认证通道

记录不再是设置命名空间，因为它由插件写、体量随引导步骤增长，而且（关键）0.2 的设置文档只接受 volatile 字段的写入。

落点是 `$DSH_HOME/dsh-web-relay/record.json`（`0600`），出口是：

```
GET /api/web-relay.record      ← ctx.connection.fetch.register
```

它挂在 DSH 共享 API 通道下，因此在 `connection` 的信任与认证围栏之后：未认证回 **401**、权威不受信回 **403**。插件因此不需要、也不应该自开一条绕过认证的接口——对一个暴露在公网上的插件，这是决定性的一点。

**白名单是唯一的出口。** `recordView()` 逐字段构造视图，而不是 `{ ...record }`。记录里有 `gateway.sessionSecret`（网关会话 Cookie 的比对值），迁移前它有 schema 的 `role('secret')` 遮蔽兜底，迁移后这条路没有了：遮蔽完全由白名单承担。新增记录字段不会自动跟着漏出去。`caPem` 则刻意保留——它只有公钥材料，状态区的「下载根证书」要用。

记录的读取**不走磁盘**：`RelayRuntime` 持有内存副本，刚写完的记录立刻可见。文件只用于跨重启恢复，读不出来（首次启动、半截 JSON）一律当成空记录。

## 设置页

设置页是插件唯一的用户界面，也是首次配置的入口。它位于 **设置 ▸ 远程访问**：客户端半边向 `settings.section` 注册一个标签页。

**注册。** 该槽位是 `kind: 'list'`、`scope: 'root'`：

```
ctx.configForms.whileServed(['web-relay'], () => ctx.slots.inject('settings.section', …))
```

`id` 与 `order` 决定这一行在导航栏里的身份与位置（30，排在内建的归档会话页之后）。导航图标由外壳按 `id` 决定，未知 `id` 回退成设置齿轮图标。

`whileServed` 的门槛是宿主确实在服务 `web-relay` 这一个命名空间：没装这个插件的部署不会在设置菜单里留下痕迹。

**自带页面的插件要关掉自动生成。** `autoGenerate` 默认是 `true`，那是给"按 schema 自动生成配置页"的客户端用的。本插件自己的标签页才是它的设置面：

```
ctx.inject(['settings'], (child) => {
  child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
})
```

**读取。** 页面用 `ctx.configForms.get<RelayConfigSection>('web-relay')` 拿表单，`getSnapshot()` 读、`subscribe()` 订阅。记录另走 `fetch('/api/web-relay.record', { credentials: 'include' })`。

**记录只在必要时轮询。** 页面挂载时取一次；之后只在「引导进行中」或「隧道正在连接/重连」时按 1.5 s 轮询，落定即停。中继那条链路带宽有限，闲置时的定时请求是纯粹的开销。首轮取记录只做一次（`started` 闸门），因为 React 会反复调用 `subscribe`。

**表单与状态区。** 表单在挂载时读一次，之后的编辑只留在浏览器内存里；点部署才写成一次 `mutate`。口令字段没有可回填的值（凭据不回传），所以那个输入框永远是空的，**每次部署都必须重填**。状态区渲染记录里的状态、权威、访问地址、CA 指纹、逐步引导结果、最近一次错误与最近一次转发前预检，只读。

`caPem` 非空时状态区带一个「下载根证书」按钮，用 `Blob` + 临时对象 URL 存成本地文件 `dsh-web-relay-ca.crt`；不需要任何宿主端点。这一步是给**服务器本机**的浏览器用的——远程页面上这个标签页根本不注册。

## 一次部署是怎么发生的

```
点部署（或手工改 profile 补丁里的 deployment）
  → 一次原子写入：vps.*、gateway.*、deploy.request + 1、deploy.autoDeploy
  → Loader 提交 volatile 子树并派发 loader/volatile-update
  → 插件部署入口（串行排队）读到当前设置并跑完整引导第 0–13 步
  → 每步结果、状态与指纹逐次写回 record.json
```

链路是单向的：只有 `deployment` 的提交会启动一次重新配置，记录的写入不会再触发它。

部署入口**串行排队**：提交可能连着来，而两次引导同时在同一条隧道上动手会互相拆台。排队的是整个部署而不是每个步骤，所以后一次提交看到的一定是前一次跑完之后的世界。

## 启动时会不会自动部署

「启动」那一节只有一个开关：**随 DSH 启动自动部署**，默认关。启动时的判定是两者的合取：

```
记录里 state === 'ready'     ← 事实：上次部署成功了
deployment.deploy.autoDeploy ← 请求：用户在页面上选的
```

两个都成立才自动跑一遍完整部署（第 0–13 步）。这里不需要第二个字段记账：失败的部署把记录写成 `failed`，开关随之失效，再成功一次又自动生效。

不成立时启动什么都不做：不部署、不起隧道，公网入口返回中继那行"隧道未连接"；只把当前权威注册进围栏，并补跑一次回环自检。

**失败不重试。** 一次启动最多调用一次部署。因此开着的机器每重启一次就重跑一遍全量部署，也就会重算 bcrypt 与网关会话密钥——手机上已持有的网关会话随之失效，下次进入要重输一次口令。

## 密钥处理

`gateway.password` 用 `z.string().role('secret')` 声明。设置描述符在 `redactSecrets` 下把这个字段整体移出 `value`/`base`/`user`，改放进 `secrets` 列表，只报"在哪些路径上已设置"。于是：

- 口令值从不进入发给浏览器的响应，设置页无法显示也无法回填它，每次部署都要重填。
- 口令值以明文存在 profile 的 `cordis.patch.yml`（`0600`）。这是选择"用户自填口令"的必然结果，写在这里以免被误认为已加密。该文件不是 git 仓库的一部分。
- 引导时明文只出现在一处：交给中继上 `caddy hash-password` 的 stdin。它不出现在任何命令行参数、日志、记录或临时文件里。

`.volatile()` 与 `role('secret')` 是正交的：`.volatile()` 只加 meta，遮蔽遍历照旧看得见 `gateway.password`，写只读输入框的 `secrets: [{ path, set }]` 侧车仍然成立。

`record.json` 里的 `gateway.sessionSecret` 是网关会话 Cookie 的比对值。它**不**出网——`recordView()` 的白名单把整个 `gateway` 一节挡在外面。每次部署都会重新生成：口令每次都可能不同，而它必须跟着口令一起换。

管理账号不走口令：公钥登录与免密 sudo 是用户事先准备好的前提。`vps.identityFile` 只被拼进 `-i`，插件不读取、不复制、不改权限。

## 首次配置与每次部署都必须在本机完成

DSH 的客户端在非 loopback 页面上把设置持久化降级为内存，`configForms` 的持久化模式变成 `memory`，镜像快照是 `unavailable`，这个标签页因此**在远程页面上根本不会注册**：

- 在服务器本机的 `http://127.0.0.1:<port>` 页面上，标签页出现、表单可写、部署按钮可用。
- 通过中继打开的手机页面上没有这个入口，设置页里也不会出现它的痕迹。

这不是插件可以绕过的限制，而是流程的一部分：**首次配置与每一次部署都在服务器本机做**，远程只需打开访问地址并输入网关口令。

## 客户端半边的加载

设置页要作为仓外包被浏览器加载，需要包满足平台的三件事：

| 要求 | 落点 |
| --- | --- |
| 包能被宿主定位并列出 | 包根有 `package.json`，且 `exports['./client']` 指向构建产物 |
| 浏览器名册包含它 | `package.json` 的 `dsh.client = { platform: 'web', inject: [ … ] }` |
| 打包成闭包工厂 | 产物调用 `window.__ModuleLoader__.load({ id, factory })`，外部依赖经注入的 `require` 解析 |

平台模块表是封闭的，只有九项：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。页面本体只用得到其中三到四项，其余能力全部走服务：`ctx.slots`、`ctx.configForms`、`ctx.locale`。

`dsh.client.inject` 列出必须先加载的客户端半边：`@deepseek-ai/dsh-client-locale`（`ctx.locale`）、`@deepseek-ai/dsh-client-ui-renderer`（`ctx.slots`）与 `@deepseek-ai/dsh-client-ui-settings`（`ctx.configForms`，也是 `settings.section` 槽位类型所在的包）。

## 传输与心跳

这一节记的是排查「手机上点会话就重连」时实测到的结论。**它们是结论，不是待办**：三项里两项确认无需改动，第三项需要改 DSH 源码，因此不在本插件的范围内。

### 真正的瓶颈在中继到手机那一段

隧道是 `本机 →(SSH) 中继 →(Caddy) 手机`，两段的带宽差一个数量级：

| 段 | 实测 |
| --- | --- |
| 本机 → 中继 | 约 **3.3 MB/s**（3.0 MB / 0.92 s） |
| 中继 → 手机 | 约 **0.35 MB/s**（5 MB / 13.8 s；3.7 MB / 10.5 s） |

### SSH 压缩只压那条快腿，不是重连的解

`tunnel.extraOptions.Compression: "yes"` 打开 `-C`。但中继上的 sshd 在把字节写进 `127.0.0.1:18080` 之前就已经解压了，所以**慢腿的字节数一个都不减**。收益是快腿从 1.275 s 降到 0.518 s 量级，仅此而已。

`Compression` 不在 `PROTECTED_OPTIONS` 里，所以它会被真的追加成 `-o Compression=yes`；管理连接（引导、预检）刻意不吃隧道专用的 `extraOptions`。校验用 `ssh -G -o Compression=yes … | grep compression`。

### Caddy 不重复压缩（无需改动）

部署的 `/etc/caddy/Caddyfile` 里 `encode` 指令数为 **0**，`caddy adapt` 走完没有 encode handler。日志里的 gzip 全部来自 DSH 自己的中间件（`createGzipMiddleware`），而它只装在 `createServer` 的请求路径上，`upgrade` 完全绕过——`/api/remote.mux` 从来没有被压缩过。

### permessage-deflate 是关着的（要开得改 DSH）

服务端 `new WebSocketServer({ noServer: true })` 吃 `ws` 的默认值 `perMessageDeflate: false`；浏览器客户端 `new WebSocket(url)` 不带参数，于是**提议**了扩展而服务端静默拒绝。实测：带合法会话 Cookie 对 `/api/remote.mux` 握手，HTTP 101，响应头 `sec-websocket-extensions: null`，客户端 `ws.extensions === ""`。

要开只能在 DSH 源码里给 `WebSocketServer` 传 `perMessageDeflate`，不属于中继通路能改的事。

### 心跳预算才是"点会话就重连"的算术

| 量 | 值 |
| --- | --- |
| `websocketHeartbeatIntervalMs` | 默认 **2000 ms** |
| `MAX_MISSED_HEARTBEATS` | **2** |
| 于是 pong 预算 | 约 **4 s** |
| 一个会话快照 | 实测 **2.89 MB** |
| 该快照在 0.35 MB/s 上的排空时间 | 约 **8 s** |

8 s 远超 4 s，于是 ping 超时、`socket.terminate()`，整条 mux 被拆掉——表现就是"每点一次会话，web 重新连接"。这解释了实测现象：iPhone 的 mux 生命周期中位数 7.3 s，而同一台机器上的桌面浏览器是 2085.6 s。

快照的构成也解释了为什么它这么大：`assistant/message.data.stream` 占 2.14 MB（74%），而其中的文本与 `message.content` 是逐字重复的（三个会话分别核对 162/162、156/156、127/127 全等）。这是 DSH 服务端的冗余，中继通路够不到。

**要真正解决它，得动 DSH 的心跳参数或快照体积，两者都超出本插件的范围。**

## 失败模式

| 现象 | 原因 | 表现 |
| --- | --- | --- |
| 设置里没有这个标签页 | 客户端半边没被打进名册，或 `exports['./client']` 缺失 | 插件功能正常，但没有界面；`dsh --dump-config` 仍能看到行 |
| 设置里没有这个标签页，本机也没有 | 宿主没在服务 `web-relay` 条目（插件行未加载、或 `whileServed` 判定不成立） | 页面不注册，不报错 |
| 表单只读 | 当前页面不是 loopback（`configForms` 是 memory 模式） | 标签页根本不会注册；宿主文档只读时也会禁用全部控件 |
| 部署按钮不可用 | 地址或网关口令为空、正在写入、或宿主文档不可写 | 表单下方给出原因 |
| 部署后出现"设置没有写入" | 交叉校验拒了这个组合（地址形状非法、口令为空），或修订号栅栏判定文档被别处改过 | 页面保留草稿并显示这句话，文档不变；核对后重试 |
| 状态区说"就绪"但其实连不上 | 有人在中继侧改了东西，或隧道断了 | 再点一次部署；引导是幂等的 |
| 状态区一直空着 | 记录接口被认证围栏拦住（非 loopback 页面）或 `record.json` 读不出来 | 页面保持上一份；插件日志里有"运行记录落盘失败" |

# 模块：插件与 bundle 打包

职责：让 `dsh plugin --profile web add <包>` 一条命令把插件的两个半边装进 profile 并生效，且不改动 DSH 源码。

## 包结构

```
dsh-web-relay/
├── package.json          # dsh.bundle + dsh.client 清单
├── cordis.patch.yml      # 本插件贡献的配置层
├── src/
│   ├── index.ts          # 插件入口：name / inject / Config / apply
│   ├── config.ts         # Config 类型 + Schemastery schema
│   ├── authority.ts      # 权威规范化助手，见 modules/trust.md
│   ├── settings.ts       # 两个设置命名空间，见 modules/settings.md
│   ├── bootstrap.ts      # 自动引导，见 modules/bootstrap.md
│   ├── trust.ts          # 权威注册与启动自检，见 modules/trust.md
│   ├── tunnel.ts         # SSH 反向隧道守护，见 modules/tunnel.md
│   ├── entry.ts          # /relay/enter，见 modules/entry.md
│   └── client/           # 浏览器半边：一张设置卡片
├── deploy/               # 引导写入中继的配置模板
└── docs/                 # 本目录
```

Cordis 模块名用短名 `web-relay`（`export const name = 'web-relay'`），patch 行用完整包名 —— 与仓库既有约定一致。

## manifest

```json
{
  "name": "dsh-web-relay",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "deploy"],
  "dsh": {
    "bundle": { "patch": "cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/cordis-plugin-timer": "^1.1.4",
    "@deepseek-ai/dsh-host-webserver": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-credentials": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-settings": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-subprocess": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-client-connection": "^0.1.5-rc.2"
  },
  "devDependencies": { "...": "同上，用于本地类型解析" }
}
```

依赖声明遵守 DSH 对树外插件的规则：**一律 peer + dev，绝不写 `dependencies`**。profile 的 pnpm 是 `nodeLinker: hoisted` + `autoInstallPeers: false`，peer 会通过 `$DSH_HOME/profiles/node_modules` 这个 repaired fallback 落到 dsh 安装自身的副本上。写成 `dependencies` 会拉进第二份实例，导致服务身份不一致。

`@deepseek-ai/dsh-client-connection` 出现在 peer 里有两个原因：一是覆盖行时按包名解析更稳，二是插件与它的行 `id` 与配置字段存在版本耦合，需要显式约束范围（见下）。

## 浏览器半边如何被发现

浏览器名册由宿主扫描 profile 里的行，逐个读那个包根目录的 `package.json`。四个条件缺一不可：

| 条件 | 落点 | 缺失后果 |
| --- | --- | --- |
| 行能被解析到包根 | 行 `name` 是包名，`package.json` 可被解析 | 该行被当成非客户端行，静默跳过 |
| 声明了客户端半边 | `dsh.client.platform === 'web'` | 同上 |
| 指出了产物 | `exports['./client']` 指向 `lib/client.js` | 直接抛错 `declares dsh.client but exports no "./client" bundle` |
| 产物是闭包工厂 | 构建产物调用 `window.__ModuleLoader__.load({ id, factory })` | 加载器无法取得模块工厂 |

`dsh.client.inject` 是**信息性**的包名列表，不参与 Cordis 注入；真正的服务依赖写在客户端模块自己导出的 `inject` 里。本插件两边都不需要 `external`：卡片只引用模块表基线里的模块。

卡片能用的模块是固定的九项：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。其余包只能做**类型**导入（类型导入会被构建擦除，不产生模块请求）：`@deepseek-ai/dsh-client-ui-settings-plugins` 只导出类型，不导出 `CardForm` / `PluginCard` 组件，所以卡片用 `ui-primitives` 自绘表单控件。详细形态见 [settings.md](settings.md)。

## patch 层

```yaml
# cordis.patch.yml
- id: connection
  inject: [webRuntime, webRelay]
  config:
    trustedHosts: !!js [...ctx.webRuntime.trustedHosts, ...ctx.webRelay.trustedHosts]

- insert:
    # 本插件自己的行。它在 apply 期间同步 provide `webRelay` 服务；
    # 部署参数不在这一行里，见 configuration.md。
    - id: web-relay
      name: dsh-web-relay
      config:
        entry:
          enabled: true
```

`insert` 没有 `id`，因此 `web-relay` 行被追加到组合列表末尾，排在 `connection` 行之后。

### 覆盖 `connection` 行是可行的，且是有意为之

三点机制，都已在本仓库源码中确认：

1. **后层覆盖前层，按行 `id` 匹配。** 本插件的 bundle 排在 `@deepseek-ai/dsh-web-app` 之后，因此它的 `connection` 行是更后的一层。行 `id` 漂移会导致新行插入而不是覆盖（重复注册 `/api` 路由会立刻抛错，属于"响亮的失败"，不会被静默忽略）。
2. **行级 `inject` 与模块级 `inject` 是叠加的，不是替换的。** Loader 在建立 fiber 时执行 `Inject.resolve(entry.options.inject, fiber.inject)`，把行上的 `inject` 累加进由模块导出的 `inject` 已经填充的映射。所以覆盖行里写 `inject: [webRuntime, webRelay]` **不会**丢掉 `@deepseek-ai/dsh-client-connection` 自己声明的 `inject = ['credentials']`。
3. **`!!js` 配置表达式在 fiber 的注入满足之后才求值。** Cordis 的 `internal/config` 事件注释即为此：`Resolve raw plugin config after the fiber's injections become active.` 所以 `ctx.webRelay.trustedHosts` 在表达式中是可用的；`web-relay` 行只需在 apply 期间**同步** `ctx.provide('webRelay', ...)`，不要先 `await` 再 provide。

补丁语义的代价要如实记住：patch 替换的是整行 `config`，不是深合并。上面只重述了 `trustedHosts`，是因为 `web-app` 那一行也只设置了 `trustedHosts`，其余字段（`recovery`、`cookieMaxAgeDays`、`maxRequestBodyBytes`）继续走 schema 默认值。**如果将来 upstream 给这一行补了别的 key，本插件的覆盖会让那些 key 回落到默认值**——这是"必须把上游行的每个 key 都重述一遍"这条规则的具体风险，升级检查见 [operations.md](operations.md)。

用户若有自己的 `cordis.patch.yml` 覆盖 `connection`，它会排在本插件之后并取胜，此时用户需要自己重述 `trustedHosts`。

### 权威的运行期更新

`HostConnectionService` 把 `trustedHosts` 存成构造期快照，没有 setter，所以"改权威要重启 profile"是最省事的做法——但用户改了卡片里的地址却没有任何反应，是更差的体验。`trust` 模块因此让那一行重新解析自己的配置：

```ts
const entry = ctx.loader.resolve('connection')      // Loader 继承 EntryTree
await entry.fiber?.update(entry.options.config, true)
```

`entry.options.config` 是**未求值**的原始配置，仍然带着 `!!js` 表达式；`Fiber.update` 会用当前 `ctx` 重新求值它，`noSave = true` 让 loader 的写回监听器跳过，因此解析出的字面量不会覆盖配置文件里那行表达式。fiber 重启时 `/api` 路由先注销再注册。

这个动作只在权威的规范化结果**真的变了**时执行，所以普通保存不会扰动正在使用的连接。

## 插件入口

```ts
export const name = 'web-relay'
export const inject = ['webServer', 'subprocess', 'timer', 'credentials', 'settings']
export const Config = /* Schemastery schema，见 configuration.md */
export function apply(ctx: Context, config: RelayConfig): void { ... }
```

- `inject` 里**不包含 `connection`**。`connection` 行反过来要注入 `webRelay`，如果把 `connection` 放进顶层 `inject`，两侧就会互相等待。需要 `connection` 的功能（`/relay/enter` 里的 `authenticatedUrl`）放在独立的 `ctx.inject(['connection'], (c) => ...)` 回调里注册，和 `@deepseek-ai/dsh-client-connection` 自己用 `ctx.inject(['webServer'], ...)` 的写法一致。
- `apply` 是**同步**函数（不返回 Promise），因为它必须在返回前把 `webRelay` 服务提供出去，不能让 `connection` 行空等。
- 所有注册都走 `ctx.effect(...)` / `ctx.on(...)`，用返回的 disposer 完成卸载；不使用模块级副作用。

## `webRelay` 服务面

```ts
export interface WebRelayHandle {
  /** 当前应当被围栏接受的权威（规范化后的 host[:port]）。未配置时为空数组。 */
  readonly trustedHosts: readonly string[]
  /** 当前权威；未配置时为 undefined。 */
  authority(): string | undefined
  /** 引导与隧道状态快照，供诊断读取；不参与配置表达式。 */
  status(): RelayStatus
}
```

服务面刻意只有三项：`trustedHosts` 是配置表达式唯一需要的东西；`authority()` 是引导、自检与卡片共用的单一权威来源；`status()` 是给日志与诊断用的只读快照。按 DSH 的服务设计规则，服务面只为当前消费者存在，因此不暴露 `start()` / `stop()` / `restart()` 这类还没有消费者的方法。

`trustedHosts` 每次读取返回新数组，配置表达式里的展开因此不会把服务内部状态泄漏出去。

## 加载与生效顺序

`apply` 期间按顺序完成：

1. 读 `ctx.webServer.port` 与 `ctx.webServer.host`：前者是隧道目标端口，后者用于启动自检判断"是否只绑在 loopback"。
2. 同步 `provide('webRelay', ...)`。此时 settings 尚未读取，`authority()` 返回 `undefined`，`trustedHosts` 为空数组。
3. 注册 `/relay/enter` 一条精确路由（`entry.enabled` 为真时）。
4. 在 `ctx.inject(['settings'], ...)` 回调里注册两个命名空间并读取当前值。settings 在更早的基础层行里就绪，该回调同步执行，因此**已保存的权威在第 2 步之后的同一轮里就可用**。
5. settings 变化时重新计算权威；结果变了就重解析 `connection` 行（见上）。
6. 部署参数齐全且 `tunnel.autoStart` 为真时启动引导与隧道；`Deployment` 不齐全时什么都不做，记录里显示等待配置。

第 2 步必须早于第 3 步，且不依赖第 5、6 步。整个 `apply` 不做任何自包含的失败校验：地址、口令、路径都来自 settings 且可能是空的，把校验放在这里只会让填错地址的 profile 起不来。可失败的动作全部落在引导步骤里，以文本呈现，见 [bootstrap.md](bootstrap.md)。

## 安装、卸载与升级

```
dsh plugin --profile web add file:/path/to/dsh-web-relay    # 安装
dsh plugin --profile web remove dsh-web-relay               # 卸载
```

- 安装只改 profile 的 bundle 列表与依赖，不碰 DSH 源码；插件的两行 patch 随 bundle 层生效。
- 卸载会移除行与浏览器名册条目，但**不会**回滚中继上的改动（`relay` 账号、`sshd` 片段、Caddyfile、证书）。中继侧清理步骤见 [operations.md](operations.md)，插件不去清理别人的机器。
- 升级时对照 [operations.md](operations.md) 的"升级 DSH"两件事。插件自身用 peer 依赖的版本范围约束 `dsh-host-webserver` / `dsh-credentials` / `dsh-settings` / `dsh-subprocess` / `dsh-client-connection`，但版本范围只能保证"装的是兼容版本"，不能保证"配置 key 没变"。

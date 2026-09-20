# 设置命名空间与客户端卡片

插件把部署参数放在 settings 里，而不是放在 `cordis.patch.yml` 里。理由是这些值有写入者、生命周期、保密级别三个属性都对不上 patch：它们由用户填写、在运行期变化、其中一个是口令。

## 两个命名空间

| 命名空间 | 拥有者 | 注册方式 | 用途 |
| --- | --- | --- | --- |
| `web-relay` | 用户写，插件读 | `ctx.settings.installSection(ctx, 'web-relay', Config, base, hooks)` | 部署参数，字段见 [configuration.md](../configuration.md) |
| `web-relay-record` | 插件写，用户只读 | `ctx.settings.register('web-relay-record', Config, { base })` | 引导状态与生成物，卡片唯一的宿主状态通道 |

`web-relay` 用 `installSection`，因为它需要 `setSource`/`onChange` 这对钩子：`setSource` 让插件始终持有"当前权威值"的取值函数（settings 服务在时取设置层，服务不在时回落到组合层默认值）；`onChange` 在用户保存、设置文档被外部改动、以及设置服务挂载或卸载时都会触发，插件在这里做一次规范化并决定要重做什么。注册时传 `applies: 'live'`，描述符会如实告诉界面这些改动不需要重启。

`web-relay-record` 用 `register`，因为它需要返回的作用域去写：插件通过 `scope.replace(section)` 发布整份记录。它同样带一个 `validate`，用交叉字段约束挡住"插件不该接受的组合"，让写入方在 `update`/`replace` 时就失败，而不是存下一个会让拥有者静默失效的值。

两个命名空间都注册在插件的 fiber 上，所以卸载插件会连同命名空间和观察者一起消失。

## 卡片

卡片是插件唯一的用户界面，也是首次配置的入口。

**注册。** 客户端半边向 `settings.plugin.item` 注册一条以命名空间为键的条目：

```
ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
  name: 'settings.plugin.item',
  key: 'web-relay',
  locale: NS,
  inject: () => card.inject(),
}, WebRelayCard))
```

槽位以命名空间为键，是这套 UI 给仓外插件的正式扩展点：插件在宿主注册自己的命名空间，在浏览器注册同名的卡片，中间的分类页只负责配对与堆叠，永远不知道这个命名空间是什么意思。

**读取。** 卡片用 `ctx.settingsScope.bind({ namespace: 'web-relay' })` 拿到自己的作用域，再用同一套服务拿到 `web-relay-record` 的只读作用域。宿主状态与用户输入因此走同一条通道，插件不需要自己的 Remote 命名空间——那会要求 typert 生成器参与构建，属于"为一个状态面板引入一整套代码生成"的成本。

**表单。** 卡片自己暂存草稿，只在用户点保存时写一次。每次设置写入都是一次带修订号栅栏的持久文档变更，逐字段提交会把一次编辑变成用户没要求也无法预览的多次写入。口令字段没有可回填的值（凭据不回传），所以草稿初始为空，空草稿不写任何东西，控件显示"已设置 / 未设置"。

**状态区。** 卡片用 `web-relay-record` 渲染：状态、权威、入口 URL、CA 下载地址与指纹、逐步引导结果、最近一次错误、最近一次转发前预检。状态区是只读的。

**按钮。**

| 按钮 | 动作 |
| --- | --- |
| 保存 | 写 `web-relay`；插件在 `onChange` 里规范化并重新引导受影响的步骤 |
| 重新引导 | 把 `bootstrapRequest` 加一后保存 |
| 重新拉起隧道 | 把 `tunnel.autoStart` 写为真；隧道守护会立即重连 |

## 密钥处理

`gateway.password` 用 `z.string().role('secret')` 声明。设置描述符在 `redactSecrets` 下把这个字段整体移出 `value`/`base`/`user`，改放进 `secrets` 列表，只报"在哪些路径上已设置"。于是：

- 口令值从不进入发给浏览器的响应，卡片无法显示也无法回填它。
- 口令值仍以明文存在 `$DSH_HOME/settings.yaml`（`0600`）。这是选择"用户自填口令"的必然结果，写在这里以免被误认为已加密。
- 引导时明文只出现在一处：交给中继上 `caddy hash-password` 的 stdin。它不出现在任何命令行参数、日志、记录或临时文件里。

管理账号不走口令：公钥登录与免密 sudo 是用户事先准备好的前提，插件不存管理口令，见 [configuration.md](../configuration.md) 的"配置前的前提"。

`vps.identityFile` 指向管理账号私钥。插件只把它拼进 `-i`，不读取、不复制、不改权限；文件权限不对时 `ssh` 自己会拒绝，插件只把原始错误转述出来。

## 首次配置必须在本机完成

DSH 的客户端在非 loopback 页面上把设置持久化降级为内存，`settingsScope` 因此报告 `writable: false`、`mode: 'memory'`，写入不落盘。这意味着：

- 卡片在服务器本机的 `http://127.0.0.1:<port>` 页面上可用。
- 通过中继打开的手机页面上，卡片只读，保存按钮不可用。

这不是插件可以绕过的限制，而是流程的一部分：**首次配置与所有重新引导都在服务器本机做**，远程只需打开入口 URL 并输入网关口令。列出全部"必须本地完成的操作"的地方是 [operations.md](operations.md)。

首次配置只能在本机做还有一层便利：此时权威尚未注册，手机根本还开不了那个页面。

## 变更传播

一次保存之后，插件在 `onChange` 里走同一条链路：

```
设置提交
  → 规范化成 Deployment（地址、账号身份、路径）
  → 对比上一份 Deployment，得出变了什么
  → 权威变了：重解析 connection 行（见 trust.md），把 publicAuthority 写进记录
  → 凭据或地址变了：重置引导游标，按 bootstrap.md 从受影响的步骤开始
  → 隧道目标变了：重启隧道子进程
  → 每次变更后重写 web-relay-record
```

链路是单向的：只有设置提交会启动一次重配置，`web-relay-record` 的写入不会再触发它（插件自己写记录时不再走 `onChange` 的判断，因为记录的差异不参与 `Deployment` 的规范化）。

## 客户端半边的加载

卡片要作为仓外包被浏览器加载，需要包满足平台的三件事：

| 要求 | 落点 |
| --- | --- |
| 包能被宿主定位并列出 | 包根有 `package.json`，且 `exports['./client']` 指向构建产物 |
| 浏览器名册包含它 | `package.json` 的 `dsh.client = { platform: 'web', inject: [ … ] }` |
| 打包成闭包工厂 | 产物调用 `window.__ModuleLoader__.load({ id, factory })`，外部依赖经注入的 `require` 解析 |

平台模块表是封闭的，只有九项：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。卡片的运行期 import 只用得到其中四到五项，其余能力全部走服务：`ctx.slots`、`ctx.settingsScope`、`ctx.locale`。仓库内的 `CardForm` 与 `PluginCard` 不对外导出，所以卡片用 `@deepseek-ai/dsh-client-ui-primitives` 的既有控件自绘表单与状态区，文案走 `ctx.locale` 的字典。

`dsh.client.inject` 列出必须先加载的客户端半边，这里至少是 `@deepseek-ai/dsh-client-ui-settings`（`ctx.settingsScope` 的声明方）与 `@deepseek-ai/dsh-client-ui-settings-plugins`（`settings.plugin.item` 的声明方）。槽位声明与加载顺序不一致时 `ctx.slots.inject` 会等待，所以列出顺序只影响首屏出现卡片的早晚。

## 失败模式

| 现象 | 原因 | 表现 |
| --- | --- | --- |
| 卡片不存在 | 客户端半边没被打进名册，或 `exports['./client']` 缺失 | 插件功能正常，但没有界面；`dsh --dump-config` 仍能看到行 |
| 卡片显示"命名空间未提供" | 宿主注册失败或插件行未加载 | 卡片渲染空态，不报错 |
| 保存按钮不可用 | 当前页面不是 loopback | 只读态，见上文 |
| 保存被拒 | `validate` 拒绝了这个组合 | 界面保留草稿并显示原因，文档不变 |
| 保存成功但没有动作 | 改动不影响 `Deployment` | 记录不变，只有 `updatedAt` 前移 |

# 实现：打包与分发

插件以 npm 包的形式装进某个 profile，一条命令把两个半边装好并生效，且不改动 DSH 源码。

## 包结构

```
dsh-web-relay/
├── package.json          # dsh.bundle + dsh.client 清单
├── cordis.patch.yml      # 本插件贡献的配置层
├── src/                  # TypeScript 源码
│   ├── index.ts          # 插件入口：name / inject / Config / apply
│   ├── client/           # 浏览器半边：设置菜单里的「远程访问」页
│   └── ...
├── lib/                  # 构建产物（不进 git）
├── deploy/               # 引导写入中继的配置模板
└── docs/                 # 本目录
```

`src/` 与 `lib/` 都在包根下一层，因此模板目录的相对定位在源码与产物下是同一个值。

## manifest

```json
{
  "name": "dsh-web-relay",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "deploy"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  }
}
```

`files` 决定发布内容：源码与文档不进包。注意 `deploy/` **必须**在包里——引导在运行期从包目录读取模板。

### 依赖声明规则

依赖遵守 DSH 对树外插件的规则：**一律 peer + dev，绝不写 `dependencies`**。profile 的 pnpm 配置会把 peer 落到 dsh 安装自身的副本上；写成 `dependencies` 会拉进第二份实例，导致服务身份不一致。

`@deepseek-ai/dsh*` 的 peer 一律写 `workspace:*`。DSH 在装载 profile 前会跑一道兼容门，把 `workspace:^`、`workspace:~`、`workspace:*` 三种协议统一替换成**运行版本**再判 semver。于是：

- 写固定版本范围会在 DSH 升级时把整个包判成不兼容——bundle 被跳过，隧道根本不会起来，中继上每个请求都回 502，而日志里只有一行 `skipping profile bundle`。
- 写 `workspace:*` 等于"跟运行中的 dsh 同版本"，这是 DSH 仓库内的通行写法，也是唯一不需要每次升级都改的地方。

`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/schemastery` 不匹配 `@deepseek-ai/dsh*`，不受这道门检查，保持普通版本范围。

devDependencies 用 `link:` 指向本机的 DSH checkout，只用于本地类型解析与构建。

想临时放行一个已知不兼容的版本，有一条不改包的路：`dsh plugin --profile <p> allow-version …`（写进 profile 的 `compatibility.json`）。它是**逐精确版本**的豁免，升级后自动失效，只适合临时排查。

## 浏览器半边如何被发现

浏览器名册由宿主扫描 profile 里的行，逐个读那个包根目录的 `package.json`。四个条件缺一不可：

| 条件 | 落点 | 缺失后果 |
| --- | --- | --- |
| 行能被解析到包根 | 行 `name` 是包名，`package.json` 可被解析 | 该行被当成非客户端行，静默跳过 |
| 声明了客户端半边 | `dsh.client.platform === 'web'` | 同上 |
| 指出了产物 | `exports['./client']` 指向构建产物 | 直接抛错，说声明了客户端半边却没有对应的导出 |
| 产物是闭包工厂 | 构建产物调用 `window.__ModuleLoader__.load({ id, factory })` | 加载器无法取得模块工厂 |

`dsh.client.inject` 是**信息性**的包名列表，不参与 Cordis 注入；真正的服务依赖写在客户端模块自己导出的 `inject` 里（`ctx.locale`、`ctx.slots`、`ctx.configForms` 分别来自列出的三个包）。

设置页能用的模块是固定的九项：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。其余包只能做**类型**导入（类型导入会被构建擦除，不产生模块请求），所以设置页用 `ui-primitives` 自绘表单控件。本插件两边都不需要 `external`。

## 安装、卸载与升级

```
dsh plugin --profile <profile> add file:/path/to/dsh-web-relay    # 安装
dsh plugin --profile <profile> remove dsh-web-relay               # 卸载
```

- 安装只改 profile 的 bundle 列表与依赖，不碰 DSH 源码；插件的两行 patch 随 bundle 层生效。
- 卸载会移除行与浏览器名册条目，但**不会**回滚中继上的改动（`relay` 账号、sshd 片段、Caddyfile、证书）。中继侧清理步骤见 [排障与维护](../troubleshooting.md#卸载后清理中继)。
- 升级时对照两件事：
  1. `connection` 行是否新增了配置 key。patch 替换的是整行 `config`，新增的 key 会在本插件的覆盖下回落到默认值。
  2. 权威围栏与 Cookie 命名规则是否变化。这两个是本设计依赖的接口，发布说明里若有相关改动就要重读。

peer 依赖的版本范围只能保证"装的是兼容版本"，**不保证"配置 key 没变"**。

## 构建与测试

```
pnpm run build       # tsc（宿主 + 客户端）后打包客户端产物
pnpm run typecheck
pnpm test            # 先 build，再跑 tests/*.test.js
```

客户端的打包脚本在本包的 `scripts/build-client.mjs`：它把浏览器半边打成闭包工厂产物。

## 相关

- 配置层的接线与行序：[architecture.md](architecture.md#配置层与行序)
- 依赖的 DSH 接口与假设：[assumptions.md](assumptions.md)

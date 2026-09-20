# 后续项与假设核对

本文件回答两个问题：这份设计明确**不做**什么，以及各条设计假设与它们的核对方式。已经验证过的结论写在对应模块文档里，不在这里重复。

## 明确不做

| 项 | 为什么不做 |
| --- | --- |
| 域名与 ACME 自动证书 | 用户当前没有域名。有域名后按 [configuration.md](configuration.md) 把站点地址与证书来源换掉即可，不需要改插件 |
| 中继侧状态页 | 免登录地把"隧道是否连通"暴露在公网，本身是一个需要额外设计的信息面；卡片与启动自检已经覆盖了同一个问题 |
| 中继侧 TOTP | 需要在中继上多跑一个服务，破坏"中继只有 sshd 与 Caddy"这条简化 |
| 多中继与故障切换 | 单用户场景收益低，而代价是权威集合、入口 URL、自检都要处理"哪一个可用" |
| 中继上的第二个 HTTP 端口 | Cookie 不按端口隔离，多一个端口就多一条读到会话 Cookie 的路；这条不设开关，见 [security.md](security.md) |
| 桌面端 | Electron 走 IPC 不开端口，没有需要转发的东西 |
| 逐设备令牌与吊销 | 浏览器侧只能退化成"口令换 Cookie"，在单用户场景下并不比现在更强。全量吊销仍可用轮换 DSH 会话密钥实现，见 [modules/operations.md](modules/operations.md) |
| URL 里携带入口凭据 | 入口凭据一旦进了 URL，就会跟着收藏夹、历史与设备同步走；口令由浏览器口令框承载，只经过请求头 |
| 远程改配置 | 这是 DSH 对非 loopback 页面的既定行为，任何绕过它的做法都要在插件里另建一套配置面，规模远超本设计 |
| 中继侧定时清理监听残留 | 那需要在中继上装一个常驻单元，破坏"中继上不安装本项目的任何代码"这条；主机侧的转发前预检在需要时做同一件事，且不留下常驻物 |

## 假设与核对方式

下表列出设计所依据的假设、若错的后果与各自的核对方式。已经用真实 Caddy 验证过的部分——设计期在 loopback 上用 v2.10.0，部署的中继在 Ubuntu 26.04 上装到 2.11.4 并同样验证通过——Host 透传、`handle_errors` 接住合成 502、会话 Cookie 与 Basic 两种 WebSocket 升级、未声明 Host 的兜底、证书有效期配对、未认证响应不得带 `Set-Cookie`、给 DSH 的 Cookie 补 `Secure`（含定点匹配、站点级 `header` 的未延迟与延迟两种写法）、日志打码——不在此列，它们的结论与证据写在 [modules/relay-host.md](modules/relay-host.md) 与 [security.md](security.md)。

| 假设 | 依据 | 若错的后果 | 验证方式 |
| --- | --- | --- | --- |
| 行级 `inject` 与模块级 `inject` 是叠加的 | Loader 的 `Inject.resolve(entry.options.inject, fiber.inject)` | 覆盖 `connection` 行会丢掉 `credentials` 注入，插件启动失败 | 起一个 profile，确认 `connection` fiber 同时看到 `credentials`、`webRuntime`、`webRelay` |
| `!!js` 表达式在该行的注入就绪之后求值 | Cordis `internal/config` 的事件注释；`Fiber.update` 里的延迟求值 | 覆盖行里的 `ctx.webRelay` 为 `undefined`，权威为空，远程 403 | 同上；断言 `trustedHosts` 非空 |
| 覆盖 `connection` 行不会造成 `/api` 路由重复注册 | 覆盖按行 `id` 替换，不新增行 | `webserver: duplicate prefix route "/api"` 抛错 | 同上；起 profile 看是否报重复路由 |
| 运行期改权威可以用 `fiber.update(entry.options.config, true)` 完成 | `entry.options.config` 保存的是未求值的原始配置；`noSave` 让 loader 的写回监听跳过 | 要么权威改了不生效（要重启 profile），要么解析后的字面量被写回 `cordis.yml`，覆盖用户文件 | 改一次 `gateway.port`，确认远程入口跟着变，且 `cordis.yml` 未被改写 |
| `ctx.loader.resolve('connection')` 在运行时可用 | `Loader extends EntryTree`，`resolve` 按 `id` 查行 | 无法定位要重解析的行，只能退回到"要求用户重启" | 在卡片里触发一次权威变更，观察是否抛 `cannot resolve entry` |
| SSE（`/api` 上的长响应）穿过 Caddy + SSH 隧道不缓冲 | Caddy 对 `Content-Length` 未知的响应立即 flush | 界面长时间不刷新 | 观察一次流式响应是否逐块到达 |
| 隧道端点在 `permitlisten` 限制下只能绑 loopback | `GatewayPorts no` + 显式 `127.0.0.1:` 绑定 | 端点暴露在公网且无 TLS —— **严重** | 中继 `ss -ltnp \| grep 18080` 必须是 `127.0.0.1` |
| 客户端半边的 9 个外部模块足够渲染设置卡片 | `PLATFORM_MODULES` 的闭集；`ui-settings-plugins` 的卡片只用到基元与 slots | 卡片在浏览器里报模块解析失败 | 装好后打开设置页，确认卡片出现且可保存 |
| `ctx.settingsScope.bind({namespace})` 在插件半边可用 | `settings-scope.ts` 的 `bind` 导出 | 卡片无数据源，只能退回自建 RPC | 同上 |
| 不带 `-p` 的 `ss -ltnH 'sport = :<port>'` 能看到别的用户持有的监听端点 | 无 `-p` 时读的是内核 socket 表，不需要特权；带 `-p` 时另一个用户的进程不显示 | 转发前预检误判端口是否空闲，残留清不掉 | 在中继上以管理账号跑一次，与 `sudo ss -ltnp` 的结果比对 |
| 杀掉残留的 `sshd` 子进程后端口立刻可用 | 进程退出时内核关闭它的监听 fd；且 sshd 在 `bind` 前设了 `SO_REUSEADDR`（`channels.c` 的 `channel_setup_fwd_listener_tcpip`） | 预检杀完仍绑不上，退避继续空转 | 造一次残留（断开内网主机网络后重启插件），看下一轮是否直接成功 |
| 转发失败的两种原因只能从中继 `sshd` 日志区分 | 客户端两条路径都收敛成 `SSH2_MSG_REQUEST_FAILURE` | 把配置错当成端口残留，预检反复空跑 | 临时把 `permitlisten` 改成别的端口，观察中继日志出现 `but the request was denied.` |
| 管理账号的免密 sudo 在非交互调用下成立 | 用户在中继上预先配好；第 3 步用 `sudo -n true` 探测 | 引导停在提权步骤，`sshd` 片段与 Caddyfile 都写不下去 | 中继上跑 `sudo -n true; echo $?`，期望 0；再关掉免密验证它确实报 `a password is required` |

除客户端卡片那两项外，其余各项的核对都需要一台真实 VPS 与一台运行 `dsh web` 的内网主机；验证过的中继就是这样一组机器。前四项在 profile 启动时就会暴露，后面的项要按 [modules/bootstrap.md](modules/bootstrap.md) 的步骤顺序走完引导。

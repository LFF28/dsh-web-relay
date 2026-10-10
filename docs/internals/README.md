# 实现记录

**这一目录不是用户文档。** 面向部署者的文档在上一级（[文档索引](../README.md)）；这里记的是实现层面的东西：模块划分、中继上的目标状态、配置层的接法，以及若干条设计假设与它们的核对方式。

这些内容对维护插件、改模板、升级 DSH 的人是必要的，但对只想把它跑起来的读者是噪音。想读用户文档请回 [docs/README.md](../README.md)。

## 索引

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 插件内部模块划分、配置层（patch）与行序、`webRelay` 服务面、启动与部署时序、设置与运行记录两条通道 |
| [bootstrap.md](bootstrap.md) | 引导：命令通道与连接复用、托管块写入、14 步的动作与幂等依据 |
| [relay-host.md](relay-host.md) | 中继主机的目标状态：sshd 片段、`authorized_keys`、Caddyfile、fail2ban 与它们的约束 |
| [tunnel.md](tunnel.md) | 隧道守护：子进程规格、转发前预检、状态机、生命周期与释放 |
| [public-entry.md](public-entry.md) | 权威注册与自检、换票点、部署后的公网探测 |
| [packaging.md](packaging.md) | 包结构、manifest、依赖声明规则、浏览器半边的发现方式、安装/卸载/升级 |
| [assumptions.md](assumptions.md) | 设计所依据的假设、若错的后果与核对方式 |

## 阅读顺序

想理解整体，先 [architecture.md](architecture.md)，它是其余各篇的接线图。改中继侧配置从 [relay-host.md](relay-host.md) 入手，改引导流程从 [bootstrap.md](bootstrap.md) 入手，改隧道行为从 [tunnel.md](tunnel.md) 入手。

## 与源码的关系

| 内容 | 源码 |
| --- | --- |
| 配置 schema 与默认值 | `src/config.ts` |
| 引导步骤 | `src/bootstrap.ts`（`STEP_TITLES` 是步骤编号的权威） |
| 中继侧模板 | `deploy/` |
| 隧道 | `src/tunnel.ts`、`src/preflight.ts`、`src/ssh.ts` |
| 权威与自检 | `src/trust.ts`、`src/authority.ts` |
| 换票点 | `src/entry.ts` |
| 编排 | `src/service.ts` |
| 设置页 | `src/client/` |

源码注释里对 `docs/` 路径的引用都指向本目录或上一级的用户文档。

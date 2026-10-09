/**
 * 插件在中继与内网主机上落下的每一条路径。
 *
 * 全部写成函数而不是常量：`$DSH_HOME` 可能在模块加载之后才被设置（测试与启动器
 * 都会这么做），提前求值会把它钉死在错误的目录上。
 *
 * 中继上的路径不在这里——那些用 `deploy/` 模板里的字面量，因为引导脚本是在
 * 别人的机器上跑的，路径必须是它自己读得懂的绝对路径。
 * @module dsh-web-relay/paths
 */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** 插件在 `$DSH_HOME` 下独占的目录名。 */
const RELAY_DIR = 'dsh-web-relay'

/**
 * 插件的数据根目录。
 * @returns `$DSH_HOME/dsh-web-relay`。
 */
export function relayRoot(): string {
  return join(resolveDshHome(), RELAY_DIR)
}

/**
 * 内网主机侧密钥与 `known_hosts` 所在目录。
 * @returns `<root>/ssh`。
 */
export function sshDir(): string {
  return join(relayRoot(), 'ssh')
}

/**
 * 隧道专用私钥（引导第 1 步生成，`0600`）。它只用于登录中继的受限账号 `relay`。
 * @returns 私钥绝对路径。
 */
export function relayPrivateKey(): string {
  return join(sshDir(), 'relay_ed25519')
}

/**
 * 隧道专用公钥（写进中继的 `authorized_keys` 托管块）。
 * @returns 公钥绝对路径。
 */
export function relayPublicKey(): string {
  return join(sshDir(), 'relay_ed25519.pub')
}

/**
 * 本机专用的 `known_hosts`。
 *
 * 刻意不复用 `~/.ssh/known_hosts`：那份文件里有用户自己的主机，而隧道与引导都用
 * `StrictHostKeyChecking=yes`，一个只有这一台中继的独立文件才能让「首次连接询问
 * 指纹」这件事有一个确定的答案。
 * @returns `known_hosts` 绝对路径。
 */
export function knownHosts(): string {
  return join(sshDir(), 'known_hosts')
}

/**
 * 管理连接的 ControlMaster 套接字目录。
 *
 * 引导要开十几条短连接（每条一个步骤），而到中继这段路径有丢包，独立握手越多、
 * 整轮失败率越高。让它们复用一个 master 就把握手从十几次压到一次。
 *
 * 目录名取 `cm` 而不是更长的名字是为了**长度预算**：`ControlPath` 是 unix 套接字
 * 路径，超过 108 字节时 `ssh` 直接拒绝启动（实测报 `ControlPath too long`），而
 * 中间还要塞一个 40 字符的 `%C` 哈希。`$DSH_HOME` 一旦很长，短目录名就是唯一还
 * 留有余地的地方。
 *
 * 它必须真实存在：目录缺失时 `ssh` 不是回退而是直接以 255 失败（实测
 * `unix_listener: cannot bind to path …: No such file or directory`），所以创建
 * 时机与 `sshDir()` 一致，都在启动与每次部署之前。
 * @returns `<root>/ssh/cm`。
 */
export function controlSocketDir(): string {
  return join(sshDir(), 'cm')
}

/**
 * 从引导第 10 步取回的中继 CA 根证书所在目录。
 * @returns `<root>/ca`。
 */
export function caDir(): string {
  return join(relayRoot(), 'ca')
}

/**
 * 中继 CA 根证书在本机的副本（`0644`），由引导第 10 步从服务器取回。
 * @returns 根证书绝对路径。
 */
export function caCert(): string {
  return join(caDir(), 'root.crt')
}

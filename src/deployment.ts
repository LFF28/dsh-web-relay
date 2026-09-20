/**
 * 部署参数从设置命名空间到一份不可变 `Deployment` 的规范化，以及两次部署之间的差异。
 *
 * 规范化是整个插件的分叉点：`apply` 只读它，引导、隧道、预检、权威注册都拿它当
 * 输入。差异则决定「用户点了保存之后要重做哪一半」——把这件事集中在这里，是为了
 * 让「改口令」与「改地址」不会在别处被混成同一种变化。
 * @module dsh-web-relay/deployment
 */

import { canonicalHostname, publicAuthority } from './authority.js'
import type { DeploymentConfig } from './config.js'

/** 规范化后的部署参数。除 `authority` 外都必然有值，因此下游不需要再判空。 */
export interface Deployment {
  /** 中继主机地址。 */
  readonly host: string
  /** 管理连接的 SSH 端口。 */
  readonly sshPort: number
  /** 管理账号。 */
  readonly user: string
  /** 管理账号私钥路径；留空表示走系统身份解析。 */
  readonly identityFile: string | undefined
  /** 期望的中继主机公钥指纹；留空表示首次连接按 TOFU 接受。 */
  readonly hostKeyFingerprint: string | undefined
  /** 公网入口 HTTPS 端口。 */
  readonly gatewayPort: number
  /** 网关口令；为空表示尚未配置。 */
  readonly password: string
  /** 参数齐全时是否自动拉起隧道。 */
  readonly autoStart: boolean
  /** 用户的重新引导请求计数。 */
  readonly bootstrapRequest: number
  /** 由 `host` 与 `gatewayPort` 推出的公网权威；`host` 为空或形状非法时为 undefined。 */
  readonly authority: string | undefined
  /** 权威里不带端口的主机名；Caddy 的 `default_sni` 需要它。 */
  readonly hostname: string | undefined
}

/** 把设置里的原始值规范化成一份快照。 */
export function normalize(raw: DeploymentConfig): Deployment {
  const host = (raw.vps?.host ?? '').trim()
  const gatewayPort = raw.gateway?.port ?? 8443
  return {
    host,
    sshPort: raw.vps?.port ?? 22,
    user: (raw.vps?.user ?? 'root').trim() || 'root',
    identityFile: nonEmpty(raw.vps?.identityFile),
    hostKeyFingerprint: nonEmpty(raw.vps?.hostKeyFingerprint),
    gatewayPort,
    password: raw.gateway?.password ?? '',
    autoStart: raw.tunnel?.autoStart ?? true,
    bootstrapRequest: raw.bootstrapRequest ?? 0,
    authority: host === '' ? undefined : publicAuthority(host, gatewayPort),
    hostname: host === '' ? undefined : canonicalHostname(host),
  }
}

/**
 * 空串与未设置在这里是同一种东西。
 *
 * 设置里清空一个字段写入的是空串，而 schema 默认值不会出现。下游只想问「有没有」，
 * 所以在这一步就把两者合并成 `undefined`。
 * @param value - 原始字符串。
 * @returns 去空白后的值，空则为 undefined。
 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 部署参数是否齐全到可以动作。
 *
 * 只有两个字段是硬要求：没有地址就无处可去，没有口令就配不出网关。其余字段都有
 * 可用的默认值。
 * @param deployment - 规范化结果。
 * @returns 可以引导与拉起隧道时为 true。
 */
export function isRunnable(deployment: Deployment): boolean {
  return deployment.host !== '' && deployment.password !== ''
}

/** 两次部署之间「要重做什么」的判定结果。 */
export interface DeploymentChange {
  /** 权威变了：围栏要重解析，既有 Cookie 会全部失效。 */
  readonly authority: boolean
  /** 管理身份变了：下一次引导与预检要换凭据。 */
  readonly adminIdentity: boolean
  /** 口令变了：要重算 bcrypt、重置网关会话密钥、重写 Caddyfile。 */
  readonly password: boolean
  /** 期望的主机指纹变了：下一次引导要重新比对。 */
  readonly hostKey: boolean
  /** 自动拉起开关变了。 */
  readonly autoStart: boolean
  /** 用户点了「重新引导」或第一次填全参数。 */
  readonly bootstrap: boolean
}

/**
 * 比较两份部署，得出要重做的部分。
 * @param previous - 上一次的部署；从未有过时为 undefined。
 * @param next - 本次的部署。
 * @returns 每一项的变化判定。
 */
export function diff(previous: Deployment | undefined, next: Deployment): DeploymentChange {
  if (previous === undefined) {
    // 首次对账：要不要引导由记录里的 `state` 决定，不由这里决定——否则每次重启
    // DSH 都会把整串引导再跑一遍。
    return {
      authority: next.authority !== undefined,
      adminIdentity: false,
      password: false,
      hostKey: false,
      autoStart: false,
      bootstrap: false,
    }
  }
  return {
    authority: previous.authority !== next.authority,
    adminIdentity: previous.host !== next.host || previous.sshPort !== next.sshPort
      || previous.user !== next.user || previous.identityFile !== next.identityFile,
    password: previous.password !== next.password,
    hostKey: previous.hostKeyFingerprint !== next.hostKeyFingerprint,
    autoStart: previous.autoStart !== next.autoStart,
    bootstrap: previous.bootstrapRequest !== next.bootstrapRequest,
  }
}

/**
 * 是否有任何一项要求重跑引导。
 * @param change - 差异结果。
 * @returns 需要重跑时为 true。
 */
export function needsBootstrap(change: DeploymentChange): boolean {
  return change.bootstrap || change.adminIdentity || change.password || change.hostKey
}

/**
 * 是否需要重启隧道子进程。
 * @param change - 差异结果。
 * @returns 需要重连时为 true。
 */
export function needsTunnelRestart(change: DeploymentChange): boolean {
  // 地址或账号变了，隧道连的就不再是同一个地方；口令变了则隧道不受影响——它用的
  // 是受限账号与专用私钥，与网关口令无关。
  return change.adminIdentity
}

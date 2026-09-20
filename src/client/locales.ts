/**
 * 卡片的两份文案。
 *
 * 全部走字典：产品文案由 locale 拥有，写死在组件里会被 `verify-client-ui-i18n`
 * 拦下，而且中英切换时留一半硬编码比全硬编码更难发现。
 * @module dsh-web-relay/client/locales
 */

// 仅类型：声明本命名空间的文案键表，`ctx.locale.register` 与 `PropsLocale` 都按它推导。
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 本卡片用到的文案键。 */
export type RelayLocaleKey =
  | 'title' | 'description'
  | 'vpsSection' | 'host' | 'hostHint' | 'sshPort' | 'user' | 'userHint'
  | 'identityFile' | 'identityFileHint' | 'hostKeyFingerprint' | 'hostKeyFingerprintHint'
  | 'gatewaySection' | 'gatewayPort' | 'gatewayPortHint' | 'password' | 'passwordHint'
  | 'tunnelSection' | 'autoStart' | 'autoStartHint'
  | 'save' | 'saving' | 'saveFailed' | 'saved' | 'discard' | 'reload'
  | 'statusSection' | 'stateUnconfigured' | 'stateBootstrapping' | 'stateReady' | 'stateFailed'
  | 'tunnelStopped' | 'tunnelStarting' | 'tunnelRunning' | 'tunnelBackingOff'
  | 'authority' | 'entryUrl' | 'caFingerprint' | 'hostKeyObserved'
  | 'lastPreflight' | 'preflightFree' | 'preflightReleased' | 'preflightSkipped' | 'preflightRefused'
  | 'steps' | 'stepOk' | 'stepFailed' | 'stepSkipped' | 'lastError'
  | 'empty' | 'readOnly'

/** 简体中文文案。 */
export const zh: Record<RelayLocaleKey, string> = {
  title: '远程访问（Web Relay）',
  description: '把本机的 dsh web 经一台公网中继交给远程设备：中继只做转发，认证仍由 DSH 自己完成。',
  vpsSection: '中继主机',
  host: '地址',
  hostHint: 'IP 或主机名；带端口时以你填的端口为准，否则用下面的网关端口。',
  sshPort: 'SSH 端口',
  user: '管理账号',
  userHint: '用于引导与转发前预检。必须已配置公钥登录；非 root 时还要免密 sudo。',
  identityFile: '管理账号私钥',
  identityFileHint: '留空则用系统的身份解析（~/.ssh/config、默认私钥、ssh-agent）。',
  hostKeyFingerprint: '中继主机密钥指纹',
  hostKeyFingerprintHint: 'SHA256:… 形式。留空则首次连接按 TOFU 接受，指纹会写进下方记录供你核对。',
  gatewaySection: '公网入口',
  gatewayPort: '网关端口',
  gatewayPortHint: '中继上唯一的 HTTP 端口，安全组需要放行它。',
  password: '网关口令',
  passwordHint: '留空表示不修改。口令只用于在中继上算出 bcrypt 哈希，明文不落中继磁盘。',
  tunnelSection: '隧道',
  autoStart: '参数齐全时自动拉起隧道',
  autoStartHint: '关掉后插件仍会完成引导，但不维护 ssh -R 连接，需要时再打开。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '保存失败',
  saved: '已保存',
  discard: '放弃修改',
  reload: '重新引导',
  statusSection: '当前状态',
  stateUnconfigured: '等待配置',
  stateBootstrapping: '正在引导',
  stateReady: '就绪',
  stateFailed: '失败',
  tunnelStopped: '未连接',
  tunnelStarting: '正在连接',
  tunnelRunning: '已连接',
  tunnelBackingOff: '重连等待中',
  authority: '权威',
  entryUrl: '访问地址',
  caFingerprint: '根证书指纹',
  hostKeyObserved: '中继主机密钥',
  lastPreflight: '转发前预检',
  preflightFree: '端口空闲',
  preflightReleased: '清掉了残留监听',
  preflightSkipped: '未执行',
  preflightRefused: '被别的进程占用，未动手',
  steps: '引导步骤',
  stepOk: '完成',
  stepFailed: '失败',
  stepSkipped: '未执行',
  lastError: '最近一次失败',
  empty: '还没有记录。填好上面的参数并保存，插件会在中继上完成引导。',
  readOnly: '当前页面不在服务器本机，设置只读。请在中继主机本机的浏览器里修改。',
}

/** English copy. */
export const en: Record<RelayLocaleKey, string> = {
  title: 'Remote access (Web Relay)',
  description: 'Expose this machine\u2019s dsh web through a public relay. The relay only forwards; DSH still authenticates.',
  vpsSection: 'Relay host',
  host: 'Address',
  hostHint: 'IP or hostname. A port written here wins over the gateway port below.',
  sshPort: 'SSH port',
  user: 'Admin account',
  userHint: 'Used for bootstrap and the pre-connect preflight. Public-key login is required; a non-root account also needs passwordless sudo.',
  identityFile: 'Admin identity file',
  identityFileHint: 'Leave empty to use system identity resolution (~/.ssh/config, default keys, ssh-agent).',
  hostKeyFingerprint: 'Relay host key fingerprint',
  hostKeyFingerprintHint: 'SHA256:… form. Empty trusts the first connection (TOFU) and records the fingerprint below for you to compare.',
  gatewaySection: 'Public entry',
  gatewayPort: 'Gateway port',
  gatewayPortHint: 'The relay\u2019s only HTTP port; the security group must allow it.',
  password: 'Gateway password',
  passwordHint: 'Empty keeps the current one. It is only hashed on the relay; the plaintext never lands on the relay\u2019s disk.',
  tunnelSection: 'Tunnel',
  autoStart: 'Start the tunnel automatically once the settings are complete',
  autoStartHint: 'When off, bootstrap still runs but no ssh -R connection is kept.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'Save failed',
  saved: 'Saved',
  discard: 'Discard',
  reload: 'Re-bootstrap',
  statusSection: 'Status',
  stateUnconfigured: 'Waiting for settings',
  stateBootstrapping: 'Bootstrapping',
  stateReady: 'Ready',
  stateFailed: 'Failed',
  tunnelStopped: 'Disconnected',
  tunnelStarting: 'Connecting',
  tunnelRunning: 'Connected',
  tunnelBackingOff: 'Waiting to retry',
  authority: 'Authority',
  entryUrl: 'URL',
  caFingerprint: 'Root fingerprint',
  hostKeyObserved: 'Relay host key',
  lastPreflight: 'Pre-connect preflight',
  preflightFree: 'Port free',
  preflightReleased: 'Released a stale listener',
  preflightSkipped: 'Not run',
  preflightRefused: 'Held by another process; left alone',
  steps: 'Bootstrap steps',
  stepOk: 'done',
  stepFailed: 'failed',
  stepSkipped: 'skipped',
  lastError: 'Last failure',
  empty: 'No record yet. Fill in the settings above and save; the plugin bootstraps the relay for you.',
  readOnly: 'This page is not on the relay host itself, so settings are read-only. Edit them from a browser on that host.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 远程访问卡片。 */
    'web-relay': RelayLocaleKey
  }
}

/**
 * 设置页的两份文案。
 *
 * 全部走字典：产品文案由 locale 拥有，写死在组件里会被 `verify-client-ui-i18n`
 * 拦下，而且中英切换时留一半硬编码比全硬编码更难发现。
 * @module dsh-web-relay/client/locales
 */

// 仅类型：声明本命名空间的文案键表，`ctx.locale.register` 与 `PropsLocale` 都按它推导。
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** 本页面用到的文案键。 */
export type RelayLocaleKey =
  | 'nav' | 'title' | 'description'
  | 'vpsSection' | 'host' | 'hostHint' | 'sshPort' | 'user' | 'userHint'
  | 'identityFile' | 'identityFileHint' | 'hostKeyFingerprint' | 'hostKeyFingerprintHint'
  | 'gatewaySection' | 'gatewayPort' | 'gatewayPortHint' | 'password' | 'passwordHint'
  | 'startupSection' | 'autoDeploy' | 'autoDeployHint'
  | 'deploy' | 'deploying' | 'deployFailed' | 'deployHint' | 'incomplete' | 'refused' | 'discard' | 'loading'
  | 'statusSection' | 'stateUnconfigured' | 'stateBootstrapping' | 'stateReady' | 'stateFailed'
  | 'tunnelStopped' | 'tunnelStarting' | 'tunnelRunning' | 'tunnelBackingOff'
  | 'authority' | 'entryUrl' | 'caFingerprint' | 'hostKeyObserved' | 'downloadCa'
  | 'lastPreflight' | 'preflightFree' | 'preflightReleased' | 'preflightSkipped' | 'preflightRefused'
  | 'steps' | 'stepOk' | 'stepFailed' | 'stepSkipped' | 'lastError'
  | 'empty' | 'readOnly'

/** 简体中文文案。 */
export const zh: Record<RelayLocaleKey, string> = {
  nav: '远程访问',
  title: '远程访问（Web Relay）',
  description: '把本机的 dsh web 经一台公网中继交给远程设备：中继只做转发，认证仍由 DSH 自己完成。这张页面上的改动只留在浏览器里，点「部署」才会写进设置并在中继上完整重跑一遍引导。',
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
  passwordHint: '必填，每次部署都要重填：口令不回传浏览器，页面从来没见过它。它只用于在中继上算出 bcrypt 哈希，明文不落中继磁盘。',
  startupSection: '启动',
  autoDeploy: '随 DSH 启动自动部署',
  autoDeployHint: '默认关闭。关掉时每次重启都要在本页点一次「部署」。打开它要这次部署成功才算数：成功后 DSH 一启动就自动重跑一遍完整部署，不需要再进来点。自动那一次失败只如实报错、停下，不重试。',
  deploy: '部署',
  deploying: '部署中…',
  deployFailed: '部署失败',
  deployHint: '部署会先写设置，然后在中继上完整重跑一遍引导；已经就绪的步骤只花几次 ssh 往返。中继侧被手工改过时，重新部署一次即可恢复。',
  incomplete: '地址与网关口令都要填好才能部署。',
  refused: '设置没有写入，中继上什么都没变。核对地址是裸的 host[:port]、网关口令非空，然后重试。',
  discard: '放弃修改',
  loading: '读取设置…',
  statusSection: '当前状态',
  stateUnconfigured: '等待部署',
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
  downloadCa: '下载根证书',
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
  empty: '还没有记录。填好上面的参数后点「部署」，插件会在中继上完成引导。',
  readOnly: '当前页面不在服务器本机，设置只读。请在中继主机本机的浏览器里修改。',
}

/** English copy. */
export const en: Record<RelayLocaleKey, string> = {
  nav: 'Remote access',
  title: 'Remote access (Web Relay)',
  description: 'Expose this machine\u2019s dsh web through a public relay. The relay only forwards; DSH still authenticates. Edits on this page stay in the browser until you press Deploy, which writes them into settings and re-runs the whole bootstrap on the relay.',
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
  passwordHint: 'Required, and retyped on every deploy: the password never rides a response back to the browser, so this page has never seen it. It is only hashed on the relay; the plaintext never lands on the relay\u2019s disk.',
  startupSection: 'Startup',
  autoDeploy: 'Deploy automatically when DSH starts',
  autoDeployHint: 'Off by default. When off, every DSH restart needs a Deploy from this page. Turning it on only counts once this deploy succeeds: after that, every start re-runs the full deploy on its own. A failing automatic run reports the failure and stops there — it never retries.',
  deploy: 'Deploy',
  deploying: 'Deploying…',
  deployFailed: 'Deploy failed',
  deployHint: 'Deploy writes the settings, then re-runs the whole bootstrap on the relay; steps that are already in place only cost a few ssh round trips. Re-deploying is how you recover a relay someone changed by hand.',
  incomplete: 'Fill in both the address and the gateway password before deploying.',
  refused: 'The settings were not written, so the relay is unchanged. Check that the address is a bare host[:port] and the gateway password is not empty, then retry.',
  discard: 'Discard',
  loading: 'Loading settings…',
  statusSection: 'Status',
  stateUnconfigured: 'Waiting for a deploy',
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
  downloadCa: 'Download the root certificate',
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
  empty: 'No record yet. Fill in the settings above and press Deploy; the plugin bootstraps the relay for you.',
  readOnly: 'This page is not on the relay host itself, so settings are read-only. Edit them from a browser on that host.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 远程访问设置页。 */
    'web-relay': RelayLocaleKey
  }
}

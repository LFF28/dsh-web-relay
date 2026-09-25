/**
 * 「远程访问」设置页。
 *
 * 一屏：一段导语、一张表单、一个「部署」按钮，下面是记录状态区。表单在挂载时读
 * 一次设置，之后的编辑只留在页面内存里；点部署才把那一次编辑写出去，并因此触发
 * 中继上的一遍完整引导。把保存绑在输入事件上会让中继上出现一串互相打断的引导。
 *
 * 控件只用 `@deepseek-ai/dsh-client-ui-primitives` 的原子件，样式走行内 token：
 * 这个页面只有一屏，为它建一套 CSS Module 的收益不抵它带来的构建面。
 * @module dsh-web-relay/client/section
 */

import { useState } from 'react'
import { Button, Input, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RelayDraft, RelayFace, RelayView } from './face.js'
import type { RelayLocaleKey } from './locales.js'

/**
 * 页面组件收到的全部 props。
 *
 * 设置外壳的 owner 份额（`close`，本页用不到）、本命名空间提供的翻译函数，以及
 * 注册项的 `inject` 工厂返回值摊平后的业务面。
 */
export type RelaySectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'web-relay'>
  & InjectFace<RelayFace>

/** 翻译函数。 */
type Translate = (key: RelayLocaleKey) => string

/**
 * 渲染页面。
 * @param props - 翻译函数与业务面。
 * @returns 导语、表单与状态区。
 */
export function RelaySection(props: RelaySectionProps) {
  const { t } = props
  const view = props.useRelay(snapshot => snapshot)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <h3 style={{ margin: 0 }}>{t('title')}</h3>
        <p style={{ margin: 0, opacity: 0.72 }}>{t('description')}</p>
      </header>
      {view.status === 'unavailable'
        ? <p style={{ margin: 0, opacity: 0.72 }}>{t('readOnly')}</p>
        : <RelayForm t={t} face={props} view={view} />}
    </div>
  )
}

/**
 * 表单与状态区。
 * @param props - 视图状态、翻译函数与业务面。
 * @returns 表单与记录。
 */
function RelayForm(props: { t: Translate; face: RelayFace; view: RelayView }) {
  const { t, face, view } = props
  const [draft, setDraft] = useState<RelayDraft | undefined>(undefined)
  const [deploying, setDeploying] = useState(false)
  const [error, setError] = useState('')
  const current = draft ?? draftOf(view)
  const edit = <K extends keyof RelayDraft>(key: K, value: RelayDraft[K]): void => {
    setDraft({ ...current, [key]: value })
  }
  // 口令必填：它不回传浏览器，所以每一次部署都要重新填一次。
  const incomplete = current.host.trim() === '' || current.password === ''
  const disabled = !view.writable || deploying || incomplete

  const submit = (): void => {
    setDeploying(true)
    setError('')
    void face.deploy(current)
      .then((landed) => {
        if (landed) setDraft(undefined)
        else setError(t('refused'))
      })
      .catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
      .finally(() => { setDeploying(false) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {!view.writable && <p style={{ margin: 0, opacity: 0.72 }}>{t('readOnly')}</p>}

      <Section title={t('vpsSection')}>
        <Field label={t('host')} hint={t('hostHint')}>
          <Input value={current.host} disabled={!view.writable} onChange={(event) => { edit('host', event.target.value) }} />
        </Field>
        <Field label={t('sshPort')}>
          <Input value={current.sshPort} disabled={!view.writable} onChange={(event) => { edit('sshPort', event.target.value) }} />
        </Field>
        <Field label={t('user')} hint={t('userHint')}>
          <Input value={current.user} disabled={!view.writable} onChange={(event) => { edit('user', event.target.value) }} />
        </Field>
        <Field label={t('identityFile')} hint={t('identityFileHint')}>
          <Input value={current.identityFile} disabled={!view.writable} onChange={(event) => { edit('identityFile', event.target.value) }} />
        </Field>
        <Field label={t('hostKeyFingerprint')} hint={t('hostKeyFingerprintHint')}>
          <Input value={current.hostKeyFingerprint} disabled={!view.writable} onChange={(event) => { edit('hostKeyFingerprint', event.target.value) }} />
        </Field>
      </Section>

      <Section title={t('gatewaySection')}>
        <Field label={t('gatewayPort')} hint={t('gatewayPortHint')}>
          <Input value={current.gatewayPort} disabled={!view.writable} onChange={(event) => { edit('gatewayPort', event.target.value) }} />
        </Field>
        <Field label={t('password')} hint={t('passwordHint')}>
          <Input
            type="password"
            value={current.password}
            disabled={!view.writable}
            onChange={(event) => { edit('password', event.target.value) }}
          />
        </Field>
      </Section>

      <Section title={t('startupSection')}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Switch
            checked={current.autoDeploy}
            disabled={!view.writable}
            label={t('autoDeploy')}
            onChange={(checked) => { edit('autoDeploy', checked) }}
          />
        </label>
        <p style={{ margin: 0, opacity: 0.72 }}>{t('autoDeployHint')}</p>
      </Section>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Button disabled={disabled} onClick={submit}>{deploying ? t('deploying') : t('deploy')}</Button>
        {draft !== undefined && (
          <Button variant="ghost" disabled={deploying} onClick={() => { setDraft(undefined) }}>{t('discard')}</Button>
        )}
      </div>
      <p style={{ margin: 0, opacity: 0.72 }}>{t('deployHint')}</p>
      {incomplete && <p style={{ margin: 0, opacity: 0.72 }}>{t('incomplete')}</p>}
      {error !== '' && <p style={{ margin: 0, color: 'var(--dsw-color-danger, #c0392b)' }}>{t('deployFailed')}：{error}</p>}

      <Status t={t} view={view} />
    </div>
  )
}

/** 一节表单。 */
function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <h4 style={{ margin: 0 }}>{props.title}</h4>
      {props.children}
    </section>
  )
}

/** 一个字段。 */
function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span>{props.label}</span>
      {props.children}
      {props.hint !== undefined && <span style={{ opacity: 0.72 }}>{props.hint}</span>}
    </label>
  )
}

/**
 * 状态区：当前状态、访问地址、根证书指纹、转发前预检与引导步骤。
 * @param props - 翻译函数与业务面快照。
 * @returns 状态区。
 */
function Status(props: { t: Translate; view: RelayView }) {
  const { t, view } = props
  const record = view.record
  if (record === undefined) return <p style={{ margin: 0, opacity: 0.72 }}>{t('empty')}</p>
  const rows: Array<[string, string]> = []
  if (view.authority !== '') {
    rows.push([t('authority'), view.authority])
    rows.push([t('entryUrl'), `https://${view.authority}/`])
  }
  if (record.caFingerprint !== undefined && record.caFingerprint !== '') {
    rows.push([t('caFingerprint'), record.caFingerprint])
  }
  if (record.observedHostKeyFingerprint !== undefined && record.observedHostKeyFingerprint !== '') {
    rows.push([t('hostKeyObserved'), record.observedHostKeyFingerprint])
  }
  const preflight = record.lastPreflight
  if (preflight !== undefined && preflight.outcome !== undefined) {
    rows.push([t('lastPreflight'), preflightText(preflight.outcome ?? '', preflight.message ?? '', t)])
  }
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <StateDot state={view.state === 'ready' ? 'done' : view.state === 'failed' ? 'error' : 'ongoing'} />
        {t('statusSection')} · {stateWord(view, t)} · {tunnelWord(view.tunnel, t)}
      </h4>
      {record.lastError !== undefined && record.lastError !== '' && (
        <p style={{ margin: 0 }}>{t('lastError')}：{record.lastError}</p>
      )}
      <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px' }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt style={{ opacity: 0.72 }}>{label}</dt>
            <dd style={{ margin: 0, wordBreak: 'break-all' }}>{value}</dd>
          </div>
        ))}
      </dl>
      {record.caPem !== undefined && record.caPem !== '' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Button variant="ghost" onClick={() => { downloadCaCert(record.caPem ?? '') }}>{t('downloadCa')}</Button>
        </div>
      )}
      {view.steps.length > 0 && (
        <details>
          <summary>{t('steps')}</summary>
          <ol style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
            {view.steps.map(step => (
              <li key={step.id}>
                {step.title} · {step.status === 'ok' ? t('stepOk') : step.status === 'failed' ? t('stepFailed') : t('stepSkipped')}
                {step.detail === '' ? '' : ` — ${step.detail}`}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}

/**
 * 状态词。
 * @param view - 业务面快照。
 * @param t - 翻译函数。
 * @returns 已翻译的状态名。
 */
function stateWord(view: RelayView, t: Translate): string {
  if (view.status === 'loading') return t('loading')
  switch (view.state) {
    case 'ready': return t('stateReady')
    case 'bootstrapping': return t('stateBootstrapping')
    case 'failed': return t('stateFailed')
    default: return t('stateUnconfigured')
  }
}

/**
 * 隧道状态词。
 * @param tunnel - 隧道状态。
 * @param t - 翻译函数。
 * @returns 已翻译的状态名。
 */
function tunnelWord(tunnel: RelayView['tunnel'], t: Translate): string {
  switch (tunnel) {
    case 'running': return t('tunnelRunning')
    case 'starting': return t('tunnelStarting')
    case 'backing-off': return t('tunnelBackingOff')
    default: return t('tunnelStopped')
  }
}

/**
 * 把根证书交给浏览器存成本地文件。
 *
 * 走 `Blob` + 一个临时对象 URL，因此不需要任何宿主端点：证书本来就在这份记录里，
 * 页面拿它拼一个下载即可。文件名固定，扩展名用 `.crt`——桌面系统按它关联到证书
 * 查看器，手机上则是"是否安装此描述文件"。
 * @param pem - 根证书 PEM 全文。
 */
function downloadCaCert(pem: string): void {
  const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-x509-ca-cert' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'dsh-web-relay-ca.crt'
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * 转发前预检的结果词。
 * @param outcome - 结果档位。
 * @param message - 原文说明。
 * @param t - 翻译函数。
 * @returns 展示文本。
 */
function preflightText(outcome: string, message: string, t: Translate): string {
  const word = outcome === 'free' ? t('preflightFree')
    : outcome === 'released' ? t('preflightReleased')
      : outcome === 'refused' ? t('preflightRefused') : t('preflightSkipped')
  return message === '' ? word : `${word}（${message}）`
}

/**
 * 由设置快照生成表单草稿。
 *
 * 口令字段是空的，而且只能由用户重填：它的值不会骑上 describe 的线，客户端从来
 * 就没有见过它。
 * @param view - 业务面快照。
 * @returns 草稿。
 */
function draftOf(view: RelayView): RelayDraft {
  const value = view.deployment
  return {
    host: value?.vps?.host ?? '',
    sshPort: String(value?.vps?.port ?? 22),
    user: value?.vps?.user ?? 'root',
    identityFile: value?.vps?.identityFile ?? '',
    hostKeyFingerprint: value?.vps?.hostKeyFingerprint ?? '',
    gatewayPort: String(value?.gateway?.port ?? 8443),
    password: '',
    autoDeploy: value?.deploy?.autoDeploy ?? false,
  }
}

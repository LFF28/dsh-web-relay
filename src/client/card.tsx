/**
 * 「Web Relay」卡片。
 *
 * 两种视图：`summary` 是 Plugins 页上那一行摘要，`page` 是打开后的表单与状态。
 * 表单不自动保存——一次保存可能触发一次完整引导，把它绑在输入事件上会让中继上
 * 出现一串互相打断的引导。保存按钮显式提交。
 *
 * 控件只用 `@deepseek-ai/dsh-client-ui-primitives` 的原子件，样式走行内 token：
 * 这个卡片只有一屏，为它建一套 CSS Module 的收益不抵它带来的构建面。
 * @module dsh-web-relay/client/card
 */

import { useState } from 'react'
import { Button, Input, StateDot, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelayCardFace, RelayCardState } from './face.js'
import type { RelayLocaleKey } from './locales.js'

/**
 * 卡片组件收到的全部 props。
 *
 * 扩展业务面而不是再挂一个字段：框架把注册项的 `inject` 工厂返回值摊进 props，
 * 摊平之后组件拿到的就是 `useRelayCard` / `save` / `requestBootstrap` 三个成员。
 */
export interface RelayCardProps extends RelayCardFace {
  /** 页面要求的视图。 */
  readonly view: 'summary' | 'page'
  /** 由注册项声明的命名空间提供的翻译函数。 */
  readonly t: (key: RelayLocaleKey) => string
}

/** 表单草稿。字符串是为了让"留空"可区分于"没有这个键"。 */
interface Draft {
  host: string
  sshPort: string
  user: string
  identityFile: string
  hostKeyFingerprint: string
  gatewayPort: string
  password: string
  autoStart: boolean
}

/**
 * 渲染摘要或表单，由页面要求的视图决定。
 * @param props - 视图、翻译函数与业务面。
 * @returns 摘要文本，或表单与状态。
 */
export function RelayCard(props: RelayCardProps) {
  const { t } = props
  const state = props.useRelayCard(snapshot => snapshot)
  if (props.view === 'summary') return summaryOf(state, t)
  return <RelayForm t={t} face={props} state={state} />
}

/**
 * 摘要那一行：状态词加权威，足以在列表里一眼看出是否就绪。
 * @param state - 业务面快照。
 * @param t - 翻译函数。
 * @returns 摘要文本。
 */
function summaryOf(state: RelayCardState, t: (key: RelayLocaleKey) => string): string {
  const word = stateWord(state, t)
  const where = state.authority === '' ? '' : ` · ${state.authority}`
  return `${word}${where}`
}

/**
 * 状态词。
 * @param state - 业务面快照。
 * @param t - 翻译函数。
 * @returns 已翻译的状态名。
 */
function stateWord(state: RelayCardState, t: (key: RelayLocaleKey) => string): string {
  if (state.status === 'loading') return t('saving')
  if (state.status === 'unavailable') return t('stateUnconfigured')
  switch (state.state) {
    case 'ready': return t('stateReady')
    case 'bootstrapping': return t('stateBootstrapping')
    case 'failed': return t('stateFailed')
    default: return t('stateUnconfigured')
  }
}

/**
 * 表单与状态区。
 * @param props - 视图状态、翻译函数与业务面。
 * @returns 表单与记录。
 */
function RelayForm(props: { t: (key: RelayLocaleKey) => string; face: RelayCardFace; state: RelayCardState }) {
  const { t, face, state } = props
  const [draft, setDraft] = useState<Draft | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const current = draft ?? draftOf(state)
  const edit = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft({ ...current, [key]: value })
  }
  const disabled = !state.writable || saving

  const submit = (): void => {
    setSaving(true)
    setError('')
    void face.save(current)
      .then(() => { setDraft(undefined) })
      .catch((failure: unknown) => { setError(failure instanceof Error ? failure.message : String(failure)) })
      .finally(() => { setSaving(false) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' }}>
      {!state.writable && <p style={{ margin: 0, opacity: 0.72 }}>{t('readOnly')}</p>}

      <Section title={t('vpsSection')}>
        <Field label={t('host')} hint={t('hostHint')}>
          <Input value={current.host} disabled={disabled} onChange={(event) => { edit('host', event.target.value) }} />
        </Field>
        <Field label={t('sshPort')}>
          <Input value={current.sshPort} disabled={disabled} onChange={(event) => { edit('sshPort', event.target.value) }} />
        </Field>
        <Field label={t('user')} hint={t('userHint')}>
          <Input value={current.user} disabled={disabled} onChange={(event) => { edit('user', event.target.value) }} />
        </Field>
        <Field label={t('identityFile')} hint={t('identityFileHint')}>
          <Input value={current.identityFile} disabled={disabled} onChange={(event) => { edit('identityFile', event.target.value) }} />
        </Field>
        <Field label={t('hostKeyFingerprint')} hint={t('hostKeyFingerprintHint')}>
          <Input value={current.hostKeyFingerprint} disabled={disabled} onChange={(event) => { edit('hostKeyFingerprint', event.target.value) }} />
        </Field>
      </Section>

      <Section title={t('gatewaySection')}>
        <Field label={t('gatewayPort')} hint={t('gatewayPortHint')}>
          <Input value={current.gatewayPort} disabled={disabled} onChange={(event) => { edit('gatewayPort', event.target.value) }} />
        </Field>
        <Field label={t('password')} hint={t('passwordHint')}>
          <Input
            type="password"
            value={current.password}
            disabled={disabled}
            onChange={(event) => { edit('password', event.target.value) }}
          />
        </Field>
      </Section>

      <Section title={t('tunnelSection')}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Switch
            checked={current.autoStart}
            disabled={disabled}
            label={t('autoStart')}
            onChange={(checked) => { edit('autoStart', checked) }}
          />
        </label>
        <p style={{ margin: 0, opacity: 0.72 }}>{t('autoStartHint')}</p>
      </Section>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <Button disabled={disabled} onClick={submit}>{saving ? t('saving') : t('save')}</Button>
        {draft !== undefined && (
          <Button variant="ghost" disabled={saving} onClick={() => { setDraft(undefined) }}>{t('discard')}</Button>
        )}
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => { void face.requestBootstrap() }}
        >
          {t('reload')}
        </Button>
      </div>
      {error !== '' && <p style={{ margin: 0, color: 'var(--dsw-color-danger, #c0392b)' }}>{t('saveFailed')}：{error}</p>}

      <Status t={t} state={state} />
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
 * 状态区：当前状态、入口、根证书指纹、转发前预检与引导步骤。
 * @param props - 翻译函数与业务面快照。
 * @returns 状态区。
 */
function Status(props: { t: (key: RelayLocaleKey) => string; state: RelayCardState }) {
  const { t, state } = props
  if (state.status === 'unavailable') {
    return <p style={{ margin: 0, opacity: 0.72 }}>{t('empty')}</p>
  }
  const record = state.record
  if (record === undefined) return <p style={{ margin: 0, opacity: 0.72 }}>{t('empty')}</p>
  const rows: Array<[string, string]> = []
  if (state.authority !== '') {
    rows.push([t('authority'), state.authority])
    rows.push([t('entryUrl'), `https://${state.authority}/relay/enter`])
  }
  if (record.caFingerprint !== undefined && record.caFingerprint !== '') {
    rows.push([t('caFingerprint'), record.caFingerprint])
    rows.push([t('caUrl'), `https://${state.authority}/relay/ca.crt`])
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
        <StateDot state={state.state === 'ready' ? 'done' : state.state === 'failed' ? 'error' : 'ongoing'} />
        {t('statusSection')} · {stateWord(state, t)} · {tunnelWord(state.tunnel, t)}
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
      {state.steps.length > 0 && (
        <details>
          <summary>{t('steps')}</summary>
          <ol style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
            {state.steps.map(step => (
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
 * 隧道状态词。
 * @param tunnel - 隧道状态。
 * @param t - 翻译函数。
 * @returns 已翻译的状态名。
 */
function tunnelWord(tunnel: RelayCardState['tunnel'], t: (key: RelayLocaleKey) => string): string {
  switch (tunnel) {
    case 'running': return t('tunnelRunning')
    case 'starting': return t('tunnelStarting')
    case 'backing-off': return t('tunnelBackingOff')
    default: return t('tunnelStopped')
  }
}

/**
 * 转发前预检的结果词。
 * @param outcome - 结果档位。
 * @param message - 原文说明。
 * @param t - 翻译函数。
 * @returns 展示文本。
 */
function preflightText(outcome: string, message: string, t: (key: RelayLocaleKey) => string): string {
  const word = outcome === 'free' ? t('preflightFree')
    : outcome === 'released' ? t('preflightReleased')
      : outcome === 'refused' ? t('preflightRefused') : t('preflightSkipped')
  return message === '' ? word : `${word}（${message}）`
}

/**
 * 由设置快照生成表单草稿。
 *
 * 口令字段是空的：它的值不会骑上 describe 的线，客户端从来就没有见过它。留空在
 * 保存时表示"不修改"。
 * @param state - 业务面快照。
 * @returns 草稿。
 */
function draftOf(state: RelayCardState): Draft {
  const value = state.deployment
  return {
    host: value?.vps?.host ?? '',
    sshPort: String(value?.vps?.port ?? 22),
    user: value?.vps?.user ?? 'root',
    identityFile: value?.vps?.identityFile ?? '',
    hostKeyFingerprint: value?.vps?.hostKeyFingerprint ?? '',
    gatewayPort: String(value?.gateway?.port ?? 8443),
    password: '',
    autoStart: value?.tunnel?.autoStart ?? true,
  }
}

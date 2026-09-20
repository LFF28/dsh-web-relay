/**
 * 卡片的业务面。
 *
 * 卡片渲染需要的一切都来自设置：`web-relay` 是用户写的参数，`web-relay-record`
 * 是宿主写的记录。插件不给客户端开 RPC 通道——记录既然是宿主写下的最后事实，
 * 让卡片读它就不必再造一条只在浏览器打开时才有用的事件线。
 * @module dsh-web-relay/client/face
 */

/** 记录里的一步。 */
export interface RelayStepView {
  /** 步骤编号。 */
  readonly id: string
  /** 步骤标题。 */
  readonly title: string
  /** 结果。 */
  readonly status: string
  /** 一行细节。 */
  readonly detail: string
}

/** 转发前预检的结果。 */
export interface RelayPreflightView {
  /** 结果档位。 */
  readonly outcome?: string
  /** 一行原文说明。 */
  readonly message?: string
}

/** 宿主写下的记录，按卡片需要的字段重新声明。 */
export interface RelayRecordView {
  /** 引导状态。 */
  readonly state?: string
  /** 隧道最近一次对外可见的状态。 */
  readonly tunnelState?: string
  /** 已生效的公网权威。 */
  readonly publicAuthority?: string
  /** 第 10 步取回的根证书指纹。 */
  readonly caFingerprint?: string
  /** 第 2 步观察到的中继主机公钥指纹。 */
  readonly observedHostKeyFingerprint?: string
  /** 最近一次失败。 */
  readonly lastError?: string
  /** 最近一次转发前预检。 */
  readonly lastPreflight?: RelayPreflightView
  /** 引导步骤。 */
  readonly steps?: readonly RelayStepView[]
}

/** 用户在表单里能改的那几个字段。 */
export interface RelayDraft {
  /** 中继地址。 */
  readonly host: string
  /** SSH 端口。 */
  readonly sshPort: string
  /** 管理账号。 */
  readonly user: string
  /** 管理账号私钥路径。 */
  readonly identityFile: string
  /** 中继主机公钥指纹。 */
  readonly hostKeyFingerprint: string
  /** 网关端口。 */
  readonly gatewayPort: string
  /** 网关口令；空串表示不修改。 */
  readonly password: string
  /** 是否自动拉起隧道。 */
  readonly autoStart: boolean
}

/** 设置快照在卡片里用到的部分。 */
export interface RelayDeploymentView {
  /** `vps` 一节。 */
  readonly vps?: {
    /** 中继地址。 */
    readonly host?: string
    /** SSH 端口。 */
    readonly port?: number
    /** 管理账号。 */
    readonly user?: string
    /** 私钥路径。 */
    readonly identityFile?: string
    /** 主机公钥指纹。 */
    readonly hostKeyFingerprint?: string
  }
  /**
   * `gateway` 一节。
   *
   * 注意 `password` 不在这里：它是 `role('secret')` 字段，红线化时整字段被剥掉，
   * 而不是打码。客户端的快照里因此从来没有它的任何痕迹，表单里那个输入框永远是
   * 空的，留空在保存时表示"不修改"。
   */
  readonly gateway?: {
    /** 网关端口。 */
    readonly port?: number
  }
  /** `tunnel` 一节。 */
  readonly tunnel?: {
    /** 是否自动拉起。 */
    readonly autoStart?: boolean
  }
  /** 单调递增的引导请求计数；每次加一就是一次"重新引导"。 */
  readonly bootstrapRequest?: number
}

/** 一次渲染用到的完整快照。 */
export interface RelayCardState {
  /** 设置读取的状态。 */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** 当前部署参数是否可写。 */
  readonly writable: boolean
  /** 用户填写的部署参数。 */
  readonly deployment?: RelayDeploymentView
  /** 宿主写下的记录。 */
  readonly record?: RelayRecordView
  /** 引导状态。 */
  readonly state: 'unconfigured' | 'bootstrapping' | 'ready' | 'failed'
  /** 隧道状态。 */
  readonly tunnel: 'stopped' | 'starting' | 'running' | 'backing-off'
  /** 已生效的公网权威。 */
  readonly authority: string
  /** 引导步骤。 */
  readonly steps: readonly RelayStepView[]
}

/** 插件交给卡片的业务面。 */
export interface RelayCardFace {
  /**
   * 订阅卡片快照。
   * @param select - 从完整快照里取这一帧要用的部分。
   * @returns 选中的值；快照变化时组件会重渲染。
   */
  readonly useRelayCard: <T>(select: (state: RelayCardState) => T) => T
  /**
   * 保存草稿。
   * @param draft - 表单里的值。
   * @returns 落定于写入完成；失败时抛出。
   */
  readonly save: (draft: RelayDraft) => Promise<void>
  /**
   * 请求重新引导。
   *
   * 只是把 `bootstrapRequest` 加一：真正决定要不要动手的是宿主，它按差异对账。
   * @returns 落定于写入完成。
   */
  readonly requestBootstrap: () => Promise<void>
}

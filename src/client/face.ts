/**
 * 设置页的业务面。
 *
 * 数据来自两条不同的通道，因此这里也分两半：
 *
 * - **部署参数**走 `ctx.configForms`，它就是插件 `Config` 里那棵 volatile 子树。
 *   写它 = 请求一次部署。
 * - **运行记录**走插件自己的 `/api/web-relay.record`（DSH 共享 API 通道，已在认证
 *   围栏之后）。它是宿主写下的状态，不属于"用户配置"，因此不在配置文档里。
 *
 * 记录体量小，但不能一直轮询：页面挂载时取一次，之后只在一次部署真正在进行时轮询，
 * 状态落定即停。中继那条链路带宽有限，闲置时的定时请求是不该有的开销。
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

/** 宿主写下的记录，按页面需要的字段重新声明。 */
export interface RelayRecordView {
  /** 引导状态。 */
  readonly state?: string
  /** 隧道最近一次对外可见的状态。 */
  readonly tunnelState?: string
  /** 已生效的公网权威。 */
  readonly publicAuthority?: string
  /** 第 10 步取回的根证书指纹。 */
  readonly caFingerprint?: string
  /**
   * 第 10 步取回的根证书 PEM 全文，供页面存成本地文件。
   *
   * 只有公钥材料，本来就该装到设备上，因此它不做红线化、会原样到达浏览器。没走到
   * 第 10 步的部署里是空串。
   */
  readonly caPem?: string
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
  /** 网关口令。必填：它是 `role('secret')` 字段，从来不回传浏览器，所以每次部署都要重填。 */
  readonly password: string
  /** 这次部署是否要求随 DSH 启动自动部署。 */
  readonly autoDeploy: boolean
}

/** 插件 `Config` 里 `deployment` 那一节，按页面用到的字段重新声明。 */
export interface RelayDeploymentConfig {
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
   * 而不是打码。表单里那个输入框因此永远是空的，每次部署都要重新填一次。
   */
  readonly gateway?: {
    /** 网关端口。 */
    readonly port?: number
  }
  /**
   * 部署请求：点一次部署就把这两个值一起写下来。
   *
   * `request` 是部署计数，`autoDeploy` 是"这次部署是否要求随 DSH 启动自动部署"。
   */
  readonly deploy?: {
    /** 单调递增的部署请求计数；点一次部署加一。 */
    readonly request?: number
    /** 这次部署是否要求随 DSH 启动自动部署。 */
    readonly autoDeploy?: boolean
  }
}

/**
 * 配置表单的整节值。
 *
 * 多一层 `deployment` 是因为 volatile 子树在 `Config` 里的位置就在那里：设置服务的
 * 表单只投影 volatile 字段，于是这一层是表单值的最外层。
 */
export interface RelayConfigSection {
  /** 部署参数。 */
  readonly deployment?: RelayDeploymentConfig
}

/** 一次渲染用到的完整快照。 */
export interface RelayView {
  /** 配置读取的状态。`unavailable` 表示这个浏览器不被允许读宿主文档（非 loopback 页面）。 */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** 当前部署参数是否可写。 */
  readonly writable: boolean
  /** 用户填写的部署参数。 */
  readonly deployment?: RelayDeploymentConfig
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

/** 插件交给设置页的业务面。 */
export interface RelayFace {
  /**
   * 订阅页面快照。
   * @param select - 从完整快照里取这一帧要用的部分。
   * @returns 选中的值；快照变化时组件会重渲染。
   */
  readonly useRelay: <T>(select: (state: RelayView) => T) => T
  /**
   * 部署：把表单写进插件配置，顺带把部署计数加一。
   *
   * 写入本身就是请求——宿主观察到这次 volatile 提交就跑一遍完整引导，没有第二参数、
   * 没有差异判断。计数保证"什么都没改也要重来一次"时这次写入仍然是一次真实变更。
   *
   * 写入被宿主拒绝时表单会静默重读文档（错误在远端被收进结果信封，不会抛出来），
   * 因此这里以 `mutate` 的返回值为准：`true` 才是这次部署真的落地了。
   * @param draft - 表单里的值。
   * @returns 写入落地时为 true；被宿主拒绝（文档没变）时为 false。
   */
  readonly deploy: (draft: RelayDraft) => Promise<boolean>
}

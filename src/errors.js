/** 统一错误码，日志与 CLI 退出码都依赖它。 */
export const CODES = Object.freeze({
  ERR_CONFIG: '参数校验失败',
  ERR_ABORTED: '任务被取消',
  ERR_BROWSER: '浏览器启动失败',
  ERR_RENDER: '帧图渲染失败',
  ERR_FRAME_SEQUENCE: '帧序校验失败',
  ERR_SCENE: '帧 HTML 生成失败',
  ERR_FFMPEG: 'MP4 编码失败',
  ERR_IO: '文件系统错误',
  ERR_DSH_ADAPTER: 'DSH 宿主适配错误',
})

export class PipelineError extends Error {
  constructor(message, code = 'ERR_IO', { cause, stage } = {}) {
    super(message, { cause })
    this.name = 'PipelineError'
    this.code = code
    this.stage = stage ?? null
  }
}

export class AbortError extends PipelineError {
  constructor(message = '任务被取消', stage = null) {
    super(message, 'ERR_ABORTED', { stage })
    this.name = 'AbortError'
  }
}

export function throwIfAborted(signal, stage = null) {
  if (signal?.aborted) {
    const reason = signal.reason?.message ?? signal.reason ?? 'exec.signal 已触发'
    throw new AbortError(String(reason), stage)
  }
}

/** 把任意下层错误归一化成带稳定 code 的 PipelineError。 */
export function normalizeError(err, stage) {
  if (err instanceof PipelineError) return err
  if (err?.name === 'AbortError') return new AbortError(err.message, stage)
  const code = typeof err?.code === 'string' && err.code.startsWith('ERR_') ? err.code : 'ERR_IO'
  return new PipelineError(err?.message ?? String(err), code, { cause: err, stage })
}

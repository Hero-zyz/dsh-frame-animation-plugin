const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 })

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '-'
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60_000).toFixed(2)}min`
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-'
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

/**
 * 轻量分级日志。
 * write 可注入宿主 logger（DSH 场景传 ctx.logger）；默认写 console。
 * 进度日志自动节流，避免上千帧刷屏。
 */
export function createLogger({ level = 'info', write, prefix = '[frame-animation]' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info
  const emit = write ?? ((line) => console.log(line))

  function log(lv, message) {
    if (LEVELS[lv] < threshold) return
    emit(`${prefix} [${lv.toUpperCase()}] ${message}`)
  }

  let progressEvery = 10
  let progressTotal = 0

  return {
    level,
    debug: (m) => log('debug', m),
    info: (m) => log('info', m),
    warn: (m) => log('warn', m),
    error: (m) => log('error', m),
    phase(index, total, name) {
      log('info', `══ 阶段 ${index}/${total} ${name} ══`)
    },
    beginProgress(total) {
      progressTotal = Math.max(1, total)
      progressEvery = Math.max(1, Math.floor(progressTotal / 10))
    },
    progress(i, detail = '') {
      const last = i + 1 >= progressTotal
      if (i !== 0 && !last && i % progressEvery !== 0) return
      const pct = ((i + 1) / progressTotal * 100).toFixed(0).padStart(3)
      log('info', `  帧 ${String(i + 1).padStart(6, '0')} / ${String(progressTotal).padStart(6, '0')}  ${pct}%  ${detail}`)
    },
    timer() {
      const start = performance.now()
      return { end: () => performance.now() - start }
    },
  }
}

import { validateConfig } from './config.js'
import { createLogger, formatMs, formatBytes } from './logger.js'
import { makeFrameContext, resolveFrameRenderer } from './scene.js'
import { createRenderer } from './renderer.js'
import {
  prepareFramesDir,
  writeFrameHtml,
  verifyFrameSequence,
  writeReport,
} from './frame-writer.js'
import { encode } from './encoder.js'
import { PipelineError, normalizeError, throwIfAborted } from './errors.js'

/**
 * 主流水线（与 DSH 宿主无关，CLI / Tool / 测试共用同一实现）。
 *   validate -> 逐帧 HTML 生成 + headless 渲染 PNG -> 帧序硬校验 -> ffmpeg 编码 MP4 -> 报告
 * 帧图严格按 0..N-1 顺序串行生成，文件名 6 位零填充，保证帧序绝对正确。
 */
export async function runPipeline(rawConfig, { signal, write, logger } = {}) {
  const log = logger ?? createLogger({ level: rawConfig?.logLevel ?? 'info', write })
  const overallStart = performance.now()
  let stage = 'validate'
  let config = null
  let renderer = null

  try {
    // ── 阶段 1 ──────────────────────────────────────────────
    log.phase(1, 4, '参数校验与目录准备')
    config = validateConfig(rawConfig)
    for (const w of config.warnings) log.warn(w)
    for (const c of config.corrections) log.warn(`自动修正：${c}`)
    log.info(`分辨率 ${config.width}x${config.height} | 帧率 ${config.fps} | 总帧数 ${config.totalFrames} | 时长 ${config.durationSec.toFixed(2)}s | 每帧 ${config.pixelsPerFrame.toLocaleString()} 像素`)
    log.info(`帧目录 ${config.framesDir}${config.framesDirExplicit ? '（显式指定）' : '（自动隔离）'}`)
    log.info(`输出   ${config.outputPath}`)
    log.info(`场景   ${config.scene} | CRF ${config.crf} | preset ${config.preset} | 全片光栅像素总量 ${(config.pixelsPerFrame * config.totalFrames / 1e6).toFixed(2)}M`)
    prepareFramesDir(config, log)
    throwIfAborted(signal, 'prepare')

    // ── 阶段 2 ──────────────────────────────────────────────
    stage = 'render'
    log.phase(2, 4, '逐帧生成 HTML 并渲染 PNG')
    const frameHtml = await resolveFrameRenderer(config)
    renderer = await createRenderer(config, log)
    log.info(`渲染器就绪：viewport ${config.width}x${config.height} @deviceScaleFactor=1（分辨率直接决定光栅化成本）`)
    log.beginProgress(config.totalFrames)

    const renderStart = performance.now()
    let renderedMsSum = 0
    let slowestMs = 0
    let pngBytesSum = 0
    for (let i = 0; i < config.totalFrames; i++) {
      throwIfAborted(signal, 'render')
      const html = await frameHtml(makeFrameContext(config, i))
      if (typeof html !== 'string' || !html.trim()) {
        throw new PipelineError(`第 ${i} 帧未生成有效 HTML`, 'ERR_SCENE', { stage: 'render' })
      }
      writeFrameHtml(config, i, html)
      const result = await renderer.render(html, i)
      renderedMsSum += result.ms
      slowestMs = Math.max(slowestMs, result.ms)
      pngBytesSum += result.bytes
      log.progress(i, `${formatMs(result.ms)}  ${formatBytes(result.bytes)}`)
    }
    const renderMs = performance.now() - renderStart
    log.info(`帧渲染完成：${config.totalFrames} 帧 / ${formatMs(renderMs)}，PNG 合计 ${formatBytes(pngBytesSum)}，平均 ${formatMs(renderedMsSum / config.totalFrames)}/帧，最慢 ${formatMs(slowestMs)}`)

    // ── 阶段 3 ──────────────────────────────────────────────
    stage = 'verify'
    log.phase(3, 4, '帧序校验')
    const seq = verifyFrameSequence(config)
    log.info(`帧序 OK：0..${config.totalFrames - 1} 连续，${seq.count}/${config.totalFrames} 文件，首帧 ${seq.first}，末帧 ${seq.last}，无缺失 / 多余 / 空帧`)

    // ── 阶段 4 ──────────────────────────────────────────────
    stage = 'encode'
    log.phase(4, 4, '按帧序编码 MP4')
    const enc = await encode(config, log, signal)
    log.info(`编码完成 ${formatMs(enc.ms)}，MP4 ${formatBytes(enc.bytes)}`)

    const totalMs = performance.now() - overallStart
    const report = {
      ok: true,
      outputPath: config.outputPath,
      framesDir: config.framesDir,
      width: config.width,
      height: config.height,
      fps: config.fps,
      totalFrames: config.totalFrames,
      durationSec: Number(config.durationSec.toFixed(4)),
      pixelsPerFrame: config.pixelsPerFrame,
      scene: config.scene,
      crf: config.crf,
      preset: config.preset,
      frameCount: seq.count,
      frameFirst: seq.first,
      frameLast: seq.last,
      pngBytes: seq.totalBytes,
      mp4Bytes: enc.bytes,
      renderMs: Number(renderMs.toFixed(1)),
      encodeMs: Number(enc.ms.toFixed(1)),
      totalMs: Number(totalMs.toFixed(1)),
      avgMsPerFrame: Number((renderedMsSum / config.totalFrames).toFixed(2)),
      maxMsPerFrame: Number(slowestMs.toFixed(2)),
      ffmpegPath: enc.ffmpeg,
      ffmpegCommand: enc.command,
      corrections: config.corrections,
      warnings: config.warnings,
    }
    const reportPath = writeReport(config, report)
    log.info(`报告 ${reportPath}`)
    log.info(`✅ 完成 总耗时 ${formatMs(totalMs)} → ${config.outputPath}`)
    return report
  } catch (err) {
    const normalized = normalizeError(err, stage)
    log.error(`阶段 ${stage} 失败 [${normalized.code}]：${normalized.message}`)
    throw normalized
  } finally {
    if (renderer) await renderer.close()
  }
}

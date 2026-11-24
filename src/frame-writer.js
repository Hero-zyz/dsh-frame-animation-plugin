import fs from 'node:fs'
import path from 'node:path'
import { PipelineError } from './errors.js'

const FRAME_PNG_RE = /^frame_(\d{6})\.png$/

export function listFramePngs(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => FRAME_PNG_RE.test(name)).sort()
  } catch {
    return []
  }
}

/** 只创建目录，绝不删除任何已有文件。 */
export function prepareFramesDir(config, logger) {
  try {
    fs.mkdirSync(config.framesDir, { recursive: true })
    fs.mkdirSync(path.dirname(config.outputPath), { recursive: true })
  } catch (err) {
    throw new PipelineError(`创建输出目录失败：${err.message}`, 'ERR_IO', { cause: err, stage: 'prepare' })
  }
  if (config.framesDirExplicit) {
    const stale = listFramePngs(config.framesDir)
    if (stale.length > 0) {
      logger.warn(`帧目录已有 ${stale.length} 个 frame_*.png；本轮将覆盖 0..${config.totalFrames - 1}，残留编号 >= ${config.totalFrames} 的帧会在帧序校验阶段报错`)
    }
  }
}

export function writeFrameHtml(config, index, html) {
  if (!config.keepHtml) return null
  const target = path.join(config.framesDir, config.htmlFile(index))
  fs.writeFileSync(target, html, 'utf8')
  return target
}

/**
 * 帧序硬校验：0..N-1 必须逐个存在、非空、编号连续且无多余帧。
 * 这是「自动按帧序打包」前的最后一道闸，杜绝缺失帧、旧帧混入、乱序。
 */
export function verifyFrameSequence(config) {
  const present = new Set(listFramePngs(config.framesDir))
  const expected = []
  for (let i = 0; i < config.totalFrames; i++) expected.push(config.frameFile(i))
  const expectedSet = new Set(expected)

  const missing = expected.filter((name) => !present.has(name))
  const extra = [...present].filter((name) => !expectedSet.has(name)).sort()
  if (missing.length > 0 || extra.length > 0) {
    const detail = [
      missing.length ? `缺失 ${missing.length} 帧（例：${missing.slice(0, 3).join(', ')}）` : '',
      extra.length ? `多余 ${extra.length} 帧（例：${extra.slice(0, 3).join(', ')}）` : '',
    ].filter(Boolean).join('；')
    throw new PipelineError(
      `帧序校验失败：${detail}。期望恰好 ${config.totalFrames} 帧（frame_000000.png .. ${expected[expected.length - 1]}）。` +
      `请换一个干净的 framesDir 或删除多余帧图后重试。`,
      'ERR_FRAME_SEQUENCE',
      { stage: 'verify' },
    )
  }

  let totalBytes = 0
  for (const name of expected) {
    const stat = fs.statSync(path.join(config.framesDir, name))
    if (stat.size === 0) {
      throw new PipelineError(`帧文件为空：${name}`, 'ERR_FRAME_SEQUENCE', { stage: 'verify' })
    }
    totalBytes += stat.size
  }
  return {
    count: expected.length,
    totalBytes,
    first: expected[0],
    last: expected[expected.length - 1],
  }
}

export function writeReport(config, report) {
  const target = path.join(config.framesDir, 'report.json')
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return target
}

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { PipelineError, throwIfAborted } from './errors.js'

const require = createRequire(import.meta.url)

/**
 * ffmpeg 探测顺序：显式参数 -> FFMPEG_PATH 环境变量 -> npm 自带二进制 -> PATH。
 * 默认复用 @ffmpeg-installer/ffmpeg（二进制随 npm 包分发，不依赖 GitHub Release 直连）。
 */
export function resolveFfmpeg(config, logger) {
  if (config.ffmpegPath) return config.ffmpegPath
  const envPath = process.env.FFMPEG_PATH
  if (envPath && fs.existsSync(envPath)) return envPath
  try {
    const bundled = require('@ffmpeg-installer/ffmpeg')?.path
    if (bundled && fs.existsSync(bundled)) return bundled
  } catch (err) {
    logger.debug(`未找到 npm 自带 ffmpeg：${err.message}`)
  }
  logger.warn('未找到 npm 自带 ffmpeg，回退到 PATH 中的 ffmpeg；若系统未安装将编码失败')
  return 'ffmpeg'
}

export function buildFfmpegArgs(config) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-framerate', String(config.fps),
    '-start_number', '0',
    '-i', path.join(config.framesDir, config.framePattern),
    '-frames:v', String(config.totalFrames),
    '-c:v', 'libx264',
    '-preset', config.preset,
    '-crf', String(config.crf),
    '-pix_fmt', 'yuv420p',
    '-r', String(config.fps),
    '-movflags', '+faststart',
    config.outputPath,
  ]
}

/**
 * 按帧序把 PNG 序列编码为 MP4。
 * - image2 输入使用 frame_%06d.png + start_number 0，严格按编号升序读取
 * - -frames:v 限定输出帧数，防止目录残留帧被多读
 * - spawn 数组传参，无 shell 拼接，避免命令注入
 */
export async function encode(config, logger, signal) {
  throwIfAborted(signal, 'encode')
  const ffmpeg = resolveFfmpeg(config, logger)
  const args = buildFfmpegArgs(config)
  const command = `${ffmpeg} ${args.join(' ')}`
  logger.info(`ffmpeg 命令：${command}`)

  const started = performance.now()
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
    if (stderr.length > 32_000) stderr = stderr.slice(-32_000)
  })

  const onAbort = () => {
    logger.warn('收到取消信号，终止 ffmpeg 进程')
    try {
      child.kill('SIGTERM')
    } catch {
      // 进程可能已退出
    }
  }
  if (signal) signal.addEventListener('abort', onAbort, { once: true })

  let exitCode
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
  } catch (err) {
    if (signal?.aborted) throw new PipelineError('任务被取消', 'ERR_ABORTED', { stage: 'encode' })
    throw new PipelineError(
      `无法启动 ffmpeg（${ffmpeg}）：${err.message}。请设置 ffmpegPath 或安装 ffmpeg。`,
      'ERR_FFMPEG',
      { cause: err, stage: 'encode' },
    )
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }

  const elapsed = performance.now() - started
  if (signal?.aborted) throw new PipelineError('任务被取消', 'ERR_ABORTED', { stage: 'encode' })
  if (exitCode !== 0) {
    throw new PipelineError(
      `ffmpeg 退出码 ${exitCode}：${stderr.trim() || '(无 stderr 输出)'}\n命令：${command}`,
      'ERR_FFMPEG',
      { stage: 'encode' },
    )
  }

  let stat
  try {
    stat = fs.statSync(config.outputPath)
  } catch (err) {
    throw new PipelineError(`编码结束但输出文件不可读：${config.outputPath}：${err.message}`, 'ERR_FFMPEG', { cause: err, stage: 'encode' })
  }
  if (stat.size === 0) {
    throw new PipelineError(`编码产物为空文件：${config.outputPath}`, 'ERR_FFMPEG', { stage: 'encode' })
  }

  return { ms: elapsed, bytes: stat.size, command, ffmpeg, stderr: stderr.trim() }
}

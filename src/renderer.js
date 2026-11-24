import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { PipelineError } from './errors.js'

const PF86 = process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)'
const PF64 = process.env.ProgramFiles ?? 'C:/Program Files'
const SYSTEM_BROWSERS = [
  path.join(PF86, 'Microsoft/Edge/Application/msedge.exe'),
  path.join(PF64, 'Microsoft/Edge/Application/msedge.exe'),
  path.join(PF86, 'Google/Chrome/Application/chrome.exe'),
  path.join(PF64, 'Google/Chrome/Application/chrome.exe'),
]

/**
 * 依次尝试：显式可执行路径 -> channel -> 系统浏览器 -> Playwright 自带 Chromium。
 * 复用本机 Edge 可免去 npx playwright install chromium 的大体积下载。
 */
async function launchWithFallback(config, logger) {
  const attempts = []
  if (config.browserExecutablePath) {
    attempts.push({ label: 'browserExecutablePath', opts: { executablePath: config.browserExecutablePath } })
  }
  if (config.browserChannel) {
    attempts.push({ label: `channel:${config.browserChannel}`, opts: { channel: config.browserChannel } })
  }
  for (const p of SYSTEM_BROWSERS) {
    if (fs.existsSync(p)) attempts.push({ label: p, opts: { executablePath: p } })
  }
  attempts.push({ label: 'playwright bundled chromium', opts: {} })

  const failures = []
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage'],
        ...attempt.opts,
      })
      logger.debug(`headless 浏览器启动成功：${attempt.label}`)
      return browser
    } catch (err) {
      const line = err?.message?.split('\n')[0] ?? String(err)
      failures.push(`  - ${attempt.label}: ${line}`)
      logger.debug(`headless 浏览器启动失败 ${attempt.label}: ${line}`)
    }
  }
  throw new PipelineError(
    `无法启动任何 headless 浏览器。已尝试：\n${failures.join('\n')}\n` +
    `请设置 browserExecutablePath（例如 Edge 的 msedge.exe），或执行 npx playwright install chromium。`,
    'ERR_BROWSER',
    { stage: 'render' },
  )
}

/**
 * 每帧 = 一份完整 HTML -> setContent -> 按 viewport 尺寸截图 PNG。
 * viewport 直接决定光栅化像素数，deviceScaleFactor 固定为 1，
 * 因此分辨率是「生成耗时 / PNG 体积 / MP4 体积」的明确主变量。
 */
export async function createRenderer(config, logger) {
  const browser = await launchWithFallback(config, logger)
  let context
  try {
    context = await browser.newContext({
      viewport: { width: config.width, height: config.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    })
    const page = await context.newPage()

    return {
      browserLabel: `${config.width}x${config.height} @dsf1`,
      async render(html, index) {
        const started = performance.now()
        await page.setContent(html, { waitUntil: 'load' })
        if (config.settleMs > 0) await page.waitForTimeout(config.settleMs)
        const target = path.join(config.framesDir, config.frameFile(index))
        await page.screenshot({ path: target, type: 'png', animations: 'disabled', caret: 'hide' })
        let bytes = 0
        try {
          bytes = fs.statSync(target).size
        } catch {
          // 截图未落盘，下面统一报错
        }
        if (bytes === 0) {
          throw new PipelineError(`第 ${index} 帧截图为空或写入失败：${target}`, 'ERR_RENDER', { stage: 'render' })
        }
        return { ms: performance.now() - started, bytes, file: target }
      },
      async close() {
        try {
          await browser.close()
        } catch (err) {
          logger.debug(`关闭浏览器时忽略异常：${err.message}`)
        }
      },
    }
  } catch (err) {
    await browser.close().catch(() => {})
    throw err
  }
}

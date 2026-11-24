#!/usr/bin/env node
/**
 * 独立 CLI：不启动 DSH 宿主也能跑完整流水线，便于本地验证、CI 与脚本化调用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { runPipeline } from '../src/pipeline.js'
import { CODES } from '../src/errors.js'
import { formatMs, formatBytes } from '../src/logger.js'

const HELP = `dsh-frame-animation —— 逐帧 HTML 动画 → MP4

用法：
  dsh-frame-animation [输出.mp4] [选项]
  dsh-frame-animation --config examples/config.low.json

主要选项：
  -c, --config <file>        JSON 配置文件（其余命令行参数覆盖同名键）
      --out <file>           MP4 输出路径（必填，须以 .mp4 结尾）
      --width <n>            帧宽度，偶数（默认 640）
      --height <n>           帧高度，偶数（默认 360）
      --fps <n>              帧率（默认 24）
      --frames <n>           总帧数（默认 48）
      --frames-dir <dir>     帧图输出目录（默认自动隔离到 frames/<名称>-<时间戳>）
      --scene <name>         ghibli | gradient（默认 ghibli）
      --crf <n>              H.264 CRF 0-51（默认 20）
      --preset <name>        x264 preset（默认 medium）
      --html-template <f>    自定义 HTML 模板（支持 {{FRAME}} 等占位符）
      --scene-module <f>     自定义 JS 模块，export renderFrame(ctx)
      --browser-path <f>     浏览器可执行文件（默认自动探测 Edge/Chrome）
      --ffmpeg-path <f>      ffmpeg 可执行文件（默认用 npm 自带二进制）
      --show-frame-number    在画面右下角绘制帧号
      --keep-html            把每帧 HTML 一并落盘
      --log-level <lv>       debug | info | warn | error | silent
  -h, --help                 显示帮助

示例：
  dsh-frame-animation --out ./out/low.mp4 --width 320 --height 180 --fps 12 --frames 12
  dsh-frame-animation --out ./out/high.mp4 --width 1280 --height 720 --fps 12 --frames 12
`

const NUMBER_FLAGS = ['width', 'height', 'fps', 'frames', 'crf']
const STRING_FLAGS = ['out', 'frames-dir', 'scene', 'preset', 'html-template', 'scene-module', 'browser-path', 'ffmpeg-path', 'log-level']

function fail(message) {
  console.error(`[参数错误] ${message}`)
  process.exit(2)
}

const { values, positionals } = parseArgs({
  options: {
    config: { type: 'string', short: 'c' },
    out: { type: 'string' },
    width: { type: 'string' },
    height: { type: 'string' },
    fps: { type: 'string' },
    frames: { type: 'string' },
    'frames-dir': { type: 'string' },
    scene: { type: 'string' },
    crf: { type: 'string' },
    preset: { type: 'string' },
    'html-template': { type: 'string' },
    'scene-module': { type: 'string' },
    'browser-path': { type: 'string' },
    'ffmpeg-path': { type: 'string' },
    'log-level': { type: 'string' },
    'show-frame-number': { type: 'boolean' },
    'keep-html': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: true,
})

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

let config = {}
if (values.config) {
  const file = path.resolve(values.config)
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`读取配置文件失败 ${file}：${err.message}`)
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) fail('配置文件根节点必须是 JSON 对象')
}

for (const key of NUMBER_FLAGS) {
  if (values[key] === undefined) continue
  const n = Number(values[key])
  if (!Number.isFinite(n)) fail(`--${key} 必须是数字，收到 ${values[key]}`)
  const map = { frames: 'totalFrames' }
  config[map[key] ?? key] = n
}
for (const key of STRING_FLAGS) {
  if (values[key] === undefined) continue
  const map = {
    out: 'outputPath',
    'frames-dir': 'framesDir',
    'html-template': 'htmlTemplatePath',
    'scene-module': 'sceneModulePath',
    'browser-path': 'browserExecutablePath',
    'ffmpeg-path': 'ffmpegPath',
    'log-level': 'logLevel',
  }
  config[map[key] ?? key] = values[key]
}
if (values['show-frame-number'] || values['keep-html']) {
  config.templateVars = { ...(config.templateVars ?? {}) }
  if (values['show-frame-number']) config.templateVars.showFrameNumber = true
  if (values['keep-html']) config.keepHtml = true
}
if (positionals.length > 0 && !config.outputPath) config.outputPath = positionals[0]
if (!config.outputPath) fail('缺少输出路径：用位置参数或 --out / --config 指定 .mp4 文件')

const controller = new AbortController()
process.on('SIGINT', () => {
  console.error('\n收到 SIGINT，正在取消…')
  controller.abort(new Error('用户中断'))
})

try {
  const report = await runPipeline(config, { signal: controller.signal })
  console.log('\n===== 生成报告 =====')
  console.log(`输出      ${report.outputPath}`)
  console.log(`帧目录    ${report.framesDir}`)
  console.log(`分辨率    ${report.width}x${report.height}  (${report.pixelsPerFrame.toLocaleString()} 像素/帧)`)
  console.log(`帧率/帧数 ${report.fps} fps / ${report.frameCount} 帧  (${report.durationSec}s)`)
  console.log(`帧序      ${report.frameFirst} → ${report.frameLast}  已校验`)
  console.log(`耗时      总计 ${formatMs(report.totalMs)}  渲染 ${formatMs(report.renderMs)}  编码 ${formatMs(report.encodeMs)}`)
  console.log(`体积      PNG 合计 ${formatBytes(report.pngBytes)}  MP4 ${formatBytes(report.mp4Bytes)}`)
  process.exitCode = 0
} catch (err) {
  const code = err?.code ?? 'ERR_UNKNOWN'
  console.error(`\n[生成失败] [${code}] ${CODES[code] ?? '未知错误'}`)
  console.error(err?.message ?? String(err))
  process.exitCode = 1
}

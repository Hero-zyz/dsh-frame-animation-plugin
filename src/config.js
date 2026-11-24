import path from 'node:path'
import fs from 'node:fs'

/**
 * 参数默认值。
 * outputPath 无默认值（必填），其余全部可省略。
 */
export const DEFAULTS = Object.freeze({
  width: 640,
  height: 360,
  fps: 24,
  totalFrames: 48,
  scene: 'ghibli',
  crf: 20,
  preset: 'medium',
  settleMs: 0,
  keepHtml: false,
  htmlTemplatePath: null,
  sceneModulePath: null,
  templateVars: {},
  framesDir: null,
  browserChannel: 'msedge',
  browserExecutablePath: null,
  ffmpegPath: null,
  runInBackground: false,
  logLevel: 'info',
})

/**
 * DSH defineTool 的 parameters DSL 投影。
 * 只声明「类型 / 必填 / 模型可见描述」；DSL 表达不了的约束
 * （正数、偶数、范围、跨字段、路径存在性）全部由 validateConfig 手检。
 * TODO(dsh-adapt): 宿主 ParameterSchemaSpec 若新增 minimum/maximum 等约束，
 * 可把 RANGES 同步下沉到这里，但 validateConfig 仍保留服务端校验（不可信输入）。
 */
export const PARAM_SPECS = Object.freeze({
  outputPath: { type: 'string', required: true, description: '输出 MP4 文件的绝对路径，必须以 .mp4 结尾' },
  width: { type: 'number', description: '每帧宽度（像素），偶数，16-7680，默认 640' },
  height: { type: 'number', description: '每帧高度（像素），偶数，16-4320，默认 360' },
  fps: { type: 'number', description: '帧率，1-120，默认 24' },
  totalFrames: { type: 'number', description: '总帧数，1-999999，默认 48；时长 = 总帧数 / 帧率' },
  framesDir: { type: 'string', description: '帧图输出目录；默认在与 MP4 同级的 frames/<名称>-<时间戳> 下自动隔离' },
  scene: { type: 'string', description: '内置场景：ghibli（宫崎骏风逐帧）/ gradient（纯色基准），默认 ghibli' },
  htmlTemplatePath: { type: 'string', description: '自定义 HTML 模板文件路径，支持 {{FRAME}} 等占位符' },
  sceneModulePath: { type: 'string', description: '自定义 JS 模块路径，需 export function renderFrame(ctx)' },
  templateVars: { type: 'object', additionalProperties: true, description: '传给自定义模板/模块的额外变量' },
  crf: { type: 'number', description: 'H.264 CRF，0-51，默认 20（越小体积越大）' },
  preset: { type: 'string', description: 'x264 preset，默认 medium' },
  settleMs: { type: 'number', description: '每帧 setContent 后额外等待毫秒，默认 0' },
  keepHtml: { type: 'boolean', description: '是否把每帧生成的 HTML 一并落盘便于调试，默认 false' },
  browserChannel: { type: 'string', description: 'Playwright 浏览器通道：msedge / chrome / chromium，默认 msedge' },
  browserExecutablePath: { type: 'string', description: '浏览器可执行文件绝对路径；设置后忽略 browserChannel' },
  ffmpegPath: { type: 'string', description: 'ffmpeg 可执行文件绝对路径；默认依次探测 FFMPEG_PATH / npm 自带二进制 / PATH' },
  runInBackground: { type: 'boolean', description: '是否通过宿主后台任务通道执行，默认 false（前台，遵循 exec.signal）' },
  logLevel: { type: 'string', description: '日志级别：debug / info / warn / error / silent，默认 info' },
})

export class ConfigError extends Error {
  constructor(message, { field = null, code = 'ERR_CONFIG' } = {}) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.field = field
  }
}

const RANGES = Object.freeze({
  width: [16, 7680],
  height: [16, 4320],
  fps: [1, 120],
  totalFrames: [1, 999999],
  crf: [0, 51],
  settleMs: [0, 60000],
})

const PRESETS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'])
const CHANNELS = new Set(['msedge', 'chrome', 'chromium'])
const SCENES = new Set(['ghibli', 'gradient'])
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent'])
const KNOWN_KEYS = new Set([...Object.keys(DEFAULTS), 'outputPath'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function num(raw, key, def, { integer = true } = {}) {
  const value = raw[key] === undefined ? def : raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`参数 ${key} 必须是有限数字，收到 ${String(value)}`, { field: key })
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`参数 ${key} 必须是整数，收到 ${value}`, { field: key })
  }
  const [min, max] = RANGES[key]
  if (value < min || value > max) {
    throw new ConfigError(`参数 ${key} 超出范围 [${min}, ${max}]，收到 ${value}`, { field: key })
  }
  return value
}

function bool(raw, key, def) {
  const value = raw[key] === undefined ? def : raw[key]
  if (typeof value !== 'boolean') {
    throw new ConfigError(`参数 ${key} 必须是布尔值，收到 ${String(value)}`, { field: key })
  }
  return value
}

function optionalExistingFile(raw, key) {
  const value = raw[key]
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new ConfigError(`参数 ${key} 必须是字符串路径，收到 ${typeof value}`, { field: key })
  }
  const abs = path.resolve(value.trim())
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    throw new ConfigError(`参数 ${key} 指向的文件不存在：${abs}`, { field: key })
  }
  if (!stat.isFile()) {
    throw new ConfigError(`参数 ${key} 指向的不是文件：${abs}`, { field: key })
  }
  return abs
}

function timestampTag() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 校验并归一化配置。纯校验，不创建目录（目录创建在 pipeline 的准备阶段）。
 * 奇数宽高会自动向下取偶（H.264 yuv420p 要求偶数尺寸），并记入 corrections。
 */
export function validateConfig(raw = {}) {
  if (!isPlainObject(raw)) {
    throw new ConfigError('配置必须是对象（键值对）', { field: 'config' })
  }

  const corrections = []
  const warnings = []
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`未知参数 ${key} 已忽略`)
  }

  const outputRaw = raw.outputPath
  if (typeof outputRaw !== 'string' || !outputRaw.trim()) {
    throw new ConfigError('参数 outputPath 必填，且必须是非空字符串（MP4 输出绝对路径）', { field: 'outputPath' })
  }
  const outputPath = path.resolve(outputRaw.trim())
  if (path.extname(outputPath).toLowerCase() !== '.mp4') {
    throw new ConfigError(`参数 outputPath 必须以 .mp4 结尾，收到 ${outputPath}`, { field: 'outputPath' })
  }

  let width = num(raw, 'width', DEFAULTS.width)
  let height = num(raw, 'height', DEFAULTS.height)
  if (width % 2 !== 0) {
    const fixed = Math.max(RANGES.width[0], width - 1)
    corrections.push(`width ${width} 为奇数（yuv420p 要求偶数），自动修正为 ${fixed}`)
    width = fixed
  }
  if (height % 2 !== 0) {
    const fixed = Math.max(RANGES.height[0], height - 1)
    corrections.push(`height ${height} 为奇数（yuv420p 要求偶数），自动修正为 ${fixed}`)
    height = fixed
  }

  const fps = num(raw, 'fps', DEFAULTS.fps)
  const totalFrames = num(raw, 'totalFrames', DEFAULTS.totalFrames)
  const crf = num(raw, 'crf', DEFAULTS.crf)
  const settleMs = num(raw, 'settleMs', DEFAULTS.settleMs)

  const preset = raw.preset === undefined ? DEFAULTS.preset : raw.preset
  if (typeof preset !== 'string' || !PRESETS.has(preset)) {
    throw new ConfigError(`参数 preset 必须是 ${[...PRESETS].join('/')} 之一，收到 ${String(preset)}`, { field: 'preset' })
  }

  const scene = raw.scene === undefined ? DEFAULTS.scene : raw.scene
  if (typeof scene !== 'string' || !SCENES.has(scene)) {
    throw new ConfigError(`参数 scene 必须是 ${[...SCENES].join('/')} 之一，收到 ${String(scene)}`, { field: 'scene' })
  }

  const htmlTemplatePath = optionalExistingFile(raw, 'htmlTemplatePath')
  const sceneModulePath = optionalExistingFile(raw, 'sceneModulePath')
  if (htmlTemplatePath && sceneModulePath) {
    throw new ConfigError('htmlTemplatePath 与 sceneModulePath 只能二选一', { field: 'sceneModulePath' })
  }

  const templateVars = raw.templateVars === undefined ? {} : raw.templateVars
  if (!isPlainObject(templateVars)) {
    throw new ConfigError('参数 templateVars 必须是普通对象', { field: 'templateVars' })
  }

  let framesDir
  let framesDirExplicit = false
  if (raw.framesDir !== undefined && raw.framesDir !== null && raw.framesDir !== '') {
    if (typeof raw.framesDir !== 'string') {
      throw new ConfigError('参数 framesDir 必须是字符串路径', { field: 'framesDir' })
    }
    framesDir = path.resolve(raw.framesDir.trim())
    framesDirExplicit = true
  } else {
    const stem = path.basename(outputPath, path.extname(outputPath)).replace(/[^A-Za-z0-9._-]/g, '_') || 'video'
    const tag = timestampTag()
    const base = path.join(path.dirname(outputPath), 'frames', `${stem}-${tag}`)
    framesDir = base
    let n = 2
    while (fs.existsSync(framesDir)) framesDir = `${base}-${n++}`
  }
  if (path.resolve(framesDir) === path.resolve(outputPath)) {
    throw new ConfigError('framesDir 不能与 outputPath 指向同一路径', { field: 'framesDir' })
  }

  const channelRaw = raw.browserChannel === undefined ? DEFAULTS.browserChannel : raw.browserChannel
  const browserChannel = channelRaw === null || channelRaw === '' ? null : channelRaw
  if (browserChannel !== null && (typeof browserChannel !== 'string' || !CHANNELS.has(browserChannel))) {
    throw new ConfigError(`参数 browserChannel 必须是 ${[...CHANNELS].join('/')} 或 null，收到 ${String(channelRaw)}`, { field: 'browserChannel' })
  }
  const browserExecutablePath = optionalExistingFile(raw, 'browserExecutablePath')
  const ffmpegPath = optionalExistingFile(raw, 'ffmpegPath')

  const keepHtml = bool(raw, 'keepHtml', DEFAULTS.keepHtml)
  const runInBackground = bool(raw, 'runInBackground', DEFAULTS.runInBackground)
  const logLevel = raw.logLevel === undefined ? DEFAULTS.logLevel : raw.logLevel
  if (typeof logLevel !== 'string' || !LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`参数 logLevel 必须是 ${[...LOG_LEVELS].join('/')} 之一`, { field: 'logLevel' })
  }

  const pixelsPerFrame = width * height
  const durationSec = totalFrames / fps
  if (pixelsPerFrame * totalFrames > 2_000_000_000) {
    warnings.push(`预计光栅化像素总量 ${(pixelsPerFrame * totalFrames / 1e9).toFixed(1)}G，任务可能很慢；建议降低分辨率或总帧数`)
  }
  if (runInBackground) warnings.push('runInBackground=true 需要宿主提供 ctx.jobs；不可用时自动降级为前台执行')

  const framePad = 6
  return {
    outputPath,
    framesDir,
    framesDirExplicit,
    width,
    height,
    fps,
    totalFrames,
    scene,
    htmlTemplatePath,
    sceneModulePath,
    templateVars,
    crf,
    preset,
    settleMs,
    keepHtml,
    browserChannel,
    browserExecutablePath,
    ffmpegPath,
    runInBackground,
    logLevel,
    corrections,
    warnings,
    pixelsPerFrame,
    durationSec,
    framePad,
    framePattern: `frame_%0${framePad}d.png`,
    frameFile: (i) => `frame_${String(i).padStart(framePad, '0')}.png`,
    htmlFile: (i) => `frame_${String(i).padStart(framePad, '0')}.html`,
  }
}

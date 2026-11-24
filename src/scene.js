import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export class SceneError extends Error {
  constructor(message, code = 'ERR_SCENE') {
    super(message)
    this.name = 'SceneError'
    this.code = code
  }
}

const TAU = Math.PI * 2
const f = (x) => Math.round(x * 100) / 100
const wrap = (x) => ((x % 1) + 1) % 1

export function makeFrameContext(config, frame) {
  return Object.freeze({
    frame,
    index: frame,
    totalFrames: config.totalFrames,
    fps: config.fps,
    width: config.width,
    height: config.height,
    t: config.totalFrames > 0 ? frame / config.totalFrames : 0,
    timeSec: frame / config.fps,
    vars: config.templateVars,
  })
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 把 JSON 安全嵌入 <script> 上下文，阻断 </script> 等注入。 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function documentSvg(inner, width, height, preserve = 'xMidYMid slice') {
  return [
    '<!doctype html>',
    '<html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#8fb6d8}',
    'svg{display:block;width:100%;height:100%;position:absolute;inset:0}</style></head><body>',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" preserveAspectRatio="${preserve}" width="${width}" height="${height}">`,
    inner,
    '</svg></body></html>',
  ].join('\n')
}

function mix(a, b, u) {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * u))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

/**
 * 内置「宫崎骏式逐帧绘制」场景。
 * 每一帧都是一份完整、自包含、确定性的 HTML/SVG 文档：
 * 画面 = paint(frame)，浏览器端不执行任何动画脚本，帧内容完全由代码在生成期决定。
 * 逻辑坐标系固定 1200x675，分辨率变化只改变光栅化像素数 —— 便于清晰观测
 * 「分辨率 -> 生成耗时 / 文件体积」的因果关系。
 */
function ghibliFrame(c) {
  const { t, frame, totalFrames, vars } = c
  const parts = []

  const skyTop = mix([74, 124, 186], [112, 174, 222], t * 0.6)
  const skyBottom = mix([198, 224, 226], [240, 232, 198], t * 0.6)
  const sunY = 190 - 72 * t

  parts.push(`<defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${skyBottom}"/></linearGradient>
    <radialGradient id="sun"><stop offset="0" stop-color="#fff8d4" stop-opacity="0.95"/><stop offset="0.45" stop-color="#ffe9a8" stop-opacity="0.55"/><stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/></radialGradient>
    <linearGradient id="hill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#89ad6d"/><stop offset="1" stop-color="#5f8749"/></linearGradient>
    <linearGradient id="hill2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f9a5b"/><stop offset="1" stop-color="#4d7540"/></linearGradient>
  </defs>`)
  parts.push('<rect x="0" y="0" width="1200" height="675" fill="url(#sky)"/>')
  parts.push(`<circle cx="880" cy="${f(sunY)}" r="150" fill="url(#sun)"/>`)
  parts.push(`<circle cx="880" cy="${f(sunY)}" r="46" fill="#fff4c4" opacity="0.9"/>`)

  // 三层云，视差位移 = t 的确定性函数
  const layers = [
    { y: 105, s: 1.05, speed: 0.16, op: 0.92, phase: 0.00 },
    { y: 185, s: 0.74, speed: 0.29, op: 0.76, phase: 0.37 },
    { y: 255, s: 0.52, speed: 0.43, op: 0.58, phase: 0.71 },
  ]
  for (const L of layers) {
    for (let k = 0; k < 3; k++) {
      const x = f(wrap(t * L.speed + L.phase + k / 3) * 1560 - 280)
      const y = f(L.y + Math.sin(TAU * (t + k * 0.2)) * 6)
      parts.push(`<g transform="translate(${x} ${y}) scale(${L.s})" opacity="${L.op}" fill="#fdfaf0">
        <ellipse cx="0" cy="0" rx="70" ry="24"/><ellipse cx="-42" cy="8" rx="46" ry="18"/>
        <ellipse cx="44" cy="9" rx="50" ry="19"/><ellipse cx="6" cy="-16" rx="44" ry="22"/>
      </g>`)
    }
  }

  // 远山（静态剪影）
  parts.push('<path d="M0 430 Q 180 330 340 410 T 700 398 T 1200 418 L1200 675 L0 675 Z" fill="#7f9a92" opacity="0.85"/>')
  parts.push('<path d="M0 478 Q 260 396 520 468 T 1200 456 L1200 675 L0 675 Z" fill="#62836f"/>')

  // 远处风车：叶片角度 = t 的确定性函数
  const fanAngle = f(t * 720 + 12)
  parts.push(`<g transform="translate(1000 452)"><rect x="-5" y="-6" width="10" height="112" fill="#e8e0c8"/>
    <g transform="rotate(${fanAngle})" fill="#f6f1dc" stroke="#b9ae90" stroke-width="2">
      <path d="M0 0 L 8 -74 L -8 -74 Z"/><path d="M0 0 L 74 8 L 74 -8 Z"/>
      <path d="M0 0 L -8 74 L 8 74 Z"/><path d="M0 0 L -74 -8 L -74 8 Z"/>
    </g><circle cx="0" cy="0" r="7" fill="#c9b98e"/></g>`)

  // 草坡
  parts.push('<path d="M0 520 Q 300 468 620 518 T 1200 498 L1200 675 L0 675 Z" fill="url(#hill)"/>')
  parts.push('<path d="M0 592 Q 380 544 760 594 T 1200 578 L1200 675 L0 675 Z" fill="url(#hill2)"/>')

  // 大树：整体随风轻摆
  const sway = f(Math.sin(TAU * t * 1.15) * 1.6)
  parts.push(`<g transform="rotate(${sway} 250 500)">
    <path d="M240 520 Q 236 440 246 380 L 258 380 Q 266 448 262 520 Z" fill="#6b5340"/>
    <path d="M248 430 Q 210 400 190 372" stroke="#6b5340" stroke-width="9" fill="none"/>
    <path d="M256 420 Q 296 392 316 366" stroke="#6b5340" stroke-width="9" fill="none"/>
    <g fill="#3f6b43"><circle cx="250" cy="342" r="62"/><circle cx="196" cy="368" r="46"/>
    <circle cx="306" cy="366" r="48"/><circle cx="222" cy="306" r="44"/><circle cx="284" cy="304" r="42"/></g>
    <g fill="#548450" opacity="0.9"><circle cx="232" cy="326" r="28"/><circle cx="282" cy="336" r="26"/><circle cx="258" cy="294" r="24"/></g>
  </g>`)

  // 飞鸟：翼相位随帧变化（逐帧「画」出来，而非浏览器动画）
  for (let i = 0; i < 2; i++) {
    const bx = f(520 + i * 118 + Math.sin(TAU * (t * 0.5 + i * 0.3)) * 46)
    const by = f(238 + i * 30 + Math.cos(TAU * (t * 0.7 + i * 0.2)) * 16)
    const wing = f(9 + 8 * Math.sin(TAU * 7 * t + i * 1.7))
    parts.push(`<path d="M ${bx} ${by} q 14 -${wing} 27 0 q 13 -${wing} 27 0" stroke="#3c4b45" stroke-width="3" fill="none" stroke-linecap="round"/>`)
  }

  // 前景草叶
  for (let i = 0; i < 16; i++) {
    const gx = f(28 + i * 76)
    const gh = f(30 + (i % 5) * 8)
    const bend = f(Math.sin(TAU * 2 * t + i * 0.55) * 9)
    parts.push(`<path d="M ${gx} 675 Q ${f(gx + bend * 0.4)} ${f(675 - gh / 2)} ${f(gx + bend)} ${f(675 - gh)}" stroke="#436c38" stroke-width="3" fill="none" stroke-linecap="round"/>`)
  }

  // 漂浮光斑 + 纸质感颗粒（确定性伪随机，数量固定）
  for (let i = 0; i < 12; i++) {
    const px = f((i * 137.5) % 1200)
    const py = f(wrap((i * 89.3) / 675 + 0.12 - t * 0.18) * 675)
    const r = f(3 + (i % 4) * 2)
    const op = f(0.14 + 0.26 * Math.abs(Math.sin(TAU * t * 1.5 + i)))
    parts.push(`<circle cx="${px}" cy="${py}" r="${r}" fill="#fff8d8" opacity="${op}"/>`)
  }
  for (let i = 0; i < 40; i++) {
    const px = f((i * 173.31) % 1200)
    const py = f((i * 97.73) % 675)
    parts.push(`<circle cx="${px}" cy="${py}" r="0.9" fill="#ffffff" opacity="0.07"/>`)
  }

  if (vars?.showFrameNumber) {
    parts.push(`<text x="1170" y="652" text-anchor="end" font-family="monospace" font-size="22" fill="#ffffff" opacity="0.62">${frame} / ${totalFrames - 1}</text>`)
  }

  return documentSvg(parts.join('\n'), c.width, c.height)
}

/** 极简场景：用于分辨率基准，把变量收敛到「像素数」本身。 */
function gradientFrame(c) {
  const { t, frame, width, height } = c
  const cx = f(120 + t * 960)
  const cy = f(337 + Math.sin(TAU * t) * 160)
  const inner = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b3a63"/><stop offset="0.5" stop-color="#3f7ea8"/><stop offset="1" stop-color="#f0c98a"/></linearGradient>
    <radialGradient id="b"><stop offset="0" stop-color="#fff3c0" stop-opacity="0.95"/><stop offset="1" stop-color="#fff3c0" stop-opacity="0"/></radialGradient></defs>
    <rect width="1200" height="675" fill="url(#g)"/>
    <circle cx="${cx}" cy="${cy}" r="190" fill="url(#b)"/>
    <circle cx="${cx}" cy="${cy}" r="46" fill="#fff6cf"/>
    <text x="40" y="620" font-family="monospace" font-size="26" fill="#ffffff" opacity="0.8">frame ${frame} · ${width}x${height}</text>`
  return documentSvg(inner, width, height, 'none')
}

function renderTemplate(template, c) {
  const vars = c.vars ?? {}
  const map = {
    FRAME: String(c.frame),
    INDEX: String(c.frame),
    TOTAL_FRAMES: String(c.totalFrames),
    FPS: String(c.fps),
    WIDTH: String(c.width),
    HEIGHT: String(c.height),
    T: c.t.toFixed(6),
    TIME_SEC: c.timeSec.toFixed(3),
  }
  return template.replace(/\{\{([A-Za-z0-9_.]+)\}\}/g, (match, key) => {
    if (key === 'VARS_JSON') return jsonForScript(vars)
    if (key.startsWith('VARS.')) {
      const value = vars[key.slice(5)]
      return value === undefined ? '' : escapeHtml(value)
    }
    return Object.prototype.hasOwnProperty.call(map, key) ? escapeHtml(map[key]) : match
  })
}

/**
 * 解析帧 HTML 生成器，优先级：
 *   1) sceneModulePath  -> JS 模块 export renderFrame(ctx)（纯代码生成 HTML）
 *   2) htmlTemplatePath -> 静态 HTML + {{...}} 占位符
 *   3) 内置 scene       -> ghibli / gradient
 * 返回 async (ctx) => html，保证每帧都是独立字符串。
 */
export async function resolveFrameRenderer(config) {
  if (config.sceneModulePath) {
    let mod
    try {
      mod = await import(pathToFileURL(config.sceneModulePath).href)
    } catch (err) {
      throw new SceneError(`加载 sceneModulePath 失败：${config.sceneModulePath}：${err.message}`, 'ERR_SCENE_MODULE')
    }
    const fn = mod.renderFrame ?? mod.default
    if (typeof fn !== 'function') {
      throw new SceneError(`sceneModulePath 必须 export function renderFrame(ctx)：${config.sceneModulePath}`, 'ERR_SCENE_MODULE')
    }
    return async (ctx) => {
      const html = await fn(ctx)
      if (typeof html !== 'string' || !html.trim()) {
        throw new SceneError(`renderFrame(${ctx.frame}) 未返回非空 HTML 字符串`, 'ERR_SCENE_FRAME')
      }
      return html
    }
  }

  if (config.htmlTemplatePath) {
    let template
    try {
      template = fs.readFileSync(config.htmlTemplatePath, 'utf8')
    } catch (err) {
      throw new SceneError(`读取 htmlTemplatePath 失败：${err.message}`, 'ERR_SCENE_TEMPLATE')
    }
    if (!template.trim()) throw new SceneError('htmlTemplatePath 指向的模板为空', 'ERR_SCENE_TEMPLATE')
    return async (ctx) => renderTemplate(template, ctx)
  }

  if (config.scene === 'gradient') return async (ctx) => gradientFrame(ctx)
  return async (ctx) => ghibliFrame(ctx)
}

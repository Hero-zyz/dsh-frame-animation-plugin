/**
 * 自定义场景模块：export function renderFrame(ctx) -> 完整 HTML 字符串。
 * 每一帧由代码独立生成，浏览器端不执行动画脚本，保证确定性。
 *
 * ctx = { frame, index, totalFrames, fps, width, height, t, timeSec, vars }
 */
export function renderFrame(ctx) {
  const { frame, totalFrames, width, height, t, vars } = ctx
  const x = Math.round(10 + t * 80)
  const hue = Math.round(200 + t * 90)
  const title = String(vars?.title ?? 'frame animation').replace(/[<>&"']/g, '')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:hsl(${hue} 45% 22%)}
  .ball{position:absolute;left:${x}%;top:50%;width:12vmin;height:12vmin;border-radius:50%;
        transform:translate(-50%,-50%);background:hsl(${hue} 80% 72%);box-shadow:0 0 60px hsl(${hue} 90% 70% / .7)}
  .label{position:absolute;right:3vw;bottom:3vh;color:#fff;font:3vmin monospace;opacity:.8}
  </style></head><body><div class="ball"></div>
  <div class="label">${title} · frame ${frame}/${totalFrames - 1} · ${width}x${height}</div>
  </body></html>`
}

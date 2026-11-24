/**
 * 冒烟 + 分辨率基准。
 *   node test/smoke.mjs           参数校验 / 帧序 / 端到端 MP4 / 帧数探测
 *   node test/smoke.mjs --bench   额外跑低 vs 高分辨率对比，验证速度/体积随分辨率上升
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runPipeline } from '../src/pipeline.js'
import { validateConfig } from '../src/config.js'
import { prepareFramesDir, verifyFrameSequence } from '../src/frame-writer.js'
import { resolveFfmpeg } from '../src/encoder.js'
import { describeAdapter } from '../src/dsh-adapter.js'
import { formatMs, formatBytes } from '../src/logger.js'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = path.join(ROOT, 'out', 'smoke')
const BENCH = process.argv.includes('--bench')
let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function expectConfigError(name, raw, field) {
  try {
    validateConfig(raw)
    check(name, false, '未抛错')
  } catch (err) {
    check(name, err.code === 'ERR_CONFIG' && (!field || err.field === field), `[${err.code}] ${err.message}`)
  }
}

function pngSize(file) {
  const buf = fs.readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function probeFrameCount(ffmpeg, mp4) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', mp4, '-map', '0:v:0', '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const matches = [...(r.stderr ?? '').matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1]))
  return { count: matches.length ? matches[matches.length - 1] : null, code: r.status }
}

function extractFrame(ffmpeg, mp4, index, target) {
  return spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', mp4,
    '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', target,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

function quietLogger() {
  return {
    debug() {}, info() {}, warn() {}, error() {}, phase() {},
    beginProgress() {}, progress() {}, timer: () => ({ end: () => 0 }),
  }
}

async function render(name, overrides) {
  const cfg = {
    outputPath: path.join(OUT, `${name}.mp4`),
    width: 320, height: 180, fps: 12, totalFrames: 12,
    scene: 'gradient', preset: 'ultrafast',
    logLevel: 'silent',
    ...overrides,
  }
  return { cfg, report: await runPipeline(cfg, { logger: quietLogger() }) }
}

console.log('\n=== 1. 参数校验 ===')
expectConfigError('缺 outputPath', { width: 320 }, 'outputPath')
expectConfigError('outputPath 非 .mp4', { outputPath: path.join(OUT, 'a.mov') }, 'outputPath')
expectConfigError('width 为负', { outputPath: path.join(OUT, 'a.mp4'), width: -1 }, 'width')
expectConfigError('fps 超范围', { outputPath: path.join(OUT, 'a.mp4'), fps: 999 }, 'fps')
expectConfigError('totalFrames 非整数', { outputPath: path.join(OUT, 'a.mp4'), totalFrames: 1.5 }, 'totalFrames')
expectConfigError('preset 非法', { outputPath: path.join(OUT, 'a.mp4'), preset: 'turbo' }, 'preset')
expectConfigError('scene 非法', { outputPath: path.join(OUT, 'a.mp4'), scene: 'nope' }, 'scene')
expectConfigError('模板与模块二选一', {
  outputPath: path.join(OUT, 'a.mp4'),
  htmlTemplatePath: path.join(ROOT, 'examples', 'custom-scene.html'),
  sceneModulePath: path.join(ROOT, 'examples', 'custom-scene.mjs'),
}, 'sceneModulePath')
const odd = validateConfig({ outputPath: path.join(OUT, 'a.mp4'), width: 321, height: 181 })
check('奇数宽高自动取偶', odd.width === 320 && odd.height === 180 && odd.corrections.length === 2, `${odd.width}x${odd.height}`)
const adapter = describeAdapter()
check('DSH 工具参数表完整', ['outputPath', 'width', 'height', 'fps', 'totalFrames', 'framesDir'].every((k) => adapter.parameterKeys.includes(k)), `${adapter.parameterKeys.length} 个参数`)

console.log('\n=== 2. 帧序硬校验 ===')
{
  const cfg = validateConfig({ outputPath: path.join(OUT, 'seq.mp4'), totalFrames: 3, framesDir: path.join(OUT, 'seq-frames') })
  fs.rmSync(cfg.framesDir, { recursive: true, force: true })   // 仅清理本测试自建目录
  prepareFramesDir(cfg, quietLogger())
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(cfg.framesDir, cfg.frameFile(i)), Buffer.alloc(16 + i, 1))
  const seq = verifyFrameSequence(cfg)
  check('连续 0..2 通过', seq.count === 3 && seq.totalBytes === 51, `${seq.first} → ${seq.last}`)
  fs.writeFileSync(path.join(cfg.framesDir, 'frame_000009.png'), Buffer.alloc(8, 1))
  let code = null
  try { verifyFrameSequence(cfg) } catch (err) { code = err.code }
  check('多余帧被拒绝', code === 'ERR_FRAME_SEQUENCE', `code=${code}`)
  fs.rmSync(path.join(cfg.framesDir, 'frame_000001.png'))
  code = null
  try { verifyFrameSequence(cfg) } catch (err) { code = err.code }
  check('缺失帧被拒绝', code === 'ERR_FRAME_SEQUENCE', `code=${code}`)
}

console.log('\n=== 3. 端到端生成（低分辨率）===')
fs.mkdirSync(OUT, { recursive: true })
let low
try {
  low = await render('low')
  const r = low.report
  check('MP4 已生成且非空', fs.existsSync(r.outputPath) && fs.statSync(r.outputPath).size > 0, formatBytes(r.mp4Bytes))
  check('帧数与配置一致', r.frameCount === 12 && r.totalFrames === 12, `${r.frameCount} 帧`)
  check('帧序首尾正确', r.frameFirst === 'frame_000000.png' && r.frameLast === 'frame_000011.png', `${r.frameFirst} → ${r.frameLast}`)
  check('report.json 已落盘', fs.existsSync(path.join(r.framesDir, 'report.json')))

  const ffmpeg = resolveFfmpeg(low.cfg, quietLogger())
  const probe = probeFrameCount(ffmpeg, r.outputPath)
  check('ffmpeg 解码帧数 = 12', probe.count === 12, `probe=${probe.count}, exit=${probe.code}`)

  const firstPng = path.join(OUT, 'first.png')
  const lastPng = path.join(OUT, 'last.png')
  const e1 = extractFrame(ffmpeg, r.outputPath, 0, firstPng)
  const e2 = extractFrame(ffmpeg, r.outputPath, 11, lastPng)
  if (e1.status === 0 && e2.status === 0 && fs.existsSync(firstPng) && fs.existsSync(lastPng)) {
    const size = pngSize(firstPng)
    check('解码首帧尺寸正确', size.width === 320 && size.height === 180, `${size.width}x${size.height}`)
    check('首帧与末帧内容不同（确为逐帧动画）', sha(firstPng) !== sha(lastPng))
  } else {
    check('抽帧成功', false, `e1=${e1.status} e2=${e2.status} ${(e1.stderr || '').slice(0, 120)}`)
  }
} catch (err) {
  check('端到端生成', false, `[${err.code}] ${err.message}`)
}

if (BENCH && low) {
  console.log('\n=== 4. 分辨率基准（同帧数 / 同场景 / 同 CRF）===')
  let high
  try {
    high = await render('high', { width: 1280, height: 720 })
  } catch (err) {
    check('高分辨率渲染', false, `[${err.code}] ${err.message}`)
  }
  if (high) {
    const a = low.report
    const b = high.report
    const row = (label, r) => `| ${label} | ${r.width}x${r.height} | ${r.pixelsPerFrame.toLocaleString()} | ${formatMs(r.renderMs)} | ${formatMs(r.avgMsPerFrame)} | ${formatBytes(r.pngBytes)} | ${formatBytes(r.mp4Bytes)} | ${formatMs(r.totalMs)} |`
    console.log('\n| 档位 | 分辨率 | 像素/帧 | 渲染耗时 | 平均/帧 | PNG 合计 | MP4 | 总耗时 |')
    console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
    console.log(row('低', a))
    console.log(row('高', b))
    console.log(`\n倍数：像素 ${(b.pixelsPerFrame / a.pixelsPerFrame).toFixed(1)}x，渲染 ${(b.renderMs / a.renderMs).toFixed(2)}x，PNG ${(b.pngBytes / a.pngBytes).toFixed(2)}x，MP4 ${(b.mp4Bytes / a.mp4Bytes).toFixed(2)}x`)
    check('高分辨率渲染更慢', b.renderMs > a.renderMs, `${formatMs(a.renderMs)} → ${formatMs(b.renderMs)}`)
    check('高分辨率 PNG 更大', b.pngBytes > a.pngBytes, `${formatBytes(a.pngBytes)} → ${formatBytes(b.pngBytes)}`)
    check('高分辨率 MP4 更大', b.mp4Bytes > a.mp4Bytes, `${formatBytes(a.mp4Bytes)} → ${formatBytes(b.mp4Bytes)}`)
  }
}

console.log(`\n=== 结果：${passed} 通过 / ${failed} 失败 ===`)
if (failed > 0) process.exitCode = 1

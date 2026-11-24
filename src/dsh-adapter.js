/**
 * ============================================================================
 * DSH 宿主适配层（唯一收敛点）
 * ----------------------------------------------------------------------------
 * 目标：所有与 DeepSeek Harness 运行时耦合的东西都只出现在
 *       index.js（一行 defineTool 静态导入）和本文件里。
 *       核心流水线 src/pipeline.js 完全不依赖 DSH，可独立用 CLI 运行与测试。
 *
 * 依据（官方一手文档，2026-11 核对）：
 *   - docs/cookbook/adding-a-tool.md      Tool authoring reference
 *   - docs/user/develop/basic/tool.md    Build a tool
 *   - docs/user/develop/basic/publish.md dsh.bundle / cordis.patch.yml
 *
 * TODO(dsh-adapt) 清单见 README「待适配点」章节；本文件内以 A1..A6 标注。
 * ============================================================================
 */
import { validateConfig, PARAM_SPECS } from './config.js'
import { runPipeline } from './pipeline.js'
import { normalizeError } from './errors.js'

export const TOOL_NAME = 'generate_frame_animation'

// A1: 宿主错误类的确切导出包/名字在 developer preview 期间可能变动。
//     这里用动态 import 做最佳努力探测，探测不到就降级为带 code 的普通 Error，
//     绝不因为缺少某个具名导出而在链接期崩溃。
const HOST_MODULE_CANDIDATES = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-errors',
  '@deepseek-ai/cordis',
]
let hostModules = null

async function loadHostModules() {
  if (hostModules) return hostModules
  const found = {}
  for (const name of HOST_MODULE_CANDIDATES) {
    try {
      found[name] = await import(name)
    } catch {
      found[name] = null
    }
  }
  hostModules = found
  return found
}

async function findHostExport(exportName) {
  const mods = await loadHostModules()
  for (const name of HOST_MODULE_CANDIDATES) {
    const candidate = mods[name]?.[exportName] ?? mods[name]?.default?.[exportName]
    if (candidate) return candidate
  }
  return null
}

async function makeArgsError(message) {
  const Ctor = await findHostExport('ToolArgsError')   // A2: 官方要求用 ToolArgsError 拒绝 DSL 无法表达的约束
  if (typeof Ctor === 'function') return new Ctor(message)
  const err = new Error(message)
  err.name = 'ToolArgsError'
  err.code = 'ERR_CONFIG'
  return err
}

async function makeHarnessError(message, code) {
  const Ctor = await findHostExport('HarnessError')    // A3: 官方要求预期失败抛 HarnessError 子类以保留 error.code
  if (typeof Ctor === 'function') {
    try {
      return new Ctor(message, { code })
    } catch {
      try {
        return new Ctor(message, code)
      } catch {
        // 构造签名不匹配时继续降级
      }
      const err = new Error(message)
      err.name = 'HarnessError'
      err.code = code
      return err
    }
  }
  const err = new Error(message)
  err.name = 'HarnessError'
  err.code = code
  return err
}

function resolveLogSink(ctx) {
  const candidate = ctx?.logger ?? ctx?.log
  if (typeof candidate === 'function') return candidate
  if (candidate && typeof candidate.info === 'function') return (line) => candidate.info(line)
  return undefined
}

function formatResultText(value) {
  if (!value) return '逐帧动画生成：无结果'
  if (value.mode === 'background') {
    return `逐帧动画已提交后台任务，jobId=${value.jobId ?? '(未知)'}，输出目标 ${value.outputPath}。可用 job_output / job_kill 跟踪。`
  }
  const r = value.report
  if (!r) return `逐帧动画生成失败：${value.error ?? '未知错误'}`
  return [
    `已生成逐帧动画 MP4：${r.outputPath}`,
    `分辨率 ${r.width}x${r.height} | 帧率 ${r.fps} | 帧数 ${r.frameCount}/${r.totalFrames} | 时长 ${r.durationSec}s`,
    `帧目录 ${r.framesDir}（帧序 ${r.frameFirst} → ${r.frameLast} 已校验）`,
    `耗时 ${r.totalMs}ms（渲染 ${r.renderMs}ms / 编码 ${r.encodeMs}ms），PNG 合计 ${r.pngBytes}B，MP4 ${r.mp4Bytes}B`,
  ].join('\n')
}

// A4: ValueSchemaSpec 的 object 字段声明在 developer preview 期间可能收紧。
//     若宿主拒绝 properties，把 schema 降级为 { type: 'object', additionalProperties: true }。
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    mode: { type: 'string' },
    jobId: { type: 'string' },
    outputPath: { type: 'string' },
    report: { type: 'object', additionalProperties: true },
    error: { type: 'string' },
  },
  additionalProperties: true,
}

/**
 * 生成 defineTool 所需的完整定义。
 * ctx 由 index.js 的 apply(ctx) 传入，只做「可选能力探测」，不强制 inject 新服务。
 */
export function createFrameAnimationTool(ctx = null) {
  return {
    name: TOOL_NAME,
    description:
      '把逐帧绘制的动画生成为 MP4：按配置用代码生成每一帧的 HTML，headless 浏览器逐帧渲染为 PNG，' +
      '校验帧序后用 ffmpeg 编码成视频。可设置 width/height/fps/totalFrames/framesDir/outputPath 等参数；' +
      '分辨率越高，每帧光栅化像素越多，生成越慢、PNG 与 MP4 体积越大。' +
      'outputPath 必填（.mp4 绝对路径）。长任务可设 runInBackground=true。',

    parameters: PARAM_SPECS,

    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatResultText(value) }],
    },

    // 官方要求：卡片呈现必须是 args / result 的纯函数，不做任何 I/O。
    presentCall(args) {
      return {
        card: 'generic',
        title: `逐帧动画 ${args?.width ?? 640}x${args?.height ?? 360} · ${args?.totalFrames ?? 48} 帧`,
        locations: args?.outputPath ? [{ path: args.outputPath }] : [],
      }
    },
    presentResult(_args, result) {
      const path = result?.report?.outputPath ?? result?.outputPath
      return {
        card: 'generic',
        title: result?.ok ? '逐帧动画视频已生成' : '逐帧动画生成失败',
        locations: path ? [{ path }] : [],
      }
    },

    async execute(args, exec) {
      // DSL 只保证类型/必填；范围、偶数、路径存在性、跨字段规则在此手检。
      // 官方：这类约束用 ToolArgsError 拒绝，而不是静默接受。
      let config
      try {
        config = validateConfig(args)
      } catch (err) {
        throw await makeArgsError(err.message)
      }

      // A5: 后台任务通道。官方建议长任务走 ctx.jobs.start；此处为可选能力，
      //     宿主不提供 jobs 时自动降级为前台执行，不影响主流程。
      if (config.runInBackground && typeof ctx?.jobs?.start === 'function') {
        try {
          const handle = await ctx.jobs.start({
            kind: 'frame-animation',
            label: `逐帧动画 ${config.width}x${config.height} / ${config.totalFrames} 帧`,
            owner: exec?.agent,
            run: async () => runPipeline(args, { write: resolveLogSink(ctx) }),
          })
          return {
            ok: true,
            mode: 'background',
            jobId: handle?.jobId ?? handle?.id ?? String(handle),
            outputPath: config.outputPath,
          }
        } catch (err) {
          const e = normalizeError(err, 'jobs')
          throw await makeHarnessError(`后台任务启动失败：${e.message}`, e.code)
        }
      }

      // 前台：严格绑定 exec.signal，取消时终止渲染与 ffmpeg。
      try {
        const report = await runPipeline(args, {
          signal: exec?.signal,
          write: resolveLogSink(ctx),
        })
        return { ok: true, mode: 'foreground', report, outputPath: report.outputPath }
      } catch (err) {
        const e = normalizeError(err, 'execute')
        // 官方：抛异常 = isError；基础设施失败用 HarnessError 子类保留稳定 code。
        throw await makeHarnessError(e.message, e.code)
      }
    },
  }
}

// A6: 便于本地独立校验 schema / 参数表，无需启动 DSH 宿主。
export function describeAdapter() {
  return {
    toolName: TOOL_NAME,
    parameterKeys: Object.keys(PARAM_SPECS),
    hostModuleCandidates: HOST_MODULE_CANDIDATES,
    adaptPoints: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
  }
}

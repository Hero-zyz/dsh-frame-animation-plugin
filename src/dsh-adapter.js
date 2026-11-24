/**
 * ============================================================================
 * DSH 宿主适配层（唯一收敛点）
 * ----------------------------------------------------------------------------
 * 核心流水线 src/pipeline.js 完全不依赖 DSH，可独立用 CLI 运行与测试。
 * 所有宿主耦合点只出现在 index.js（一行 defineTool 静态导入）与本文件。
 *
 * 契约来源（已逐条核对真实类型声明，而非仅凭文档）：
 *   @deepseek-ai/dsh-tools@0.0.1-rc.1  lib/types/schema.d.ts
 *     - defineTool(options: DefineToolOptions<S,O>): ToolDefinition
 *     - ToolArgsError  constructor(violations: string[])
 *     - ObjectValueSchemaSpec { type:'object', properties?: ParameterSchemaSpec,
 *                               additionalProperties: boolean }   // 必填
 *     - ParameterPropertySpec = ValueSchemaSpec & { required?: true }
 *   @deepseek-ai/dsh-tools  lib/types/index.d.ts
 *     - ToolResult { content: ContentBlock[]; isError: boolean; meta?: JsonValue }
 *     - ToolRunContext 含 signal: AbortSignal / agent?: Agent / token
 *     - TOOL_ABORTED = 'ABORTED'
 *   @deepseek-ai/dsh-llm    lib/types/error.d.ts
 *     - HarnessError constructor(message: string, code: string, options?: ErrorOptions)
 *
 * 仍保留动态 import + 降级：DSH 处于 developer preview，接口可能漂移，
 * 缺某个具名导出时降级为带 code 的普通 Error，而不是在链接期崩溃。
 * ============================================================================
 */
import { validateConfig, PARAM_SPECS } from './config.js'
import { runPipeline } from './pipeline.js'
import { normalizeError, AbortError } from './errors.js'

export const TOOL_NAME = 'generate_frame_animation'

// HarnessError 的真实来源是叶子包 dsh-llm（dsh-tools 也从那里再导出使用）。
const HOST_MODULE_CANDIDATES = [
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
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
    if (typeof candidate === 'function') return candidate
  }
  return null
}

/**
 * DSL 表达不了的约束（范围、偶数、路径存在性、跨字段）用 ToolArgsError 拒绝。
 * 真实签名是 constructor(violations: string[])，必须传数组。
 */
async function makeArgsError(message) {
  const Ctor = await findHostExport('ToolArgsError')
  if (Ctor) {
    try {
      return new Ctor([message])
    } catch {
      // 宿主签名漂移，落到下面的降级实现
    }
  }
  const err = new Error(message)
  err.name = 'ToolArgsError'
  err.code = 'ERR_CONFIG'
  return err
}

/**
 * 预期失败抛 HarnessError 才能在 tool/result 上保留 error.name / error.code。
 * 真实签名是 (message, code, options?)，不是 (message, { code })。
 */
async function makeHarnessError(message, code) {
  const Ctor = await findHostExport('HarnessError')
  if (Ctor) {
    try {
      return new Ctor(message, code)
    } catch {
      try {
        return new Ctor(message, { code })
      } catch {
        // 继续降级
      }
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

// ObjectValueSchemaSpec 要求 additionalProperties 必填；这里显式声明开放性。
// 若宿主后续收紧 ValueSchemaSpec，降级为 { type:'object', additionalProperties:true }。
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
 * ctx 由 index.js 的 apply(ctx) 传入，只做可选能力探测，不强制 inject 新服务。
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
      // 官方签名：render(args, value) -> ContentBlock[]
      render: (_args, value) => [{ type: 'text', text: formatResultText(value) }],
      // presentResult 只能拿到 { content, isError, meta }，拿不到 canonical value。
      // 因此用 presentationMeta 把结果摘要投影成可重放的 JSON。
      presentationMeta: (_args, value) => ({
        ok: value?.ok === true,
        mode: value?.mode ?? null,
        outputPath: value?.report?.outputPath ?? value?.outputPath ?? null,
        width: value?.report?.width ?? null,
        height: value?.report?.height ?? null,
        frameCount: value?.report?.frameCount ?? null,
        totalFrames: value?.report?.totalFrames ?? null,
        mp4Bytes: value?.report?.mp4Bytes ?? null,
      }),
    },

    // 官方要求：卡片呈现必须是 args / result 的纯函数，不做任何 I/O。
    presentCall(args) {
      const w = args?.width ?? 640
      const h = args?.height ?? 360
      const n = args?.totalFrames ?? 48
      return {
        card: 'generic',
        title: `逐帧动画 ${w}x${h} · ${n} 帧`,
        kind: 'other',
        rawInput: args?.outputPath,
        locations: typeof args?.outputPath === 'string' ? [{ path: args.outputPath }] : [],
      }
    },
    // GenericResultView 只有 { card, title?, content? }，不含 locations。
    presentResult(_args, result) {
      const meta = result?.meta ?? {}
      const failed = result?.isError === true || meta.ok === false
      const detail = meta.width && meta.height
        ? ` ${meta.width}x${meta.height} · ${meta.frameCount ?? '?'} 帧`
        : ''
      return {
        card: 'generic',
        title: failed ? '逐帧动画生成失败' : `逐帧动画视频已生成${detail}`,
      }
    },

    async execute(args, exec) {
      // DSL 只保证类型/必填；范围、偶数、路径存在性、跨字段规则在此手检。
      let config
      try {
        config = validateConfig(args)
      } catch (err) {
        throw await makeArgsError(err.message)
      }

      // 后台任务通道由 dsh-tool-jobs 的 ctx.jobs 提供，属可选能力；
      // 宿主未挂载时静默降级为前台执行，不影响主流程。
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
          if (err instanceof AbortError || err?.name === 'AbortError') throw err
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
        // 官方：signal 取消时必须让 AbortError 原样传播，不能替换成别的错误。
        if (err instanceof AbortError || err?.name === 'AbortError') throw err
        const e = normalizeError(err, 'execute')
        throw await makeHarnessError(e.message, e.code)
      }
    },
  }
}

/** 便于本地独立校验 schema / 参数表，无需启动 DSH 宿主。 */
export function describeAdapter() {
  return {
    toolName: TOOL_NAME,
    parameterKeys: Object.keys(PARAM_SPECS),
    hostModuleCandidates: HOST_MODULE_CANDIDATES,
    adaptPoints: ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'],
  }
}

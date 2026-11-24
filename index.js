/**
 * DSH 插件入口（Cordis plugin module）。
 * 官方最小形态：export name / inject / apply(ctx)，apply 内以 effect 方式注册工具。
 * 卸载插件时注册自动撤销，无需手动清理。
 *
 * TODO(dsh-adapt) A0: 若宿主版本把 defineTool 的导出包或签名改掉，
 * 只需修改下面这一行 import 与 src/dsh-adapter.js 的宿主导出探测列表。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createFrameAnimationTool } from './src/dsh-adapter.js'

export const name = 'frame-animation'

// inject: ['tools'] 不可省略 —— 让 Cordis 先准备好工具注册表。
// jobs 为可选能力，故意不写进 inject，避免在未提供 jobs 的宿主上加载失败。
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool(createFrameAnimationTool(ctx)))
}

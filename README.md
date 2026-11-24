# dsh-frame-animation

> DeepSeek Harness (DSH) plugin —— 用代码逐帧绘制 HTML，渲染成连续帧图，再按帧序打包编码为 MP4。
> Frame-by-frame HTML animation rendered in a headless browser and encoded to MP4, as a DSH tool plugin.

表现目标是宫崎骏式的「一张张赛璐璐画好，再连续播放」；区别只在于**画笔是代码**：
每一帧都是一份独立、自包含、确定性的 HTML/SVG 文档，由 headless Chromium 光栅化为 PNG，
最后由 ffmpeg 按 `0..N-1` 的严格帧序编码成 MP4。没有手绘，没有录屏，没有外部素材。

内置 `ghibli` 场景（天空渐变 / 视差云层 / 远山 / 草坡 / 摇树 / 转风车 / 振翅飞鸟 / 漂浮光斑）
演示这套「逐帧绘制再播放」的效果，也可换成任意自定义 HTML 模板或 JS 场景模块。

---

## 工作方式

```
参数校验 ──▶ 逐帧生成 HTML ──▶ headless 渲染 PNG ──▶ 帧序硬校验 ──▶ ffmpeg 编码 MP4 ──▶ report.json
              (代码绘制)        (Playwright+Edge)       (0..N-1)        (libx264)
```

| 阶段 | 做什么 | 产物 |
| --- | --- | --- |
| 1 参数校验 | 类型 / 范围 / 偶数 / 路径存在性 / 跨字段规则；奇数宽高自动取偶 | 归一化配置 |
| 2 逐帧渲染 | 第 `i` 帧 HTML = `paint(i)`，`setContent` 后按 viewport 尺寸截图 | `frame_000000.png … frame_(N-1).png` |
| 3 帧序校验 | 逐个确认 `0..N-1` 存在、非空、编号连续，且**无多余帧** | 校验通过的帧序列 |
| 4 编码 | `-framerate fps -start_number 0 -i frame_%06d.png -frames:v N` + libx264 | `outputPath` 指定的 MP4 |

**帧序为什么可靠**：渲染严格串行、文件名 6 位零填充、编码前做全量存在性/连续性/多余帧三项校验，
并用 `-frames:v` 二次封顶；任何不满足都会在编码前报 `ERR_FRAME_SEQUENCE` 而不是产出一个静默错序的视频。

---

## 为什么没有直接复用现成方案

按「先找现成的」原则检索过 GitHub 生态（2026-11），结论如下：

| 候选 | 覆盖情况 | 为何不能直接用 |
| --- | --- | --- |
| [Remotion](https://github.com/remotion-dev/remotion) 72K★ | DOM 逐帧截图 + ffmpeg，最成熟 | React/JSX 组件模型，不是「代码生成独立 HTML 帧」；Remotion License 非 MIT，用于自动化/构建视频工具需付费许可；是独立框架而非 DSH Tool 插件；需下载 Chrome Headless Shell |
| [Zien153/HTML-TO-VIDEO](https://github.com/Zien153/HTML-TO-VIDEO) | HTML → MP4 + Playwright + ffmpeg | 云端 HTTP 服务（Render 部署 / multipart 上传）；参数只有 duration、宽高、fps，**无总帧数与输出路径**；单页录屏，非逐帧确定性生成 |
| [loobah18-arch/rat-film](https://github.com/loobah18-arch/rat-film) | 单 HTML + Playwright 逐帧 + ffmpeg CI | 是一部具体影片作品（TTS/配乐/字幕/GitHub Actions），不是可复用插件 |
| [junjie721/canvas-explainer-videos](https://github.com/junjie721/canvas-explainer-videos) | `renderFrame(n)` 纯函数 + ffmpeg | 是 Agent Skill（Codex/Claude），不是 DSH 插件；绑定旁白与配乐 |
| [q253595422/dsh-imagegen-video](https://github.com/q253595422/dsh-imagegen-video) | 确实是 DSH 插件 | 走第三方 AI 生图/生视频 API（需网关 Key），不是本地 HTML 逐帧渲染 |

**没有任何现成方案同时满足**：DSH Tool 插件形态 + 代码生成独立 HTML 帧 + 分辨率/帧率/总帧数/输出路径全可配 + 本地零外部服务。
因此只自研必要的胶水层，底层全部复用成熟组件：

- 渲染：[Playwright](https://playwright.dev/)（默认复用本机 Edge，免下载 Chromium）
- 编码：[@ffmpeg-installer/ffmpeg](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg)（二进制随 npm 包分发，规避 GitHub Release 直连不稳定）
- 插件规范：DSH 官方 `adding-a-tool.md` / `tool.md` / `publish.md`

其中 `renderFrame(n)` 纯函数保证「预览与导出一致」的思路，借鉴自 `canvas-explainer-videos`。

---

## 遵循的 DSH 规范

| 规范点 | 本仓库落点 |
| --- | --- |
| bundle 三文件 `package.json` + `cordis.patch.yml` + 入口 | 根目录；`files` 已包含 patch 文件（官方点名的常见遗漏） |
| `dsh.bundle.patch` 指向 patch 文件 | `package.json` |
| patch 行用**包名**引用模块 | `cordis.patch.yml` |
| `engines.dsh` 声明兼容区间 | `">=0.2.0 <0.3.0"` |
| 插件形态 `export name / inject / apply(ctx)` | `index.js` |
| `inject: ['tools']` + `ctx.tools.register(defineTool(...))` | `index.js` |
| `parameters` / `output.schema` / `execute` 三分契约 | `src/dsh-adapter.js` |
| DSL 表达不了的约束用 `ToolArgsError` 拒绝 | `src/config.js` + adapter |
| 预期失败抛 `HarnessError` 子类保留 `error.code` | adapter `makeHarnessError()` |
| 遵守 `exec.signal` 取消在途工作 | `throwIfAborted()` + ffmpeg `SIGTERM` |
| 卡片呈现函数必须是纯函数 | adapter `presentCall` / `presentResult`（无 I/O） |
| 长任务走 `ctx.jobs.start`（可选） | adapter 后台分支，默认关闭 |
| 注册为 effect，随插件卸载自动撤销 | 使用 `ctx.tools.register`，未自行管理生命周期 |

参考：`deepseek-ai/deepseek-harness` 的 `docs/cookbook/adding-a-tool.md`、`docs/user/develop/basic/tool.md`、`docs/user/develop/basic/publish.md`。
DSH 处于 developer preview，接口可能破坏性变更 —— 所有宿主耦合点已收敛到 `index.js` 与 `src/dsh-adapter.js`，见下方「待适配点」。

---

## 安装

需要 Node.js >= 20。

```bash
npm install                 # 安装 playwright 与 npm 自带 ffmpeg 二进制
```

### A. 作为 DSH 插件挂到 profile

```bash
dsh plugin --profile web add /absolute/path/to/dsh-frame-animation-plugin
dsh --profile web --dump-config      # 应能看到 "# == dsh-frame-animation" 层
dsh --profile web                    # 启动后模型即可调用 generate_frame_animation
```

卸载：`dsh plugin --profile web remove dsh-frame-animation`。

### B. 独立 CLI（不启动 DSH 也能验证）

```bash
node bin/cli.js --out ./out/demo.mp4 --width 1280 --height 720 --fps 24 --frames 48 --scene ghibli
node bin/cli.js --config examples/config.low.json
node bin/cli.js --help
```

### 开发与测试

```bash
npm run smoke     # 20 项：参数校验 / 帧序硬校验 / 端到端 MP4 / 解码帧数 / 首末帧差异
npm run bench     # 追加低 vs 高分辨率对比（像素 / 渲染耗时 / PNG / MP4）
```

---

## 参数

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `outputPath` | string | **必填** | MP4 绝对路径，必须以 `.mp4` 结尾 |
| `width` / `height` | number | 640 / 360 | 每帧像素尺寸；偶数，16–7680 / 16–4320；奇数自动向下取偶并记入 `corrections` |
| `fps` | number | 24 | 帧率 1–120；时长 = `totalFrames / fps` |
| `totalFrames` | number | 48 | 总帧数 1–999999 |
| `framesDir` | string | 自动隔离 | 帧图输出目录；默认 `<MP4 同级>/frames/<名称>-<时间戳>` |
| `scene` | string | `ghibli` | `ghibli` 宫崎骏风 / `gradient` 极简基准 |
| `htmlTemplatePath` | string | – | 自定义 HTML 模板（`{{FRAME}}` 等占位符） |
| `sceneModulePath` | string | – | 自定义 JS 模块，`export function renderFrame(ctx)`；与上一项二选一 |
| `templateVars` | object | `{}` | 传给模板/模块的变量（注入 HTML 时做转义） |
| `crf` | number | 20 | H.264 CRF 0–51，越小体积越大 |
| `preset` | string | `medium` | x264 preset |
| `settleMs` | number | 0 | 每帧 `setContent` 后额外等待毫秒 |
| `keepHtml` | boolean | false | 把每帧 HTML 一并落盘便于调试 |
| `browserChannel` | string | `msedge` | `msedge` / `chrome` / `chromium` |
| `browserExecutablePath` | string | – | 指定浏览器 exe，优先于 channel |
| `ffmpegPath` | string | – | 指定 ffmpeg，优先于内置二进制 |
| `runInBackground` | boolean | false | 走宿主 `ctx.jobs` 后台通道（需宿主支持） |
| `logLevel` | string | `info` | `debug` / `info` / `warn` / `error` / `silent` |

---

## 输出目录与日志

- **输出目录可配置**：`framesDir` 显式指定即用；不指定则按「时间戳」隔离到独立 run 目录，**永不清理、删除任何已有文件**。
- 目录内产物：`frame_000000.png …`、`report.json`、（可选）`frame_*.html`。
- 显式复用 `framesDir` 时，若其中已有 `frame_*.png` 会先给出告警；帧数或编号对不上时在阶段 3 直接报错，不会静默混入旧帧。
- 日志按 4 个阶段分段，逐帧打印耗时与 PNG 体积（自动节流为 10 档），末尾输出耗时/体积汇总与 `report.json` 路径：

```
[frame-animation] [INFO] ══ 阶段 1/4 参数校验与目录准备 ══
[frame-animation] [INFO] 分辨率 480x270 | 帧率 8 | 总帧数 6 | 时长 0.75s | 每帧 129,600 像素
[frame-animation] [INFO] 帧目录 ...\out\frames\cli-ghibli-20261124-140852（自动隔离）
[frame-animation] [INFO] ══ 阶段 2/4 逐帧生成 HTML 并渲染 PNG ══
[frame-animation] [INFO]   帧 000001 / 000006   17%  347.6ms  28.9KB
...
[frame-animation] [INFO] 帧渲染完成：6 帧 / 552.9ms，PNG 合计 176.6KB，平均 91.7ms/帧，最慢 347.6ms
[frame-animation] [INFO] ══ 阶段 3/4 帧序校验 ══
[frame-animation] [INFO] 帧序 OK：0..5 连续，6/6 文件，无缺失 / 多余 / 空帧
[frame-animation] [INFO] ══ 阶段 4/4 按帧序编码 MP4 ══
[frame-animation] [INFO] 编码完成 72.8ms，MP4 47.3KB
[frame-animation] [INFO] ✅ 完成 总耗时 991.1ms → ...\out\cli-ghibli.mp4
```

---

## 分辨率如何影响速度与文件大小

机制是确定的、非估算的：

1. **渲染**：`deviceScaleFactor` 固定为 1，viewport 就是输出像素数。像素越多，Chromium 光栅化与 PNG 压缩的 CPU 工作量越大 —— 单帧耗时上升。
2. **帧图**：PNG 体积近似随像素数线性增长（同样画面，更多像素 → 更多压缩后数据）。
3. **编码**：libx264 在更高分辨率下做更多宏块的运动估计与变换，编码更慢，输出码流更大。

本机实测（Windows / Node 22.22.2 / Edge headless / 12 帧 / `gradient` 场景 / CRF 20 / preset ultrafast）：

| 档位 | 分辨率 | 像素/帧 | 渲染耗时 | 平均/帧 | PNG 合计 | MP4 | 总耗时 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 低 | 320×180 | 57,600 | 832.3ms | 69.3ms | 377.7KB | 14.7KB | 1.28s |
| 高 | 1280×720 | 921,600 | 2.09s | 173.7ms | 3.96MB | 96.9KB | 2.57s |

像素 **16.0×** → 渲染 **2.51×**、PNG **10.74×**、MP4 **6.58×**。

（PNG/MP4 倍率低于像素倍率，是因为渐变类画面在高分辨率下压缩率更高；换 `ghibli` 这类细节场景差距会更明显。
数值随机器与场景浮动，趋势稳定。复现：`npm run bench`。）

---

## 自定义场景

三种来源，优先级 `sceneModulePath` > `htmlTemplatePath` > `scene`：

1. **HTML 模板** —— 支持占位符：`{{FRAME}}` `{{INDEX}}` `{{TOTAL_FRAMES}}` `{{FPS}}` `{{WIDTH}}` `{{HEIGHT}}` `{{T}}` `{{TIME_SEC}}` `{{VARS.key}}` `{{VARS_JSON}}`。
   所有值注入前做 HTML 转义，`{{VARS_JSON}}` 额外做 script-safe 转义，可安全嵌入 `<script>`。
2. **JS 模块** —— `export function renderFrame(ctx)` 返回完整 HTML 字符串，`ctx = { frame, index, totalFrames, fps, width, height, t, timeSec, vars }`。
3. **内置场景** —— `ghibli` / `gradient`。

示例见 `examples/custom-scene.html` 与 `examples/custom-scene.mjs`。

---

## 错误码

| code | 含义 | 典型原因 |
| --- | --- | --- |
| `ERR_CONFIG` | 参数校验失败 | 缺 `outputPath`、非 `.mp4`、越界、非法枚举、模板与模块同时指定 |
| `ERR_ABORTED` | 任务被取消 | `exec.signal` 触发 / CLI `SIGINT` |
| `ERR_BROWSER` | 浏览器启动失败 | 找不到 Edge/Chrome，或未执行 `npx playwright install chromium` |
| `ERR_RENDER` | 帧图渲染失败 | 截图落盘为空、页面加载异常 |
| `ERR_FRAME_SEQUENCE` | 帧序校验失败 | 缺帧 / 多余帧 / 空帧 |
| `ERR_SCENE` | 帧 HTML 生成失败 | 模块未导出 `renderFrame`、返回空串、模板读取失败 |
| `ERR_FFMPEG` | MP4 编码失败 | ffmpeg 不存在、参数不被支持、输出为空 |
| `ERR_IO` | 文件系统错误 | 目录不可写、路径非法 |

所有错误都会在日志里带阶段名与 code；CLI 失败退出码为 1，参数错误为 2。

---

## 待适配点（DSH 处于 developer preview）

所有宿主耦合点集中在 `index.js` 与 `src/dsh-adapter.js`，核心流水线 `src/pipeline.js` 完全不依赖 DSH。

| 编号 | 位置 | 说明 / 触发条件 | 适配办法 |
| --- | --- | --- | --- |
| **A0** | `index.js` | `defineTool` 的导出包或签名变更 | 只改这一行 import（`@deepseek-ai/dsh-tools` → 新包） |
| **A1** | `dsh-adapter.js` `HOST_MODULE_CANDIDATES` | 宿主错误类的导出位置在 preview 期可能变动 | 已按 `dsh-tools` / `dsh-errors` / `cordis` 顺序动态探测；新增候选包即可 |
| **A2** | `makeArgsError()` | `ToolArgsError` 构造签名未在官方文档给出示例 | 当前按 `new ToolArgsError(message)`；若需 `{ code }` 第二参数，改此处 |
| **A3** | `makeHarnessError()` | `HarnessError` 构造签名未知 | 已尝试 `(msg, {code})` 与 `(msg, code)` 双签名，仍失败则降级为带 `code` 的普通 Error |
| **A4** | `OUTPUT_SCHEMA` | `ValueSchemaSpec` 的 `properties` 支持情况 | 若宿主拒绝，降级为 `{ type: 'object', additionalProperties: true }` |
| **A5** | `execute()` 后台分支 | `ctx.jobs.start()` 返回句柄字段（`jobId`/`id`）与 `run` 回调契约未在文档细化 | 默认 `runInBackground=false` 不触发；启用前按实际运行时核对 |
| **A6** | 验收流程 | 未在本机真实 profile 完成「冷启动 / 热加载 / 配置热更新 / 完整卸载」四态验收 | 需 `dsh plugin --profile add` + `dsh --profile --dump-config` 后逐项验证 |
| **A7** | `package.json` `engines.dsh` | 写成 `">=0.2.0 <0.3.0"`；SemVer 默认不匹配 prerelease，而本机 DSH 为 `0.2.2-rc.3` | 若安装被拒，改为 `">=0.2.0-0 <0.3.0"` 或移除该字段 |

> 已完成的验证：独立 CLI 端到端（生成 / 帧序 / 解码帧数 / 首末帧差异）与参数、帧序两类负向用例全部通过，
> 详见 `npm run smoke`。宿主内四态验收（A6）需要在装有 `dsh` CLI 的环境补做。

---

## 已知限制

- **串行渲染**：为保证帧序绝对正确，帧逐个渲染，未做并发；长视频耗时随帧数线性增长。
- **无音轨**：仅视频流。需要配音/配乐可后续接 ffmpeg `-i audio -shortest`。
- **浏览器依赖**：Windows 默认复用系统 Edge/Chrome；macOS/Linux 请执行 `npx playwright install chromium` 或设置 `browserExecutablePath`。
- **ffmpeg 版本**：`@ffmpeg-installer/ffmpeg` 为 4.x，覆盖 libx264/yuv420p 足够；需要新特性时用 `ffmpegPath` 指向自装 ffmpeg。
- **不自动删除帧图**：帧目录默认保留以便追溯与重编码，磁盘清理需自行处理（插件不会删除任何文件）。

---

## 目录结构

```
dsh-frame-animation-plugin/
├── package.json          # dsh.bundle manifest / engines.dsh / 依赖
├── cordis.patch.yml      # bundle 配置层（按包名插入插件行）
├── index.js              # DSH 插件入口：name / inject / apply
├── src/
│   ├── dsh-adapter.js    # ★ 宿主适配层（A1-A5 待适配点都在这里）
│   ├── pipeline.js       # 4 阶段编排（与宿主无关）
│   ├── config.js         # 参数表 + 校验 + 归一化
│   ├── scene.js          # 内置 ghibli/gradient 场景 + 模板/模块渲染
│   ├── renderer.js       # Playwright 多级回退启动 + 逐帧截图
│   ├── frame-writer.js   # 目录准备 + 帧序硬校验 + report
│   ├── encoder.js        # ffmpeg 探测 + 帧序编码
│   ├── logger.js         # 分级日志 / 进度节流 / 格式化
│   └── errors.js         # 错误码 + AbortError + 归一化
├── bin/cli.js            # 独立 CLI（node:util parseArgs）
├── examples/             # 低/高分辨率配置、自定义模板、自定义场景模块
└── test/smoke.mjs        # 冒烟 + 分辨率基准
```

---

## License

MIT

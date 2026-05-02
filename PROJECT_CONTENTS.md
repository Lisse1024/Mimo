# KOC LangGraph Agent 项目内容说明

本文档用于说明当前项目的真实组成、运行链路、主要模块职责和已知边界。它面向需要接手、排查或继续扩展该项目的开发者。

## 1. 项目定位

`koc_langgraph_agent` 是一个面向 KOC/达人内容增长场景的桌面智能体应用。它不是单纯聊天机器人，而是把桌面观察、用户授权截图/录屏、素材理解、平台线索、长期记忆、策略生成、任务闭环和复盘回填串起来，形成一个面向内容创作者的 Agent 工作流。

当前项目目标是帮助用户完成这些任务：

- 诊断账号主页：基于主页截图、页面可见信息、用户输入和历史记忆，判断账号定位、内容矩阵、主页转粉问题和下一步动作。
- 拆解单条作品：基于当前刷到的视频录屏、截图、标题标签、抽帧结果和模型视觉分析，输出片源判断、看点、脚本结构、可复刻拍法和验证指标。
- 形成 Agent 闭环：不是只给建议，而是输出“证据 -> 判断 -> 动作 -> 验证指标 -> 复盘回填”的可执行链路。
- 维护增长记忆：记录平台、账号、作品、实验和复盘结果，下一轮分析时作为上下文。
- 支持桌面交互：通过 Tauri 桌宠界面提供观察、上传素材、分析当前视频、诊断账号、查看过程和下一步动作。

## 2. 总体架构

项目由三层组成：

```text
Tauri 桌面端
  apps/desktop
  apps/desktop/src-tauri
        |
        v
Node 桌面网关
  apps/server
        |
        v
Python KOC LangGraph 后端
  koc_backend
  koc_graph
        |
        v
本地数据目录 / 可选 PostgreSQL
  data/
  database/schema.sql
```

三层职责不同：

- Tauri 桌面端负责用户界面、桌宠、系统托盘、截图、录屏、上传素材、通知和本地窗口控制。
- Node 网关负责桌面端和 Python 后端之间的 API 适配、当前窗口观察、浏览器上下文桥接、媒体预处理、KOC 任务轮询、记忆/复盘 API。
- Python 后端负责真正的 KOC Agent 工作流，包括 LangGraph 编排、素材分析、Kimi 文本/视觉调用、证据契约、策略生成、任务持久化和增长记忆。

## 3. 运行方式

根目录 `package.json` 提供主要脚本：

```powershell
npm run setup
npm run dev
npm run dev:koc
npm run dev:server
npm run dev:desktop
npm run build
npm run self-check
```

完整开发运行：

```powershell
npm run dev
```

会同时启动：

```text
Python KOC 后端       http://127.0.0.1:8010
Node 桌面网关         http://127.0.0.1:8787
Tauri 桌面应用        本地桌宠窗口
```

只启动 Python 后端：

```powershell
python -m koc_backend
```

只构建 Node 网关：

```powershell
npm.cmd --workspace apps/server run build
```

只构建前端：

```powershell
npm.cmd --workspace apps/desktop run build
```

检查 Python 语法：

```powershell
python -m compileall koc_backend koc_graph
```

## 4. 环境变量

配置文件模板在 `.env.example`，本地实际配置在 `.env`。

核心配置：

```text
MOONSHOT_API_KEY              Kimi/Moonshot API Key
KIMI_BASE_URL                 默认 https://api.moonshot.cn/v1
KIMI_TEXT_MODEL               默认 kimi-k2.5
KIMI_VISION_MODEL             默认 kimi-k2.5
KIMI_API_TIMEOUT_SECONDS      模型请求超时时间
KIMI_MAX_TOKENS               最大输出 token
KIMI_VISION_ASSET_LIMIT       提交给视觉模型的素材数量上限
KIMI_MAX_REQUEST_CHARS        请求文本最大长度
KIMI_RETRY_ATTEMPTS           Kimi 失败重试次数
KIMI_RETRY_BACKOFF_SECONDS    重试基础间隔
```

数据配置：

```text
KOC_DATABASE_URL              PostgreSQL 连接串，可为空
KOC_DB_PROVIDER               local / postgres
KOC_VECTOR_PROVIDER           pgvector 等向量存储策略
KOC_LANGGRAPH_IN_MEMORY_CHECKPOINTS
```

媒体配置：

```text
KOC_OCR_PROVIDER              OCR 提供方，默认 auto
KOC_ASR_PROVIDER              ASR 提供方，默认 auto
DESKMATE_AUDIO_DEVICE         可选，Windows 录屏音频设备名
```

注意：当前 Kimi 视觉失败时，最近一次真实错误是 `HTTP 429 engine_overloaded_error`，这是上游模型过载，不是截图/录屏失败，也不是 API key 没读到。

## 5. 根目录内容

```text
.env.example                  环境变量模板
.env                          本地密钥和运行配置，不应提交
package.json                  npm workspaces 和统一脚本
requirements.txt              Python 依赖
README.md                     原始项目说明
PROJECT_CONTENTS.md           当前文档
apps/                         桌面端和 Node 网关
koc_backend/                  Python KOC 业务后端
koc_graph/                    LangGraph 工作流节点
database/schema.sql           推荐生产数据库 schema
data/                         本地运行数据、上传素材、SQLite、任务记录
scripts/                      自检、数据库初始化、演示脚本
demo/                         演示材料
```

## 6. Tauri 桌面端

位置：

```text
apps/desktop
apps/desktop/src
apps/desktop/src-tauri
```

技术栈：

- React 18
- Vite
- Tauri 2
- Pixi.js
- pixi-live2d-display

### 6.1 前端入口

```text
apps/desktop/src/main.tsx
apps/desktop/src/App.tsx
apps/desktop/src/PetApp.tsx
apps/desktop/src/SettingsApp.tsx
apps/desktop/src/styles.css
```

`PetApp.tsx` 是当前最核心的前端文件，承担大量桌面 Agent UI 逻辑：

- 聊天输入与输出。
- KOC 快捷动作。
- 上传素材。
- 当前视频录制、停止录制并分析。
- 自动截图。
- 浏览器/窗口观察提示。
- KOC 任务创建和轮询。
- Agent 过程面板。
- 证据与风险展示。
- 下一步行动展示。
- 中文化和内部字段清理。
- 日程、天气、设置等桌面助手功能。

### 6.2 前端关键交互

当前主操作按钮包括：

```text
停止观察
上传素材
分析当前视频 / 停止录制并分析
诊断账号
更多
```

KOC 相关流程：

- `上传素材`：把用户选择的截图/视频作为证据传给后端。
- `分析当前视频`：启动当前前台窗口录屏，完成后提交给 KOC 分析。
- `诊断账号`：偏向主页/账号定位诊断。
- `读取链接`：从用户输入中提取作品/主页链接，作为平台线索。
- `观察模式`：持续读取前台窗口标题、浏览器平台线索和页面类型。

### 6.3 Agent 面板

前端已经有 KOC Agent 面板，核心展示：

- 当前阶段。
- 过程摘要。
- 依据与风险。
- 下一步补充。
- Agent 闭环。

Agent 闭环用于让用户看到：

```text
取证 -> 分析 -> 判断 -> 动作 -> 验证 -> 复盘
```

而不是只看到一句“优先动作”。

### 6.4 Live2D / 桌宠

相关文件：

```text
Live2DAvatar.tsx
CharacterAvatar.tsx
styles.css
```

负责桌宠视觉形象、动作、状态反馈和 UI 位置感。

## 7. Tauri Rust 层

位置：

```text
apps/desktop/src-tauri/src/lib.rs
```

主要职责：

- 创建主窗口和设置窗口。
- 系统托盘。
- Windows 前台窗口识别。
- 自动截图。
- 当前视频录屏。
- 停止录屏并返回 mp4。
- 音频录制和视频音频合成。
- 给 React 前端暴露 Tauri commands。

当前重要命令：

```text
show_settings_window
capture_primary_screen
start_current_video_recording
stop_current_video_recording
record_primary_screen
```

### 7.1 截图链路

截图使用 Windows `CopyFromScreen`：

- 先读取前台窗口矩形。
- 使用 DPI-aware 坐标。
- 对虚拟桌面范围做裁剪。
- 若不能稳定定位窗口，则使用 `SystemInformation.VirtualScreen` 兜底。

这个设计是为了解决高 DPI、多屏和浏览器窗口场景下“只截到部分区域”的问题。

### 7.2 录屏链路

录屏使用 ffmpeg `gdigrab`：

- 使用前台窗口原始矩形。
- 输出临时 mp4。
- 可选 WASAPI loopback 录音。
- 尝试合成视频和音频。
- 返回 `data:video/mp4;base64,...` 给前端。

注意：截图和录屏不能混用坐标换算。截图走 `CopyFromScreen`，录屏走 `gdigrab`。之前混用会导致截图或录屏尺寸异常。

## 8. Node 桌面网关

位置：

```text
apps/server
apps/server/src
```

技术栈：

- Express
- TypeScript
- tsx
- pg
- dotenv

主要职责：

- 给桌面端提供统一 API。
- 代理 Python KOC 后端。
- 读取当前窗口上下文。
- 接收浏览器桥接信息。
- 做媒体预处理和视频抽帧。
- 维护 KOC 记忆仓库。
- 提供 readiness、agenda、review 等 Agent 运维接口。

### 8.1 主要 API

桌面通用能力：

```text
GET  /api/settings
POST /api/settings
GET  /api/calendar/status
POST /api/calendar/disconnect
GET  /api/calendar/today
GET  /api/news/top
POST /api/briefing/daily
GET  /api/weather
```

观察与浏览器桥接：

```text
GET  /api/observer/context
POST /api/observer/mode
POST /api/browser/context-bridge
```

KOC Agent：

```text
GET  /api/koc/status
GET  /api/koc/readiness
GET  /api/koc/memory
GET  /api/koc/agenda
POST /api/koc/memory/review
POST /api/koc/experiment/review
GET  /api/koc/job
POST /api/koc/diagnose
POST /api/chat
```

### 8.2 关键文件

```text
index.ts                   Express 入口和路由
koc-growth.ts              KOC 任务创建、轮询、最终回复组装
media-analysis.ts          上传媒体保存、视频抽帧、视觉素材准备
platform-connectors.ts     链接、标题、浏览器可见文本的平台线索解析
window-monitor.ts          前台窗口和浏览器上下文识别
koc-memory.ts              增长记忆逻辑
koc-memory-repository.ts   本地/PostgreSQL 记忆仓库
experiment-review.ts       实验复盘
embeddings.ts              向量嵌入接口
tool-registry.ts           Node 侧工具注册
storage.ts                 本地存储辅助
types.ts                   共享类型
config.ts                  Node 配置
```

### 8.3 Node 与 Python 的关系

桌面端通常不直接打 Python 后端，而是先打 Node 网关。Node 网关再把 KOC 任务请求转给 Python 后端，并负责轮询任务结果、中文化输出、清理内部字段、展示过程 trace。

## 9. Python KOC 后端

位置：

```text
koc_backend
```

这是 KOC Agent 的业务核心，负责模型调用、素材理解、工作区生成、任务持久化和 LangGraph 运行时依赖。

### 9.1 HTTP 服务

入口：

```text
koc_backend/__main__.py
koc_backend/http_api.py
```

主要接口：

```text
GET  /
GET  /api/health
GET  /api/bootstrap
GET  /api/workspace
GET  /api/strategy-jobs
POST /api/profiles
POST /api/strategy
POST /api/strategy-jobs
POST /api/calendar
POST /api/post-pack
POST /api/review
POST /api/tasks/update
```

### 9.2 模型调用

文件：

```text
koc_backend/llm.py
```

能力：

- Kimi 文本 JSON 调用。
- Kimi 视觉 JSON 调用。
- 图片和视频素材转成可提交给模型的内容块。
- JSON 解析和容错。
- 请求记录。
- 超时、429、上游失败重试。

视觉分析失败时会返回结构化降级结果：

```text
vision_disabled       未配置 API key
no_inline_assets      没有可提交的图片/视频数据
vision_failed         请求 Kimi 失败，例如 429 engine_overloaded
vision_parse_failed   模型返回无法解析为 JSON
```

### 9.3 素材分析

文件：

```text
koc_backend/assets.py
koc_backend/work_understanding.py
koc_backend/video_context.py
koc_backend/video_understanding.py
```

能力：

- 保存上传素材。
- 识别图片、视频、截图、录屏。
- 准备视觉模型素材。
- 构造视频理解 prompt。
- 抽取片源、人物、剧情、字幕、评论区线索、可复刻结构。
- 在视觉模型失败时构造保守结果。

### 9.4 策略与兜底

文件：

```text
koc_backend/strategy_service.py
koc_backend/rule_strategy.py
koc_backend/strategy_reports.py
koc_backend/homepage_signals.py
```

职责：

- 根据任务类型选择单条作品拆解、账号诊断或主页链接处理。
- 使用模型策略或规则策略。
- 对证据不足的任务输出保守判断。
- 生成账号定位、内容支柱、增长阶段、动作、KPI、复盘模板。
- 单条视频分析时避免把单条作品直接上升为账号长期赛道。

当前已经修正的一点：

- 当视觉模型降级或字段不完整时，不再固定输出“开头需要让用户立刻知道冲突、反差或情绪点”。
- 可执行脚本步骤不再固定套“0-3 秒最强冲突 / 4-12 秒补上下文 / 13-25 秒情绪爆点”。
- 现在会优先从素材摘要、片源、标题、标签、字幕、视频理解中抽取动态看点。

### 9.5 证据、边界和任务

文件：

```text
koc_backend/artifacts.py
koc_backend/task_service.py
koc_backend/workspace_service.py
```

职责：

- 生成证据摘要。
- 区分可用、降级、缺失证据。
- 生成证据契约。
- 约束哪些内容能对用户展示，哪些是内部字段。
- 生成任务列表和下一步补充动作。
- 生成日历、发布包、复盘和工作区 payload。

证据边界会告诉用户：

- 哪些证据缺失。
- 哪些证据降级。
- 当前结论能不能被说成“后台数据证明”。
- 哪些只是截图、抽帧、标题、可见文本或模型推断。

### 9.6 增长记忆

文件：

```text
koc_backend/memory.py
koc_backend/storage.py
koc_backend/database.py
koc_backend/profiles.py
```

职责：

- 维护账号、平台、作品和实验记忆。
- 写入本地 SQLite / JSON。
- 可选接入 PostgreSQL。
- 记录模型调用和异步任务。
- 为下一轮诊断提供历史上下文。

## 10. LangGraph 工作流

位置：

```text
koc_graph
koc_graph/nodes
```

核心入口：

```text
koc_graph/graph.py
koc_graph/runtime.py
koc_graph/state.py
```

节点目录：

```text
nodes/intake.py              读取任务输入和账号档案
nodes/platform.py            解析平台身份线索
nodes/assets.py              分析上传素材
nodes/evidence_snapshot.py   汇总证据快照
nodes/decision.py            根据任务和证据质量路由
nodes/internal_reports.py    构建内部诊断报告
nodes/hot_video.py           热点/爆款参考分析
nodes/strategy.py            生成策略
nodes/evidence.py            证据与追问
nodes/persist.py             持久化工作区和完成任务
nodes/common.py              节点通用工具
```

### 10.1 工作流大致顺序

```text
load_profile
  -> resolve_platform_identity
  -> analyze_assets
  -> collect_evidence_snapshot
  -> decision_gate
      -> plan_evidence_repair
      -> request_user_evidence
      -> build_internal_reports
      -> build_hot_video_analysis
      -> build_strategy
  -> build_evidence_and_followups
  -> persist_workspace
  -> finalize_job
```

### 10.2 路由逻辑

工作流会根据这些条件决定下一步：

- 用户是要诊断账号，还是分析单条作品。
- 是否只有主页/作品链接。
- 是否有截图/视频/抽帧。
- Kimi 视觉是否成功。
- 证据是否足够。
- 长期记忆是否有强信号。
- 是否需要先请求用户补充证据。

这使项目不是简单“请求一次模型”，而是有明确控制流、失败分支和证据边界的 Agent。

## 11. 数据目录

位置：

```text
data/
```

常见内容：

```text
data/koc_agent.sqlite3          本地 SQLite
data/async_jobs.json            异步任务状态
data/store.json                 本地账号/工作区数据
data/uploads/                   用户上传和后端保存的素材
data/asr/                       ASR 产物
data/runtime/                   运行日志
data/debug_video_frames*/       调试抽帧
```

上传素材会保存在 `data/uploads/<批次>/`，视频抽帧也会以图片形式写入对应目录。

## 12. 生产数据库设计

位置：

```text
database/schema.sql
```

推荐生产方案是 PostgreSQL + pgvector，而不是一开始引入单独知识图谱数据库。

设计对象包括：

```text
users
platform_accounts
works
asset_objects
diagnosis_jobs
evidence_items
experiments
experiment_reviews
memory_profiles
memory_edges
model_calls
```

数据库目标：

- 保存账号、作品、实验和证据。
- 保存模型调用日志。
- 支持语义召回。
- 通过 `memory_edges` 维护轻量关系图。
- 大文件只存对象 key、hash、duration、metadata，不直接塞进数据库。

## 13. 媒体与视觉分析链路

单条视频分析的典型链路：

```text
用户点击“分析当前视频”
  -> Tauri 隐藏桌宠并录制当前窗口
  -> stop_current_video_recording 返回 mp4
  -> 前端把录屏作为 KOCUploadAsset 传给 Node
  -> Node 保存素材并抽帧
  -> Python 保存上传批次
  -> Python 组装 video_understanding ledger
  -> Kimi 视觉模型分析图片/视频素材
  -> LangGraph 根据证据质量路由
  -> 输出结论、动作、验证指标和证据边界
```

如果视觉模型失败：

- 不应假装看完完整视频。
- 使用已抽帧、窗口标题、用户输入、标题标签和历史记忆做保守分析。
- 输出中必须标注证据边界。
- 可执行内容应标明“待确认片源/低置信”，不能把结论说成后台数据证明。

## 14. 前端输出中文化与内部字段清理

前端有 `sanitizeVisibleText()` 和 `translateInternalIdentifier()`，用于避免把内部枚举、英文 key、调试字段直接暴露给用户。

已覆盖的典型字段包括：

```text
platform_hint              平台身份线索
fetched_platform_data      平台公开页数据
browser_visible_metrics    浏览器可见互动指标
visual_asset_analysis      截图/视频视觉分析
video_timeline             视频抽帧时间线
single_work_analysis       单条作品拆解
account_growth_diagnosis   账号增长诊断
```

仍需注意：如果后端新增了内部 key，前端和 `apps/server/src/koc-growth.ts` 的中文化映射也要同步补充。

## 15. 日程、天气和普通桌面助手能力

虽然项目核心是 KOC Agent，但前端和 Node 网关还保留普通桌面助手能力：

- 日程读取和展示。
- 天气卡片。
- 每日简报。
- 新闻 top。
- 飞书授权占位。
- 通知提醒。
- 设置页。

这些能力主要在：

```text
apps/desktop/src/PetApp.tsx
apps/desktop/src/SettingsApp.tsx
apps/server/src/index.ts
```

其中 `/api/weather`、`/api/calendar/today` 等目前偏模拟或轻量接口，不是 KOC 主流程。

## 16. 已知边界

当前项目不是官方平台数据抓取系统，不能直接声明拥有平台后台指标。

当前可靠证据来源：

- 用户授权截图。
- 用户授权录屏。
- 用户上传素材。
- 浏览器当前可见页面标题、文本、结构化线索。
- 用户手动提供链接。
- OCR/ASR 可提取内容。
- 用户发布后手动回填数据。

当前缺失或降级时必须提示：

- 平台公开页数据缺失。
- 浏览器可见互动指标缺失。
- 评论区真实数据缺失。
- 后台完播、留存、转粉数据缺失。
- 片源、完整剧情、台词、BGM 无法仅凭少量帧确认。

因此输出中不能写：

- “后台数据证明会涨粉”。
- “这条一定能爆”。
- “完整剧情是……”但实际只看了截图。
- “评论区都在说……”但没有评论区截图或数据。

合理表述应该是：

```text
基于当前可见截图/录屏/标题标签，低/中/高置信判断为……
缺失平台后台数据和评论区证据，因此只能先做小样本验证。
发布后回填 3 秒停留、完播率、评论关键词、收藏和主页点击，再判断模板是否成立。
```

## 17. 当前重要修复记录

近期已经处理过的问题：

- 截图范围只截到局部：修复为 DPI-aware `CopyFromScreen`，兜底使用 Windows VirtualScreen。
- 录屏尺寸被改坏：恢复录屏使用前台窗口原始矩形，不再混用截图坐标逻辑。
- Kimi 视觉偶发失败：确认最近真实原因是 HTTP 429 `engine_overloaded_error`，已增加重试次数和退避时间。
- 分析结果太泛：最终回复增加有效结论、帮助、判断依据、现在先做、可执行内容、任务闭环、验证指标、复盘回填和证据边界。
- 固定模板问题：单条作品的核心看点和执行步骤改为从当前素材动态提取，不再固定套通用话术。
- 证据边界中文化：内部 key 显示为中文证据名称。
- 前端按钮文案对齐：上传素材、分析当前视频、停止录制并分析、诊断账号。
- 前端 Agent 闭环展示：增加闭环区，避免只显示过程摘要和风险。

## 18. 继续开发建议

优先级较高的后续工作：

1. 把 `PetApp.tsx` 拆分为更小的 hooks 和组件，降低维护成本。
2. 把 KOC 业务 UI、普通聊天、日程天气、Live2D 状态分离。
3. 给截图/录屏增加端到端测试或至少保存调试 metadata，避免坐标问题回归。
4. 给 Kimi 视觉失败增加更明确的用户态错误分类：过载、超时、key 无效、模型不支持视频、请求体过大。
5. 把前端中文化映射和后端证据 key 映射集中管理。
6. 对 `rule_strategy.py` 做模块拆分，尤其是单条作品、主页链接、账号诊断三个分支。
7. 为 `apps/server/src/koc-growth.ts` 的最终回复生成补充单元测试，防止固定模板和内部字段泄漏回归。
8. 逐步接入 PostgreSQL + pgvector 的生产数据层。

## 19. 快速排查清单

如果截图不对：

- 看 `apps/desktop/src-tauri/src/lib.rs` 的 `capture_primary_screen`。
- 确认截图走 `CopyFromScreen` 和 VirtualScreen。
- 不要把 gdigrab 坐标归一化用于截图。

如果录屏尺寸不对：

- 看 `start_current_video_recording` 和 `spawn_recording_process`。
- 确认录屏使用前台窗口原始矩形。
- 不要把截图用的 DPI-aware 修正套到录屏。

如果 Kimi 视觉失败：

- 看 `data/async_jobs.json` 中 `workspace.asset_analysis.limitations`。
- 如果是 429，就是上游过载。
- 如果是 `vision_disabled`，检查 `MOONSHOT_API_KEY`。
- 如果是 `no_inline_assets`，检查素材是否成功保存和是否是支持的 image/video mime。
- 如果是 `vision_parse_failed`，检查模型返回是否不是 JSON。

如果结果又变泛：

- 看 `workspace.asset_analysis.status`。
- 看是否有视频抽帧。
- 看 `advisor_summary.one_sentence_diagnosis` 是否来自固定兜底。
- 看 `evidence_contract.missing_keys` 和 `degraded_keys`。
- 看前端是否把内部字段清理成中文。

## 20. 项目当前一句话总结

这是一个以 LangGraph 为控制流、以桌面截图/录屏和 Kimi 视觉分析为证据入口、以 KOC 内容增长建议和复盘记忆为目标的桌面 Agent。它当前已经具备从“用户看到一个作品或主页”到“收集证据、分析、给出动作、设置验证指标、等待复盘回填”的闭环雏形，但仍需要继续强化组件拆分、测试覆盖、视觉失败兜底和生产数据层。

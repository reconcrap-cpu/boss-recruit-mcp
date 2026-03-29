---
name: "boss-recruit-pipeline"
description: "Use when users ask to recruit candidates on Boss Zhipin via the boss-recruit-mcp pipeline; enforce setup checks, calibration gating, parameter confirmation, and MCP/CLI fallback handling."
---

# Boss Recruit Pipeline Skill

## Purpose

当用户给出招聘需求时，优先调用 MCP 工具 `run_recruit_pipeline` 完成端到端任务：

1. 解析指令
2. 校验必填项
3. 关键词自动提取与确认
4. 调用搜索与筛选工具
5. 返回简洁摘要结果

适用场景：

- 在 Boss 上按城市 / 学历 / 学校标签搜索候选人
- 再按自然语言 criteria 做二次 LLM 筛选
- 适合“做过某方向 + 额外论文/项目/经历要求”的招聘请求

## Setup First

在真正调用 `run_recruit_pipeline` 前，先检查运行条件，不要直接进入搜索：

1. 先检查 MCP 是否已安装 / 可调用；若未安装，优先执行：
   - `npx @reconcrap/boss-recruit-mcp install`
   - 若要给 Cursor / Trae / Claude Code / OpenClaw 快速接入，执行 `boss-recruit-mcp mcp-config --client all`，并把生成文件中的 `mcpServers` 合并到对应客户端配置
2. 若用户还未确认 Chrome 调试端口，必须先询问：
   - 建议使用 `9222`
   - 但也允许用户明确提供一个已在使用的其他远程调试端口
3. 在用户确认端口前，不要直接假设 `9222` 并执行任何依赖端口的命令。
4. 用户确认端口后，先执行一次端口固化，确保后续动作自动沿用同一端口：
   - `boss-recruit-mcp set-port --port <port>`
5. 再检查依赖与端口状态：
   - `boss-recruit-mcp doctor`（或显式 `boss-recruit-mcp doctor --port <port>`）
6. 任何“准备打开 Chrome”的动作前，必须先判断该端口是否已有可用实例：
   - 若调试端口可连，禁止再新开 Chrome；直接复用现有实例，并确保页面在 `https://www.zhipin.com/web/chat/search`
   - 仅当调试端口不可连时，才执行 `boss-recruit-mcp launch-chrome --port <port>`
7. 若执行 `launch-chrome` 后页面没有停留在 `https://www.zhipin.com/web/chat/search`：
   - 若仍在 search 页面，可继续；
   - 若跳转到登录页、首页或其他 Boss 页面，视为“需要重新登录”；
   - 必须明确提示用户手动登录 Boss，并等待用户回复“已登录/可以继续”后，才能继续后续动作。
8. 无论是复用已有实例，还是新开实例并导航到 search 页面，只要曾经到达过 search，都必须再做一次短延时复查（例如 1-2 秒）：
   - 若复查时仍在 search 页面，才允许继续；
   - 若从 search 自动跳转到其他 Boss 页面，优先判定为“登录态失效/未登录”，提示用户先登录；
   - 在用户明确回复“已登录，可以继续”前，不得执行搜索和筛选。
9. 只有在以上条件满足后，才继续调用流水线。

## Calibration Requirement

- 如果缺少 `favorite-calibration.json`，不要直接搜索筛选。
- 需要明确提醒用户先做校准。
- 校准文件缺失时，不能去电脑里搜索其他历史遗留的 `favorite-calibration.json`，也不能复制 npm 包、vendor 目录、旧工作区、旧账号目录里的文件来凑。
- 只能引导用户在当前环境、当前页面布局、当前端口下重新生成校准文件。
- 如果 `screening-config.json` 配了自定义 `calibrationFile` 路径，而该路径缺失：
  - 必须明确告诉用户“当前期望的校准文件路径”；
  - 应指导用户用 `boss-recruit-mcp calibrate --port <port> --output <expected-path>` 直接生成到该路径；
  - 不要静默改写配置，也不要把别处的文件复制过去。
- 校准动作说明用于“让用户了解流程”，不要求用户先手动点击页面：
  - 打开 Boss 直聘搜索页面
  - 打开任意一位人选详情页
  - 执行一次收藏，再取消收藏
  - 关闭详情页
- 校准对话必须是“两阶段”：
  - 第一阶段：先完整说明校准步骤，然后只问“是否准备好开始校准”；
  - 第二阶段：用户确认“准备好了”后，直接启动校准命令，并明确说明“你不需要先手动完成页面点击，我会立即启动校准流程”。
- 不要把“请确认你已完成校准”当作启动校准的前置问题；启动前应确认“准备开始”，不是“已经完成”。
- 不要要求用户先完成页面操作再回复“可以校准/已完成校准”；应在用户确认“准备开始”后立即执行校准。
- 然后执行：
  - `boss-recruit-mcp calibrate --port <port>`（默认监听 60 秒）
- 默认校准文件路径：
  - `$CODEX_HOME/boss-recruit-mcp/favorite-calibration.json`

## Required MCP Tool

- Tool name: `run_recruit_pipeline`
- Input:
  - `instruction` (string, required)
  - `confirmation` (object, optional)
    - `keyword_confirmed` (boolean): 是否确认关键词
    - `keyword_value` (string): 用户确认或改写后的关键词
    - `search_params_confirmed` (boolean): 用户是否已明确确认当前参数集
    - `criteria_confirmed` (boolean): 用户是否已明确确认筛选 criteria（尤其硬性约束）
    - `use_default_for_missing` (boolean): 用户是否明确同意对缺失参数使用默认值
  - `overrides` (object, optional)
    - `city` (string)
    - `degree` (string)
    - `schools` (string[] | comma-separated string)
    - `keyword` (string)
    - `target_count` (number)
- Tool response 重点字段：
  - `status`
  - `required_confirmations`
  - `pending_questions`
  - `review.extracted_search_params`
  - `review.current_search_params`
  - `review.missing_fields`
  - `review.suspicious_fields`
  - `review.default_preview`
  - `review.applied_defaults`

## Backend Selection

- 默认执行路径：优先使用 MCP 工具 `run_recruit_pipeline`。
- 如果当前 AI agent 无法添加新的 MCP、MCP 数量受限、或当前会话拿不到该工具：
  - 直接切换到 CLI fallback；
  - 不要放弃流程，也不要要求用户手动把所有步骤重新翻译一遍。
- CLI fallback 必须调用与 MCP 相同后端的命令：
  - `boss-recruit-mcp run --instruction "<user request>"`
- 如果命令行里直接放长文本不稳定，改用文件输入：
  - `boss-recruit-mcp run --instruction-file <path>`
- 如果需要传确认信息或覆盖参数，使用这些参数：
  - `--confirmation-json '<json>'`
  - `--confirmation-file <path>`
  - `--overrides-json '<json>'`
  - `--overrides-file <path>`
- CLI fallback 的输出是 JSON，字段语义与 MCP 返回保持一致；优先按同一套状态机处理：
  - `NEED_INPUT`
  - `NEED_CONFIRMATION`
  - `COMPLETED`
  - `FAILED`
- 当 CLI fallback 可用时，不要再自行拼接搜索 CLI / 筛选 CLI 的底层命令来重建业务逻辑；优先继续复用 `boss-recruit-mcp run`。

## Confirmation First

- 在任何一次正式搜索 / 筛选开始前，必须先单开一轮“参数确认对话”，不能在首轮解析后直接开跑。
- 这轮确认对话必须把当前已提取参数、疑似错误参数、缺失参数分开列给用户。
- 对于明显异常或语义可疑的提取值，不能默认接受，必须让用户二次确认后才能继续。
- 例如：
  - 提取出的城市像“杭州筛选做过”这类明显脏值时，必须明确告诉用户“当前识别结果可能不正确”，并请用户改成标准城市名如“杭州”。
  - 学历、学校标签、关键词、目标人数等若提取结果带噪声、过长、混入条件短语，也都要按“待确认项”处理。
- 如果用户在这轮确认后仍未补全缺失项，agent 也不能直接静默开始，必须再明确说明：
  - 哪些参数仍缺失；
  - 将会使用什么默认值；
  - 这些默认值会降低搜索结果质量或扩大偏差。
- 只有在用户明确回复“确认按这些默认值继续”后，才允许正式执行。

## Execution Policy

1. 收到招聘指令后，先做 setup 检查：
   - MCP 是否可用
   - 若 MCP 不可用，CLI fallback 是否可用
   - Chrome 调试端口是否已确认
   - Chrome 是否能被导航到 Boss 搜索页面
   - 导航到 search 后 1-2 秒是否仍稳定停留在 search（而不是自动跳转）
   - `favorite-calibration.json` 是否存在
2. 若缺少依赖或 MCP 未启动：
   - 自动安装依赖并帮助用户启动 MCP；
   - 优先使用 `npx @reconcrap/boss-recruit-mcp install`
   - 然后优先尝试使用用户的 MCP 配置启动 `boss-recruit-mcp`
   - 如果当前 agent 因平台限制无法配置 MCP，切换到 CLI fallback
3. 若缺少校准文件：
   - 明确提示用户先完成校准，不要直接调用流水线；
   - 明确给出校准步骤与命令；
   - 明确指出期望生成到哪个路径；
   - 不要在本机搜索并复用其他 `favorite-calibration.json`。
   - 校准引导必须先问“是否准备好开始校准”；用户确认准备好后，再执行：
     - `boss-recruit-mcp calibrate --port <port>`
   - 不要要求用户先手动完成“收藏/取消收藏”等页面动作，再触发 `calibrate`。
   - 除非调试端口不可连，否则不要额外先执行 `launch-chrome`。
4. 若校准流程中发现页面没有停留在 search，或跳到了登录页、首页或其他页面：
   - 明确告诉用户“当前需要手动登录 Boss”；
   - 明确要求用户在当前可见的 Chrome 窗口中完成登录；
   - 等用户回复“已登录，可以继续”后，再继续下一步；
   - 不要在用户未确认登录完成前直接执行搜索、校准或流水线。
5. 只有当以上条件满足时，才首次进入流水线解析：
   - 若 MCP 可用，调用 `run_recruit_pipeline`（只传 `instruction`）
   - 若 MCP 不可用，调用 `boss-recruit-mcp run --instruction ...`
   - 这一步用于“解析”，不是立刻执行最终搜索结论。
5. 拿到首次解析结果后，先进入单独的“参数确认对话”：
   - 列出当前已提取到的参数；
   - 单独标出需要用户确认的参数；
   - 单独列出 `missing_fields` 中所有缺失项；
   - 如果某个字段看起来明显异常、像脏字符串、或不符合标准筛选值，直接归入“待确认 / 待修正”而不是默认使用。
6. 缺失项常见含义：
   - `city`: 城市，如“杭州”
   - `degree`: 学历，如“本科”“硕士及以上”
   - `schools`: 学校标签，如“统招本科、双一流院校、985、211、qs100、qs500”
   - `filter_recent_viewed`: 是否过滤近 14 天内查看过的人选
   - `target_count`: 目标处理人数，如“10”；表示本轮需要处理多少位候选人，不表示必须有多少人通过
   - `keyword`: 搜索关键词，如“AI infra”“推荐系统”
7. 若返回 `NEED_INPUT`：
   - 不要只问一次就结束；
   - 要把缺失参数集中列出，请用户一次性补充；
   - 若用户补充后仍有缺失，再次单独列出剩余缺失项；
   - 若用户始终不补充，必须显式征求“是否接受默认值继续”的确认，不能直接默认执行。
8. 若返回 `NEED_CONFIRMATION`：
   - 询问用户是否确认 `proposed_keyword`；
   - 同时也要让用户确认其他已提取参数里是否有误；
   - 必须单独确认筛选 `criteria` 是否准确（尤其学历/学校/论文等硬性条件不能丢失）；
   - 若 `required_confirmations` 或 `pending_questions` 里包含 `filter_recent_viewed`，必须明确补问：是否需要过滤近 14 天查看过的人选；
   - 若确认，带 `confirmation.keyword_confirmed=true` 和 `keyword_value` 再次调用；
   - 若用户修改关键词，传用户给的新词作为 `keyword_value` 再次调用；
   - 对“是否过滤近 14 天查看”这个问题，需把用户选择写入 `overrides.filter_recent_viewed=true/false` 再次调用。
9. 当仍有缺失参数但用户想直接开始时：
   - 先明确告知默认值及风险；
   - 必须得到用户明确确认“可以按默认值继续”后，才能继续执行。
10. 只有在以下条件都满足后，才允许正式开始：
   - 用户已经确认已提取参数无误；
   - 用户已经明确确认 `criteria` 无误；
   - 缺失参数已补齐，或用户已明确接受默认值；
   - `NEED_CONFIRMATION` 分支中的关键词也已确认。
11. 若返回 `COMPLETED`：
   - 向用户返回摘要：目标处理人数、已处理、通过数、耗时、输出文件路径。
   - 只要状态是 `COMPLETED`，就视为本轮任务完成；
   - 不要因为 `passed_count < target_count` 就自动重跑；
   - `target_count` 的含义是“处理人数目标”，不是“通过人数目标”。
12. 若返回 `FAILED`：
   - 先提炼 `error.code`、`error.message`、`diagnostics`；
   - 如果是 `PIPELINE_PREFLIGHT_FAILED`，明确指出缺失的本地目录 / 文件；
   - 如果是 `BOSS_LOGIN_REQUIRED`，明确告诉用户“当前页面被跳转，疑似未登录/登录态失效”，并要求先登录再继续；
   - 如果是 `BOSS_SEARCH_PAGE_NOT_READY`，明确告诉用户先修复 Chrome 调试连接和 search 页面导航问题；
   - 如果是 `CALIBRATION_REQUIRED`，明确提醒用户执行校准，并给出校准步骤；
   - 如果是 `SEARCH_PROCESS_PERMISSION_DENIED` 或 `SCREEN_PROCESS_PERMISSION_DENIED`，明确说明“当前环境拒绝创建子进程”，建议用户在本地终端直接运行 MCP；
   - 如果是 `SEARCH_CLI_MISSING` / `SCREEN_CLI_MISSING` / `SCREEN_CONFIG_ERROR`，直接告诉用户缺什么，不要只说“重试”；
   - 若是可修复输入问题，提示用户修正条件后重试。

## Input Guidance

- 优先鼓励用户一次性给全这些字段：城市、学历、学校标签、目标人数、核心方向关键词。
- 当用户提到“做过 AI infra / 推荐系统 / 搜索 / 广告 / 多模态”等经历，但没有显式写“关键词”，默认允许流水线先自动抽取，再走确认分支。
- 当用户附带筛选要求（如“必须发表过 CCF-A 区论文”“有开源项目”“带过团队”），这些要求应该保留在 `criteria` 中，不应被误当作搜索过滤条件。
- 当用户明确给出“学历/学校”硬性条件（如“本科学历必须是985”），即使这些信息已被提取到搜索参数，`criteria` 里也必须保留原始约束，不可剔除。
- 若参数提取结果出现明显噪声、截断、短语串接、非标准枚举值，优先视为“识别不可靠”，要求用户确认，不要为了推进流程直接采用。
- 若用户输入 `qs50`、`qs200`、`qs500` 等任意 `QS数字` 学校标签，统一按 `<=100 -> qs100`、`>100 -> qs500` 处理；不要把原始 `QS200` 再传到底层搜索命令。
- 若用户没有明确提到“是否过滤近 14 天查看过的人选”，必须在参数确认阶段主动补问，不能静默默认开启或关闭。
- 若用户说“过滤近 14 天查看”“排除最近看过的”，映射为 `filter_recent_viewed=true`；若用户说“不过滤近 14 天查看”“保留最近看过的”，映射为 `filter_recent_viewed=false`。
- 不要把“用户没有继续回复”解释为“默认同意”；默认值只能在用户明确口头确认后使用。
- 参数确认对话里，优先采用这种结构：
  - 已识别参数
  - 待确认 / 待修正参数
  - 缺失参数
- 若继续默认执行会采用的默认值与风险
- 回答时不要暴露 `screening-config.json` 中的 `apiKey`、`baseUrl` 等敏感值。

## Standard Confirmation Template

- 发起参数确认时，优先复用统一结构，不要每次自由发挥。
- 首轮确认模板建议按下面顺序输出：
  - `已识别参数`
  - `待确认 / 待修正`
  - `缺失参数`
  - `默认值提醒（如果适用）`
  - `请用户回复`
- `已识别参数` 只放当前看起来可信的值，例如：
  - 城市：杭州
  - 学历：本科
  - 学校标签：统招本科 / 双一流院校 / 985 / 211 / QS100 / QS500（按实际需求选择）
  - 过滤近14天查看：需要 / 不需要
  - 关键词：AI infra
  - 目标人数：10
- `待确认 / 待修正` 要明确写出“识别值 -> 疑点 -> 需要用户给出的标准值”，例如：
  - 城市：当前识别为“杭州筛选做过”，这看起来混入了其他短语，请确认是否应为“杭州”
  - 关键词：当前识别为“AI infra 论文”，看起来混入了附加条件，请确认是否只保留“AI infra”
- `缺失参数` 要逐项列出，不要笼统说“还差一些信息”，例如：
  - 缺少城市
  - 缺少目标人数
- `默认值提醒` 只在仍有缺失项时出现，且必须同时包含三部分：
  - 还缺哪些参数
  - 若继续会使用哪些默认值
  - 会导致搜索范围变宽、相关性下降或结果偏差增大
- `请用户回复` 要求用户一次性回复完整，优先使用这种收口方式：
  - 请直接按“城市 / 学历 / 学校标签 / 是否过滤近14天查看 / 关键词 / 目标人数”补充或修正
  - 如果你接受默认值继续，请明确回复“确认按默认值继续”
- 若用户补充后仍有缺失，再发第二轮确认时继续复用同一结构，只保留：
  - 已更新的参数
  - 仍待确认项
  - 仍缺失项
  - 默认值风险
- 若用户明确表示“不想再补充，直接开始”，也不能跳过模板；要先发一版精简确认：
  - 当前仍缺失的参数
  - 将采用的默认值
  - 风险提示
  - 明确询问“请确认是否按默认值继续”
- 不要把下面这类表达当成有效确认：
  - “先这样吧”
  - “你看着办”
  - “差不多”
  - “随便”
- 只有当用户明确确认参数无误，且对默认值给出清晰同意后，才设置：
  - `confirmation.search_params_confirmed=true`
  - `confirmation.use_default_for_missing=true`（如适用）

## Failure Handling

- 不要把底层 stderr 原样大段贴给用户，只提炼关键错误和下一步。
- 如果失败原因明显是环境问题，要直接说明不是用户输入有误。
- 如果工具已经返回 `diagnostics.checks`，优先基于这些检查项生成排障建议。
- 如果工具返回 `output_csv`，在摘要里给出路径，避免重复解释内部流程。
- 如果端口还没确认，必须先问用户“是否使用推荐的 `9222`，还是你已经有别的远程调试端口”，不能直接把 `9222` 当成已确认值。
- 用户确认端口后，先执行一次 `boss-recruit-mcp set-port --port <port>`，让后续 `doctor / launch-chrome / calibrate / run` 自动复用同一端口。
- 如果需要打开 Chrome，优先帮用户执行而不是只给命令。
- 如果新打开的 Chrome 页面跳离了 search 页面，必须判断为“需要登录”，提示用户手动登录后再继续。

## Example

用户：

- “在 Boss 上找做过 AI infra 的候选人，必须发过 CCF-A 区论文，城市杭州，本科，学校 统招本科/双一流院校/985/211/QS100/QS500 中按需选择，目标 10 人”

期望行为：

1. 先询问用户是否使用推荐的 Chrome 调试端口 `9222`，或提供一个已有的其他端口。
2. 用户确认端口后，先执行 `boss-recruit-mcp set-port --port <port>` 固化端口。
3. 启动对应端口的调试 Chrome 并打开 Boss 搜索页面。
4. 先检查校准文件是否存在；若不存在，提醒用户按步骤完成校准。
5. 环境就绪后再首次调用流水线。
6. 若 keyword 被自动提取为 `AI infra`，先让用户确认。
7. 确认后再次调用。
8. 成功则返回通过人数与 CSV 路径；失败则按错误类型给出下一步。

## Response Style

- 优先结构化、简洁中文输出。
- 不展示密钥和底层敏感配置。
- 不跳过 `NEED_CONFIRMATION` 分支。
- 正式开始前，优先给用户一轮“参数确认卡片式摘要”。
- 参数确认阶段尽量复用统一模板，减少自由表述带来的漏项。
- 端口未确认时，用“推荐值 + 可选其他端口”的话术，不要直接替用户决定。
- 校准缺失时，直接指导用户重新校准，不要建议复制或复用任何历史 calibration 文件。
- 若当前 agent 受 MCP 数量限制，明确告诉用户“本轮改走 CLI fallback”，但用户体验上仍保持同一套确认和状态输出。
- 新开 Chrome 后若检测到跳转登录，先提示用户手动登录并等待确认，再继续。
- 若返回 `COMPLETED`，不要把“通过人数不足”理解成“任务未完成”；除非用户明确要求“必须找到 N 个通过人选”，否则不要自动追加新一轮搜索。
- 若要使用默认值，必须写明“请确认是否按默认值继续”，不能模糊带过。
- 若运行失败，优先给用户“现在卡在哪一步 + 怎么继续”。

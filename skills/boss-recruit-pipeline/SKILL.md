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

## Required MCP Tool

- Tool name: `run_recruit_pipeline`
- Input:
  - `instruction` (string, required)
  - `confirmation` (object, optional)
  - `overrides` (object, optional)

## Execution Policy

1. 收到招聘指令后，先调用一次 `run_recruit_pipeline`（只传 `instruction`）。
2. 若返回 `NEED_INPUT`：
   - 一次性向用户列出 `missing_fields` 所有缺失项；
   - 缺失项常见含义：
     - `city`: 城市，如“杭州”
     - `degree`: 学历，如“本科”“硕士及以上”
     - `schools`: 学校标签，如“985、211、qs100”
     - `target_count`: 目标筛选人数，如“10”
   - 用户补充后再次调用工具。
3. 若返回 `NEED_CONFIRMATION`：
   - 询问用户是否确认 `proposed_keyword`；
   - 若确认，带 `confirmation.keyword_confirmed=true` 和 `keyword_value` 再次调用；
   - 若用户修改关键词，传用户给的新词作为 `keyword_value` 再次调用。
4. 若返回 `COMPLETED`：
   - 向用户返回摘要：目标数、已处理、通过数、耗时、输出文件路径。
5. 若返回 `FAILED`：
   - 先提炼 `error.code`、`error.message`、`diagnostics`；
   - 如果是 `PIPELINE_PREFLIGHT_FAILED`，明确指出缺失的本地目录 / 文件；
   - 如果是 `SEARCH_PROCESS_PERMISSION_DENIED` 或 `SCREEN_PROCESS_PERMISSION_DENIED`，明确说明“当前环境拒绝创建子进程”，建议用户在本地终端直接运行 MCP；
   - 如果是 `SEARCH_CLI_MISSING` / `SCREEN_CLI_MISSING` / `SCREEN_CONFIG_ERROR`，直接告诉用户缺什么，不要只说“重试”；
   - 若是可修复输入问题，提示用户修正条件后重试。

## Input Guidance

- 优先鼓励用户一次性给全这些字段：城市、学历、学校标签、目标人数、核心方向关键词。
- 当用户提到“做过 AI infra / 推荐系统 / 搜索 / 广告 / 多模态”等经历，但没有显式写“关键词”，默认允许流水线先自动抽取，再走确认分支。
- 当用户附带筛选要求（如“必须发表过 CCF-A 区论文”“有开源项目”“带过团队”），这些要求应该保留在 `criteria` 中，不应被误当作搜索过滤条件。
- 回答时不要暴露 `screening-config.json` 中的 `apiKey`、`baseUrl` 等敏感值。

## Failure Handling

- 不要把底层 stderr 原样大段贴给用户，只提炼关键错误和下一步。
- 如果失败原因明显是环境问题，要直接说明不是用户输入有误。
- 如果工具已经返回 `diagnostics.checks`，优先基于这些检查项生成排障建议。
- 如果工具返回 `output_csv`，在摘要里给出路径，避免重复解释内部流程。

## Example

用户：

- “在 Boss 上找做过 AI infra 的候选人，必须发过 CCF-A 区论文，城市杭州，本科，学校 985/211/QS100，目标 10 人”

期望行为：

1. 首次调用流水线。
2. 若 keyword 被自动提取为 `AI infra`，先让用户确认。
3. 确认后再次调用。
4. 成功则返回通过人数与 CSV 路径；失败则按错误类型给出下一步。

## Response Style

- 优先结构化、简洁中文输出。
- 不展示密钥和底层敏感配置。
- 不跳过 `NEED_CONFIRMATION` 分支。
- 若运行失败，优先给用户“现在卡在哪一步 + 怎么继续”。

# @reconcrap/boss-recruit-mcp

统一招聘流水线 MCP（stdio）服务。将 `boss-search-cli` 与 `boss-screen-cli` 串联为单工具：

- 工具名：`run_recruit_pipeline`
- 状态：`NEED_INPUT` / `NEED_CONFIRMATION` / `COMPLETED` / `FAILED`

## 通过 npm / npx 安装

全局安装：

```bash
npm install -g @reconcrap/boss-recruit-mcp
boss-recruit-mcp install
```

一次性执行安装：

```bash
npx @reconcrap/boss-recruit-mcp install
```

安装命令会：

- 安装 Codex skill 到 `$CODEX_HOME/skills/boss-recruit-pipeline`
- 初始化用户配置到 `$CODEX_HOME/boss-recruit-mcp/screening-config.json`
- 生成通用 MCP 配置模板到 `$CODEX_HOME/boss-recruit-mcp/agent-mcp-configs`
- 包内自带 `boss-search-cli` 与 `boss-screen-cli` 运行时文件，无需额外目录结构
- 不包含 `favorite-calibration.json`，首次使用前需要自行校准生成

## 跨 Agent 快速接入（Cursor / Trae / Claude Code / OpenClaw）

生成 MCP 配置模板：

```bash
boss-recruit-mcp mcp-config --client all
```

默认会输出到：

```bash
$CODEX_HOME/boss-recruit-mcp/agent-mcp-configs
```

包含：

- `mcp.cursor.json`
- `mcp.trae.json`
- `mcp.claudecode.json`
- `mcp.openclaw.json`
- `mcp.generic.json`

把对应文件里的 `mcpServers` 合并到你的 AI 客户端 MCP 配置中即可。

如果你只需要某一个客户端模板：

```bash
boss-recruit-mcp mcp-config --client cursor
boss-recruit-mcp mcp-config --client claudecode
boss-recruit-mcp mcp-config --client trae
boss-recruit-mcp mcp-config --client openclaw
boss-recruit-mcp mcp-config --client generic
```

默认模板会使用：

- `command: npx`
- `args: ["-y", "@reconcrap/boss-recruit-mcp@latest", "start"]`

如果你希望改成本地全局命令：

```bash
boss-recruit-mcp mcp-config --client generic --command boss-recruit-mcp --args-json "[\"start\"]"
```

## 准备配置

1. 初始化后编辑用户配置文件：

```bash
$CODEX_HOME/boss-recruit-mcp/screening-config.json
```

2. 填写以下字段：

- `baseUrl` / `apiKey` / `model` 必填
- OpenAI 推荐：
  - `baseUrl`: `https://api.openai.com/v1`
  - `apiKey`: OpenAI API Key
  - `model`: 例如 `gpt-4.1-mini`
- 也支持通过环境变量注入：
  - `OPENAI_API_KEY`（可替代配置文件中的 `apiKey`）
  - `OPENAI_BASE_URL`（可替代配置文件中的 `baseUrl`）
  - `OPENAI_MODEL`（可替代配置文件中的 `model`）
  - `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID`（可选）
- 配置文件可选字段：
  - `openaiOrganization`
  - `openaiProject`
- `debugPort` 可选，默认 `9222`
  - 端口优先级：`--port > BOSS_RECRUIT_CHROME_PORT > screening-config.json.debugPort > 9222`
- `calibrationFile` 可选；不填时默认使用 `$CODEX_HOME/boss-recruit-mcp/favorite-calibration.json`
- `outputDir` 可选；不填时默认输出到用户桌面
- 学校标签支持 `统招本科` / `双一流院校` / `985` / `211` / `qs100` / `qs500`；如果输入 `qs50`、`qs200`、`qs500` 等其他 `QS数字`，会按 `<=100 -> qs100`、`>100 -> qs500` 归一

## 运行

```bash
boss-recruit-mcp start
```

该服务通过 stdio 与 MCP client 通信。

## CLI Fallback

如果当前 AI agent 无法添加新的 MCP、MCP 数量受限，或者只支持 shell/命令执行，也可以直接调用同一后端的 CLI fallback：

```bash
boss-recruit-mcp run --instruction "在 Boss 上找做过推荐系统的人，城市杭州，本科，学校 985/211/QS100，目标 10 人，过滤近14天查看过的人选"
```

也支持通过 JSON 传确认信息与覆盖参数：

```bash
boss-recruit-mcp run --instruction "在 Boss 上找做过推荐系统的人" --confirmation-json "{\"keyword_confirmed\":true,\"keyword_value\":\"推荐系统\",\"search_params_confirmed\":true}" --overrides-json "{\"city\":\"杭州\",\"degree\":\"本科\",\"schools\":[\"985\",\"211\",\"qs100\"],\"filter_recent_viewed\":true,\"target_count\":10}"
```

PowerShell 下更推荐用文件方式，避免引号转义导致 `INVALID_CLI_INPUT`：

```bash
boss-recruit-mcp run --instruction-file request.txt --confirmation-file confirmation.json --overrides-file overrides.json
```

如果命令行中放长文本不方便，改用文件：

```bash
boss-recruit-mcp run --instruction-file request.txt --confirmation-file confirmation.json --overrides-file overrides.json
```

`run` 的输出是 JSON，状态字段与 MCP 工具一致：`NEED_INPUT` / `NEED_CONFIRMATION` / `COMPLETED` / `FAILED`。
只要命令成功产出结构化结果，即使状态是 `FAILED` 也会继续输出 JSON，便于 AI agent 直接解析；只有 CLI 参数错误或未处理异常时才会返回非零退出码。

## Chrome 与校准

先确认你要使用的 Chrome 远程调试端口。推荐 `9222`，但如果你已经有一个正在运行的远程调试 Chrome，也可以继续使用那个端口。

建议先固化一次端口（后续命令自动沿用）：

```bash
boss-recruit-mcp set-port --port <port>
```

确认端口后，再执行下面的命令。

执行校准（会自动尝试打开 Boss 搜索页）：

```bash
boss-recruit-mcp calibrate --port <port>
```

如果你想自定义监听窗口（默认 60 秒）：

```bash
boss-recruit-mcp calibrate --port <port> --timeout-ms 60000
```

如果你的 `screening-config.json` 里配置了自定义 `calibrationFile` 路径，而该路径当前不存在，直接把校准结果输出到那个路径：

```bash
boss-recruit-mcp calibrate --port <port> --output <expected-calibration-path>
```

校准前请按这个顺序操作：

1. 打开 Boss 直聘搜索页
2. 随便打开一位人选的详情页
3. 点击收藏按钮
4. 再次点击，取消这位人选的收藏
5. 关闭详情页

校准文件默认生成到：

```bash
$CODEX_HOME/boss-recruit-mcp/favorite-calibration.json
```

不要从 npm 包目录、vendor 目录、旧工作区或其他账号目录复制 `favorite-calibration.json` 来替代当前环境的校准文件；应始终在当前环境重新生成。

也可以用下面的命令检查依赖、配置和校准文件：

```bash
boss-recruit-mcp doctor
# 或显式指定
boss-recruit-mcp doctor --port <port>
```

## 工具输入

```json
{
  "instruction": "自然语言招聘指令",
  "confirmation": {
    "keyword_confirmed": true,
    "keyword_value": "ai infra",
    "search_params_confirmed": true,
    "use_default_for_missing": false
  },
  "overrides": {
    "filter_recent_viewed": true,
    "target_count": 500
  }
}
```

## 行为说明

- 若缺 `city/degree/schools/keyword/target_count`，返回 `NEED_INPUT`
- 若 keyword 由语义自动抽取、搜索参数仍未被用户明确确认，或用户未说明是否过滤近 14 天查看过的人选，返回 `NEED_CONFIRMATION`
- 正式执行前应先单独做一轮参数确认，把已识别参数、待确认项、缺失项、默认值风险分开给用户确认
- 若用户没提“是否过滤近14天查看”，会在 `pending_questions` 里返回该问题，调用方应先补问再继续
- 用户未补齐缺失参数时，只有在明确同意默认值及其质量风险后，才允许继续
- `target_count` 表示“目标处理人数”，不是“目标通过人数”；会按“累计处理人数”自动多轮执行，直到达到目标处理人数，或新一轮搜索返回 0 个可筛选人选
- 若搜索页出现 `i.tip-nodata`（即使仍能看到候选人卡片），也会判定候选池已耗尽并结束多轮流程
- 第 2 轮及后续轮次会强制 `filter_recent_viewed=true`（即过滤近 14 天查看过的人选），不受首轮开关影响
- 确认后自动执行：搜索 CLI -> 点击搜索 -> 勾选“过滤近14天查看”（按轮次规则） -> 筛选 CLI
- 返回摘要：目标数、已处理、通过数、耗时、输出 CSV
- 执行前会先做本地依赖预检查，若目录 / 入口 / 配置文件缺失则返回 `PIPELINE_PREFLIGHT_FAILED`
- 若缺少 `favorite-calibration.json`，会返回 `CALIBRATION_REQUIRED`
- 若某轮搜索返回可筛选候选人但筛选 `processed_count` 非法或为 0，会先导出当前累计 CSV，再返回 `SCREEN_NO_PROGRESS`
- 若当前运行环境不允许启动子进程，会返回更明确的权限错误码而不是笼统失败
- 配置文件查找顺序：`BOSS_RECRUIT_SCREEN_CONFIG` > 工作区 `boss-recruit-mcp/config/screening-config.json` > 用户目录 `$CODEX_HOME/boss-recruit-mcp/screening-config.json` > 包内示例配置

## 终版测试方案

回归脚本位置：`scripts/regression.ps1`

1. 快速回归（不依赖 Boss 页面，验证 CLI 输入与状态机基础逻辑）：

```bash
npm run test:regression:win
```

2. 全链路回归（依赖 Chrome 调试端口 + 已登录 Boss）：

```bash
powershell -ExecutionPolicy Bypass -File scripts/regression.ps1 -Mode full -Port 9222
```

3. 负向回归（错误端口，确保不会误返回 `COMPLETED`）：

```bash
powershell -ExecutionPolicy Bypass -File scripts/regression.ps1 -Mode negative
```

判定标准：

- 不应出现 `INVALID_CLI_INPUT`
- 正常场景允许 `COMPLETED` 或可诊断的 `FAILED`
- 错误端口场景必须是 `FAILED`，且不是参数解析类错误

## 发布

```bash
npm publish
```

该包已设置 `publishConfig.access=public`。

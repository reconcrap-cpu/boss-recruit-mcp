# boss-recruit-pipeline skill

随 `boss-recruit-mcp` npm 包一起分发的 Codex skill。

## 安装

```powershell
npx @reconcrap/boss-recruit-mcp install
```

这条命令会：

- 把 skill 安装到 `$CODEX_HOME/skills/boss-recruit-pipeline`
- 在 `$CODEX_HOME/boss-recruit-mcp/screening-config.json` 创建配置模板
- 在 `$CODEX_HOME/boss-recruit-mcp/agent-mcp-configs` 生成 Cursor/Trae/Claude Code/OpenClaw 的 MCP 模板
- 默认把筛选结果输出到用户桌面

如果你只想导出 MCP 模板，可执行：

```powershell
boss-recruit-mcp mcp-config --client all
```

## 前置要求

- Chrome 需使用远程调试端口启动；推荐 `9222`，但也可以使用你已在运行的其他端口
- Boss 页面已登录
- 已在用户配置中填写有效的 `baseUrl`、`apiKey`、`model`
- 已生成 `$CODEX_HOME/boss-recruit-mcp/favorite-calibration.json`

## 运行注意事项

- 默认优先走 MCP；如果当前 agent 无法再添加 MCP，也可以改用 `boss-recruit-mcp run` 作为 CLI fallback。
- 正式开始前，必须先做一轮参数确认，分开展示已识别参数、待确认参数、缺失参数。
- 参数确认尽量复用统一模板：`已识别参数` / `待确认或待修正` / `缺失参数` / `默认值提醒` / `请用户回复`。
- 在正式执行前，必须单独让用户确认筛选 `criteria`（尤其学历/学校/论文等硬性条件）无误，不能只确认关键词和搜索参数。
- 端口未确认时，必须先询问用户是否使用推荐的 `9222`，或提供一个已有的其他远程调试端口，不能直接默认 `9222`。
- 用户确认端口后，先执行 `boss-recruit-mcp set-port --port <port>`，让后续 `doctor / launch-chrome / calibrate / run` 自动复用同一端口。
- 任何需要打开 Chrome 的动作前，先检查调试端口是否已有可用实例；端口可连时必须复用，不要再新开一个 9222 实例。
- 若页面未停留在 Boss search（例如跳到登录页或首页），必须提示用户先手动登录 Boss，再继续。
- 如果识别结果里出现明显脏值或可疑字段，例如“杭州筛选做过”，必须要求用户改成标准值后再继续。
- 学历/学校硬性条件不能在 criteria 清洗时被剔除；即使已提取到搜索参数，criteria 仍需保留原始约束语义（例如“本科学历必须是985”）。
- 如果缺少 `favorite-calibration.json`，必须指导用户在当前环境重新校准，不能搜索或复制历史遗留校准文件来顶替。
- 校准提示使用两阶段：先问“是否准备好开始校准”，不要问“是否已完成校准”；用户确认后应直接启动 `boss-recruit-mcp calibrate --port <port>`。
- 校准里的“打开详情 -> 收藏 -> 取消收藏 -> 关闭详情”属于动作说明，不要要求用户先手动完成这些步骤后再回复“可以校准”。
- 若缺失参数仍未补齐，只能在用户明确确认接受默认值和质量风险后继续，不能静默按默认执行。

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
- 端口未确认时，必须先询问用户是否使用推荐的 `9222`，或提供一个已有的其他远程调试端口，不能直接默认 `9222`。
- 新打开 Chrome 实例后，要检查页面是否仍停留在 Boss search；如果跳转到其他页面，必须提示用户先手动登录 Boss，再继续。
- 如果识别结果里出现明显脏值或可疑字段，例如“杭州筛选做过”，必须要求用户改成标准值后再继续。
- 如果缺少 `favorite-calibration.json`，必须指导用户在当前环境重新校准，不能搜索或复制历史遗留校准文件来顶替。
- 若缺失参数仍未补齐，只能在用户明确确认接受默认值和质量风险后继续，不能静默按默认执行。

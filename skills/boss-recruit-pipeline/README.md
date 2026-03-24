# boss-recruit-pipeline skill

随 `boss-recruit-mcp` npm 包一起分发的 Codex skill。

## 安装

```powershell
npx boss-recruit-mcp install
```

这条命令会：

- 把 skill 安装到 `$CODEX_HOME/skills/boss-recruit-pipeline`
- 在 `$CODEX_HOME/boss-recruit-mcp/screening-config.json` 创建配置模板

## 前置要求

- Chrome 已使用 `--remote-debugging-port=9222` 启动
- Boss 页面已登录
- 已在用户配置中填写有效的 `baseUrl`、`apiKey`、`model`

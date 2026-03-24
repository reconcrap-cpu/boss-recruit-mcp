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
- 包内自带 `boss-search-cli` 与 `boss-screen-cli` 运行时文件，无需额外目录结构

## 准备配置

1. 初始化后编辑用户配置文件：

```bash
$CODEX_HOME/boss-recruit-mcp/screening-config.json
```

2. 填写以下字段：

- `baseUrl` / `apiKey` / `model` 必填
- `calibrationFile` 可选，默认走 `boss-screen-cli/favorite-calibration.json`
- `outputDir` 可选，不填则输出到 `boss-screen-cli` 目录

## 运行

```bash
boss-recruit-mcp start
```

该服务通过 stdio 与 MCP client 通信。

## 工具输入

```json
{
  "instruction": "自然语言招聘指令",
  "confirmation": {
    "keyword_confirmed": true,
    "keyword_value": "ai infra"
  },
  "overrides": {
    "target_count": 500
  }
}
```

## 行为说明

- 若缺 `city/degree/schools/keyword/target_count`，返回 `NEED_INPUT`
- 若 keyword 由语义自动抽取（非显式给出），返回 `NEED_CONFIRMATION`
- 确认后自动执行：搜索 CLI -> 筛选 CLI
- 返回摘要：目标数、已处理、通过数、耗时、输出 CSV
- 执行前会先做本地依赖预检查，若目录 / 入口 / 配置文件缺失则返回 `PIPELINE_PREFLIGHT_FAILED`
- 若当前运行环境不允许启动子进程，会返回更明确的权限错误码而不是笼统失败
- 配置文件查找顺序：`BOSS_RECRUIT_SCREEN_CONFIG` > 工作区 `boss-recruit-mcp/config/screening-config.json` > 用户目录 `$CODEX_HOME/boss-recruit-mcp/screening-config.json` > 包内示例配置

## 发布

```bash
npm publish
```

该包已设置 `publishConfig.access=public`。

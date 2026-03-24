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
- 不包含 `favorite-calibration.json`，首次使用前需要自行校准生成

## 准备配置

1. 初始化后编辑用户配置文件：

```bash
$CODEX_HOME/boss-recruit-mcp/screening-config.json
```

2. 填写以下字段：

- `baseUrl` / `apiKey` / `model` 必填
- `debugPort` 可选，默认 `9222`
- `calibrationFile` 可选；不填时默认使用 `$CODEX_HOME/boss-recruit-mcp/favorite-calibration.json`
- `outputDir` 可选；不填时默认输出到用户桌面

## 运行

```bash
boss-recruit-mcp start
```

该服务通过 stdio 与 MCP client 通信。

## Chrome 与校准

先确认你要使用的 Chrome 远程调试端口。推荐 `9222`，但如果你已经有一个正在运行的远程调试 Chrome，也可以继续使用那个端口。确认端口后，再执行下面的命令。

推荐先启动调试 Chrome：

```bash
boss-recruit-mcp launch-chrome --port <port>
```

然后执行校准：

```bash
boss-recruit-mcp calibrate --port <port>
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
    "target_count": 500
  }
}
```

## 行为说明

- 若缺 `city/degree/schools/keyword/target_count`，返回 `NEED_INPUT`
- 若 keyword 由语义自动抽取、或搜索参数仍未被用户明确确认，返回 `NEED_CONFIRMATION`
- 正式执行前应先单独做一轮参数确认，把已识别参数、待确认项、缺失项、默认值风险分开给用户确认
- 用户未补齐缺失参数时，只有在明确同意默认值及其质量风险后，才允许继续
- 确认后自动执行：搜索 CLI -> 筛选 CLI
- 返回摘要：目标数、已处理、通过数、耗时、输出 CSV
- 执行前会先做本地依赖预检查，若目录 / 入口 / 配置文件缺失则返回 `PIPELINE_PREFLIGHT_FAILED`
- 若缺少 `favorite-calibration.json`，会返回 `CALIBRATION_REQUIRED`
- 若当前运行环境不允许启动子进程，会返回更明确的权限错误码而不是笼统失败
- 配置文件查找顺序：`BOSS_RECRUIT_SCREEN_CONFIG` > 工作区 `boss-recruit-mcp/config/screening-config.json` > 用户目录 `$CODEX_HOME/boss-recruit-mcp/screening-config.json` > 包内示例配置

## 发布

```bash
npm publish
```

该包已设置 `publishConfig.access=public`。

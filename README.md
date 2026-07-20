# Mac Worklog → 飞书

一个只在本机运行的 macOS 工作留痕工具。它在工作时间采集前台应用、终端命令以及 Claude Code / Codex 的结构化执行记录，调用可配置的 LLM 整理成日报，并通过飞书 CLI 以用户身份写入飞书知识库。

## 能做什么

- 工作日 08:00–18:00 采集有效操作，不记录键盘输入、剪贴板、截图或浏览器正文。
- 工作日 18:00 生成并覆盖当天日报。
- 周一 08:00 汇总上周工作日，生成周报。
- 每月 1 日 08:10 汇总上月工作日，生成月报。
- 按“月 → 周 → 日报”组织飞书知识库。
- 前端查看配置状态、最近执行结果并手动生成日报。
- LLM API Key 保存在 macOS Keychain；活动记录和文档索引保存在本机 `data/`。
- 使用 LaunchAgent 登录自启并在异常退出后自动恢复。

## 为什么使用飞书 CLI

项目不再保存飞书机器人 App ID / App Secret，也不自行维护 tenant token。飞书文档和知识库操作统一使用官方 `lark-cli --as user`：

- 文档归属和权限符合当前登录用户；
- 用户认证、token 刷新和权限错误由 CLI 统一处理；
- 文档覆盖使用 CLI 的 Markdown 导入能力，自动转换成飞书原生标题、段落和列表块。

官方安装说明：[飞书 CLI 安装指南](https://open.feishu.cn/document/no_class/mcp-archive/feishu-cli-installation-guide.md)。

## 环境要求

- macOS
- Node.js 20+
- 飞书 CLI

```bash
npm install -g @larksuite/cli
npx -y skills add https://open.feishu.cn --skill -y
lark-cli config init --new
lark-cli auth login --recommend
lark-cli auth status --json --verify
```

文档和知识库操作必须使用已授权的 `user` 身份，而不是 `bot` 身份。

## 安装与初始化

```bash
git clone <repository-url>
cd mac-worklog-feishu
npm install
npm start
```

打开 [http://127.0.0.1:4318](http://127.0.0.1:4318)，依次确认：

1. 飞书 CLI 显示已连接到正确的用户；
2. 填写 LLM 协议、API 地址、模型和 API Key；
3. 粘贴目标飞书知识库父页面链接并绑定；
4. 保存配置，点击“立即生成今天日报”完成首次验证。

可以运行诊断命令检查安装状态：

```bash
npm run doctor
```

## 保持后台运行

```bash
npm run install-service
```

该命令安装 `~/Library/LaunchAgents/com.local.mac-worklog-feishu.plist`。服务仅监听 `127.0.0.1:4318`，不会对局域网或互联网开放管理界面。

## 数据与隐私

以下内容不会提交到 Git：

- `data/settings.json`：本机配置；
- `data/operations/`：前台应用采样和终端命令；
- `data/evidence/`：结构化证据与校验清单；
- `data/reports/`：生成后的本地报告副本；
- `data/published.json`、`data/wiki-index.json`：飞书文档和目录索引；
- LLM API Key：仅存储于 macOS Keychain。

操作记录会发送到你配置的 LLM 服务用于生成报告。请根据所用服务商的数据政策决定是否启用，以及是否需要进一步脱敏。

## 项目结构

```text
src/
  agentLogs.ts   Claude Code / Codex 执行日志解析
  collector.ts   工作时间窗过滤与证据聚合
  larkCli.ts     飞书 CLI 调用、认证状态和错误处理
  feishu.ts      知识库层级与文档发布
  llm.ts         日报、周报和月报生成
  sampler.ts     macOS 前台应用采样
  server.ts      本地 API、定时任务和前端服务
public/          本地配置与运行历史页面
scripts/         自检、终端采集和 LaunchAgent 安装
```

## 常见问题

### 飞书 CLI 显示需要刷新

先运行：

```bash
lark-cli auth status --json --verify
```

CLI 会在下一次用户 API 调用时自动刷新仍有效的登录态。如果授权已失效，重新执行 `lark-cli auth login --recommend`。

### 关闭终端后服务停止

执行 `npm run install-service`，再运行 `launchctl print gui/$(id -u)/com.local.mac-worklog-feishu` 检查服务状态。

### 为什么报告没有记录下班后的操作

这是预期行为。日报和原始证据只纳入工作日 08:00–18:00 的活动。

## 开发

```bash
npm run dev
npm run check
node --check public/app.js
```

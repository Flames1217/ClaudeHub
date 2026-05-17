# Claude Cockpit

Claude Cockpit 是一个 Claude 多账号聚合桌面应用。它把多个 `claude.ai` 账号当作可调度的额度池，用户只需要在一个桌面聊天窗口里对话；当某个账号额度不足或进入冷却，应用会把本地会话上下文交给其他可用账号接力。

本仓库从原来的 Claude Switcher 浏览器扩展演进而来，仍保留扩展源码，同时新增 Electron 桌面端。

## 当前状态

桌面端已经具备 MVP 能力：

- 统一聊天界面：对话历史保存在本地应用数据目录，不依赖 Claude 官方 conversation id。
- 多账号导入：支持导入现有 `claude_accounts*.json` 账号备份。
- 账号池路由：按禁用状态、登录态、冷却状态、已知用量和最近使用时间选择账号。
- 跨账号续聊：自动生成 handoff prompt，将摘要和最近消息传给接力账号。
- 独立账号窗口：每个账号使用独立 Electron session partition，减少 cookie 串号。
- 账号刷新：可刷新账号基础信息和用量快照，并记录刷新错误。
- 安全默认值：默认只展示路由和续聊提示预览，真实 Claude Web 自动发送需要显式开启。

## 下载与运行

Release 会提供两种 Windows 版本：

- `Claude Cockpit-0.1.0-portable.exe`：便携版，下载后直接运行。
- `Claude Cockpit Setup 0.1.0.exe`：安装版，支持桌面快捷方式和开始菜单。

本地开发运行：

```powershell
npm install
npm run desktop
```

打包：

```powershell
npm run dist
```

构建产物会输出到 `release/`。

## 使用方式

1. 启动桌面端。
2. 点击左侧「导入」，选择从扩展导出的 `claude_accounts*.json`。
3. 在主聊天区输入消息。
4. 顶部可选择「自动选择账号」，也可指定某个账号。
5. 账号池中可以刷新账号、设为默认、禁用/启用账号，或打开独立 Claude 账号窗口。

## Web 自动执行

默认模式不会自动操作 Claude 页面，只会展示路由结果和续聊提示预览。这是为了避免在页面选择器未校准、Cloudflare 校验未通过或登录态异常时误操作。

如需尝试真实 Claude Web 自动执行：

```powershell
$env:CLAUDE_COCKPIT_ENABLE_WEB_AUTOMATION='1'
npm run desktop
```

调试开关：

- `$env:CLAUDE_COCKPIT_SHOW_AUTOMATION='0'`：隐藏自动执行窗口。
- `$env:CLAUDE_COCKPIT_KEEP_WINDOWS='1'`：保留自动执行窗口，便于排查登录、Cloudflare 或选择器问题。

## 浏览器扩展

旧版 Claude Switcher 扩展仍可使用：

- `manifest.json`：MV3 扩展配置。
- `background.js`：账号存储、Cookie 切换、消息路由。
- `content.js`：页面内 fetch 代理与限流提示检测。
- `popup.html` / `popup.js`：轻量切换弹窗。
- `dashboard.html` / `dashboard.js`：账号管理面板。

开发者模式安装：

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本项目目录。

## 项目结构

- `desktop/`：Electron 桌面端。
- `desktop/ARCHITECTURE.md`：桌面端架构说明。
- `background.js` / `content.js` / `popup.*` / `dashboard.*`：浏览器扩展源码。
- `icons/` / `images/`：图标和旧版扩展截图。

## 开发检查

```powershell
npm run check
```

## 安全说明

- `claude_accounts*.json` 含有敏感会话数据，请私密保存。
- 不要把真实账号备份提交到 git。
- 打包配置已显式排除 `claude_accounts*.json`、`*.local.json`、`*.tmp` 和 `*.bak`。
- 本项目为独立工具，与 Anthropic 无官方关联，也未获得其背书。

## 许可证

MIT

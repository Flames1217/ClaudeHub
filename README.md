# ClaudeHub

ClaudeHub 是一个 Claude 多账号聚合工具，包含 Electron 桌面端和 Chrome / Edge 浏览器扩展。它把多个 `claude.ai` 账号作为本地账号池，支持统一会话、账号导入、额度状态查看、账号路由和快速切换。

本项目从早期浏览器扩展演进而来，当前仓库同时保留桌面端与扩展源码。

## 当前状态

桌面端已经具备 MVP 能力：

- 统一聊天界面：对话历史保存在本地应用数据目录，不依赖 Claude 官方 conversation id。
- 多账号导入：支持导入现有 `claude_accounts*.json` 账号备份。
- 账号池路由：按禁用状态、登录态、冷却状态、已知用量和最近使用时间选择账号。
- 跨账号续聊：自动生成 handoff prompt，将摘要和最近消息交给接力账号。
- 独立账号窗口：每个账号使用独立 Electron session partition，减少 Cookie 串号。
- 账号刷新：可刷新账号基础信息和用量快照，并记录刷新错误。
- 安全默认值：默认只展示路由和续聊提示预览，真实 Claude Web 自动发送需要显式开启。

浏览器扩展提供轻量账号管理能力：

- 多账号本地管理，数据存储在 `chrome.storage.local`。
- 通过恢复 `sessionKey` 与相关 Cookie 快速切换账号。
- 弹窗内查看账号、套餐、状态并一键切换。
- 管理面板支持添加、删除、导入、导出和调试。
- 基于接口与页面信息展示用量、限流和冷却状态。

## 截图预览

<img src="images/big.png">
<img src="images/adduser.png">
<img src="images/settings.png">

<p align="center">
  <img src="images/small.png" width="46%"/>
  <img src="images/90.png" width="48%"/>
</p>

## 下载与运行

Release 会提供两种 Windows 版本：

- `ClaudeHub-0.3.4-portable.exe`：便携版，下载后直接运行。
- `ClaudeHub Setup 0.3.4.exe`：安装版，支持桌面快捷方式和开始菜单。

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

## Web 自动执行

默认模式不会自动操作 Claude 页面，只会展示路由结果和续聊提示预览。这是为了避免在页面选择器未校准、Cloudflare 校验未通过或登录态异常时误操作。

如需尝试真实 Claude Web 自动执行：

```powershell
$env:CLAUDEHUB_ENABLE_WEB_AUTOMATION='1'
npm run desktop
```

调试开关：

- `$env:CLAUDEHUB_SHOW_AUTOMATION='0'`：隐藏自动执行窗口。
- `$env:CLAUDEHUB_KEEP_WINDOWS='1'`：保留自动执行窗口，便于排查登录、Cloudflare 或选择器问题。

## 浏览器扩展安装

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录。

## 项目结构

- `desktop/`：Electron 桌面端。
- `desktop/ARCHITECTURE.md`：桌面端架构说明。
- `manifest.json`：MV3 扩展配置。
- `background.js`：账号存储、Cookie 切换和消息路由。
- `content.js`：页面内请求代理与会话信息采集。
- `popup.html` / `popup.js`：扩展弹窗界面。
- `dashboard.html` / `dashboard.js`：完整管理面板。
- `icons/` / `images/`：图标和扩展截图素材。

## 开发检查

```powershell
npm run check
```

## 安全说明

- `claude_accounts*.json` 含有敏感会话数据，请私密保存。
- 不要把真实账号备份提交到 Git。
- 打包配置已显式排除 `claude_accounts*.json`、`*.local.json`、`*.tmp` 和 `*.bak`。
- 本项目为独立工具，与 Anthropic 无官方关联，也未获得其背书。

## 许可证

MIT

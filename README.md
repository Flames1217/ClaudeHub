# ClaudeHub

ClaudeHub 是一款用于 `claude.ai` 的 Chrome / Edge 浏览器插件，专注于多账号管理、无缝切换和对话续接。它会在本地保存账号会话信息，切换账号时自动恢复相关 Cookie，并可在切换前抓取当前对话上下文，让新账号继续接着回答。

## 核心功能

- 多账号本地管理：账号数据保存在 `chrome.storage.local`。
- 无缝账号切换：恢复 `sessionKey` 与相关 Cookie 后跳转到 Claude 新对话页。
- 对话续接：切换前快照当前 Claude 对话，切换后自动注入续接提示。
- 弹窗快速操作：查看账号、套餐、状态，并支持一键切换或续接。
- 管理面板：支持添加、删除、导入、导出、刷新账号和调试接口。
- 用量状态查看：基于接口与页面信息展示用量、限流和冷却状态。

## 截图预览

<img src="images/big.png">
<img src="images/adduser.png">
<img src="images/settings.png">

<p align="center">
  <img src="images/small.png" width="46%"/>
  <img src="images/90.png" width="48%"/>
</p>

## 安装方式

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 启用“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录。

## 使用方式

1. 先在浏览器中登录一个 Claude 账号。
2. 打开 ClaudeHub 弹窗或管理面板，添加当前账号。
3. 重复登录和添加流程，将多个账号保存到本地账号池。
4. 在弹窗中点击“切换”可直接切到目标账号。
5. 在已有对话页面点击“续接”，插件会先保存当前上下文，再切换账号并注入续接提示。

## 项目结构

- `manifest.json`：Manifest V3 插件配置。
- `background.js`：后台逻辑，负责账号存储、Cookie 切换、消息路由和自动刷新。
- `content.js`：运行在 `claude.ai` 页面内，负责接口代理、对话快照和续接注入。
- `popup.html` / `popup.js`：插件弹窗，用于快速切换和续接。
- `dashboard.html` / `dashboard.js`：完整账号管理面板。
- `icons/`：插件图标。
- `images/`：README 截图素材。
- `claude_accounts.sample.json`：账号数据示例。

## 本地开发

本项目无需构建步骤，修改源码后在浏览器扩展页面重新加载即可。

可使用以下命令进行快速语法检查：

```powershell
node --check background.js
node --check content.js
node --check popup.js
node --check dashboard.js
```

## 安全说明

- 账号导出的 JSON 文件包含敏感会话数据，请私密保存。
- 不要把真实账号备份文件提交到 Git。
- 仓库默认忽略 `claude_accounts*.json`，仅保留 `claude_accounts.sample.json` 作为可共享示例。
- ClaudeHub 是独立工具，与 Anthropic 无官方关联，也未获得其背书。

## 许可证

MIT

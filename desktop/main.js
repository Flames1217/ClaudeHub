const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { createStore } = require('./store');
const { routeAccount, buildHandoffPrompt } = require('./account-router');
const { sendWithAccount, openAccountWindow, refreshAccountSnapshot } = require('./claude-executor');

let mainWindow;
let store;
let refreshTimer = null;
let updateInfo = null;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: 'Claude Cockpit',
    backgroundColor: '#f6f3ee',
    webPreferences: {
      preload: `${__dirname}/preload.js`,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(`${__dirname}/index.html`);
}

function ensureConversation(state) {
  if (state.activeConversationId && state.conversations.some((item) => item.id === state.activeConversationId)) {
    return state.activeConversationId;
  }
  return store.createConversation().conversation.id;
}

function sendUpdateEvent(type, payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('app:update-event', { type, ...payload });
}

app.whenReady().then(() => {
  store = createStore(app.getPath('userData'));
  createWindow();
  startAccountRefreshScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:get-state', async () => store.read());

ipcMain.handle('app:new-conversation', async () => store.createConversation().state);

ipcMain.handle('app:set-active-conversation', async (_event, conversationId) => {
  return store.setActiveConversation(conversationId);
});

ipcMain.handle('app:import-accounts', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入 Claude 账号',
    filters: [
      { name: '账号文件', extensions: ['json', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || !result.filePaths.length) return store.read();

  const accounts = [];
  for (const filePath of result.filePaths) {
    const raw = fs.readFileSync(filePath, 'utf8');
    accounts.push(...parseAccountImport(raw, path.basename(filePath)));
  }
  return store.importAccounts(accounts);
});

ipcMain.handle('app:import-accounts-from-text', async (_event, raw) => {
  const accounts = parseAccountImport(String(raw || ''), '粘贴内容');
  return store.importAccounts(accounts);
});

ipcMain.handle('app:import-current-store', async () => {
  if (!fs.existsSync(store.filePath)) return store.read();
  const raw = fs.readFileSync(store.filePath, 'utf8');
  const accounts = parseAccountImport(raw, '当前数据文件');
  return store.importAccounts(accounts);
});

ipcMain.handle('app:update-account', async (_event, accountId, patch) => {
  return store.updateAccount(accountId, patch);
});

ipcMain.handle('app:set-current-account', async (_event, accountId) => {
  return store.setCurrentAccount(accountId || null);
});

ipcMain.handle('app:refresh-accounts', async () => refreshAllAccounts());

ipcMain.handle('app:open-account', async (_event, accountId) => {
  const account = store.listAccounts().find((item) => item.id === accountId);
  if (!account) return false;
  return openAccountWindow(account);
});

ipcMain.handle('app:open-store-file', async () => {
  await shell.showItemInFolder(store.filePath);
  return true;
});

ipcMain.handle('app:check-update', async () => {
  if (!app.isPackaged) {
    return {
      status: 'dev',
      currentVersion: app.getVersion(),
      message: '开发模式不会执行安装更新；打包版本会从 GitHub Releases 检查。'
    };
  }
  const result = await autoUpdater.checkForUpdates();
  updateInfo = result?.updateInfo || null;
  return {
    status: updateInfo ? 'available' : 'none',
    currentVersion: app.getVersion(),
    updateInfo
  };
});

ipcMain.handle('app:download-update', async () => {
  if (!app.isPackaged) throw new Error('开发模式不能下载更新');
  if (!updateInfo) await autoUpdater.checkForUpdates();
  await autoUpdater.downloadUpdate();
  return true;
});

ipcMain.handle('app:install-update', async () => {
  autoUpdater.quitAndInstall(false, true);
  return true;
});

ipcMain.handle('chat:send', async (_event, payload) => {
  const state = store.read();
  const conversationId = payload.conversationId || ensureConversation(state);
  const freshConversation = store.getConversation(conversationId) || store.createConversation().conversation;
  const text = String(payload.content || '').trim();
  if (!text) return store.read();

  store.appendMessage(conversationId, {
    role: 'user',
    content: text
  });

  const afterUser = store.read();
  const conversation = afterUser.conversations.find((item) => item.id === conversationId);
  const route = routeAccount(afterUser.accounts, payload.accountId, afterUser.currentAccountId);
  const handoffPrompt = buildHandoffPrompt(conversation, text, afterUser.settings);
  const result = await sendWithAccount({ account: route.account, prompt: handoffPrompt });

  if (route.account) {
    store.updateAccount(route.account.id, { lastUsed: Date.now() });
    store.setCurrentAccount(route.account.id);
  }

  store.appendMessage(conversationId, {
    role: 'assistant',
    content: result.ok ? result.content : result.error,
    accountId: route.account?.id || null,
    accountEmail: route.account?.email || route.account?.nickname || '',
    routeReason: route.reason,
    status: result.ok ? 'ok' : 'error',
    executorMode: result.mode || 'none'
  });

  if (!freshConversation.summary && conversation.messages.length >= 8) {
    store.updateConversation(conversationId, {
      summary: conversation.messages
        .slice(-8)
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n')
        .slice(0, afterUser.settings.summaryMaxChars)
    });
  }

  return store.read();
});

async function refreshAllAccounts() {
  const state = store.read();
  const nextAccounts = [];
  for (const account of state.accounts) {
    if (account.disabled || !account.sessionKey) {
      nextAccounts.push(account);
      continue;
    }
    const patch = await refreshAccountSnapshot(account);
    nextAccounts.push({ ...account, ...patch });
  }
  return store.replaceAccounts(nextAccounts);
}

function startAccountRefreshScheduler() {
  const intervalMs = store.read().settings.autoRefreshIntervalMs;
  if (!intervalMs || intervalMs < 60_000) return;
  refreshTimer = setInterval(() => {
    refreshAllAccounts().catch((error) => {
      console.warn('[refresh] account refresh failed:', error);
    });
  }, intervalMs);
}

autoUpdater.on('checking-for-update', () => sendUpdateEvent('checking'));
autoUpdater.on('update-available', (info) => {
  updateInfo = info;
  sendUpdateEvent('available', { info });
});
autoUpdater.on('update-not-available', (info) => sendUpdateEvent('not-available', { info }));
autoUpdater.on('download-progress', (progress) => sendUpdateEvent('progress', { progress }));
autoUpdater.on('update-downloaded', (info) => sendUpdateEvent('downloaded', { info }));
autoUpdater.on('error', (error) => sendUpdateEvent('error', { message: error.message || String(error) }));

function parseAccountImport(raw, sourceName = '导入内容') {
  const text = String(raw || '').trim();
  if (!text) throw new Error(`${sourceName} 是空的`);

  const parsed = tryParseJson(text);
  if (parsed !== null) {
    const accounts = extractAccountsFromJson(parsed);
    if (accounts.length) return accounts;
  }

  const tokenAccounts = extractAccountsFromText(text);
  if (tokenAccounts.length) return tokenAccounts;

  throw new Error(`${sourceName} 中没有找到可导入的账号、cookie 或 sessionKey`);
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractAccountsFromJson(value) {
  const roots = [];
  if (Array.isArray(value)) roots.push(...value);
  else if (Array.isArray(value?.accounts)) roots.push(...value.accounts);
  else if (Array.isArray(value?.data)) roots.push(...value.data);
  else if (value && typeof value === 'object') roots.push(value);

  const accounts = [];
  for (const item of roots) {
    if (!item || typeof item !== 'object') continue;
    const sessionKey = normalizeSessionKey(
      item.sessionKey ||
      item.session_key ||
      item.session ||
      item.token?.sessionKey ||
      item.token?.session_key ||
      findCookieValue(item.cookies, 'sessionKey')
    );
    const cookies = normalizeCookies(item.cookies, sessionKey);
    if (!sessionKey && !cookies.length) continue;
    accounts.push({
      ...item,
      sessionKey: sessionKey || findCookieValue(cookies, 'sessionKey'),
      cookies,
      email: item.email || item.account || item.user?.email || '',
      nickname: item.nickname || item.name || item.label || '',
      plan: item.plan || item.tier || 'Unknown'
    });
  }
  return accounts;
}

function extractAccountsFromText(text) {
  const accounts = [];
  const seen = new Set();
  const cookieLines = text.split(/\r?\n/).filter((line) => line.includes('sessionKey'));
  for (const line of cookieLines) {
    const value = normalizeSessionKey(line);
    if (value && !seen.has(value)) {
      seen.add(value);
      accounts.push(buildSessionKeyAccount(value));
    }
  }
  const tokenMatches = text.matchAll(/sk-ant-sid01-[A-Za-z0-9_-]+(?:%3D%3D|==)?/gi);
  for (const match of tokenMatches) {
    const value = normalizeSessionKey(match[0]);
    if (value && !seen.has(value)) {
      seen.add(value);
      accounts.push(buildSessionKeyAccount(value));
    }
  }
  return accounts;
}

function normalizeCookies(cookies, sessionKey) {
  const list = Array.isArray(cookies) ? cookies : [];
  const normalized = list
    .filter((cookie) => cookie && typeof cookie === 'object' && cookie.name && cookie.value)
    .map((cookie) => ({
      domain: cookie.domain || '.claude.ai',
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: cookie.httpOnly !== false,
      sameSite: cookie.sameSite || 'lax',
      ...cookie
    }));
  if (sessionKey && !normalized.some((cookie) => cookie.name === 'sessionKey')) {
    normalized.push(buildSessionCookie(sessionKey));
  }
  return normalized;
}

function findCookieValue(cookies, name) {
  if (!Array.isArray(cookies)) return '';
  return cookies.find((cookie) => cookie?.name === name)?.value || '';
}

function normalizeSessionKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const direct = text.match(/sessionKey\s*[=:]\s*([^;\s]+)/i);
  const cookie = text.match(/(?:^|[;\s])sessionKey=([^;\s]+)/i);
  const token = text.match(/sk-ant-sid01-[A-Za-z0-9_-]+(?:%3D%3D|==)?/i);
  return decodeURIComponent((direct?.[1] || cookie?.[1] || token?.[0] || '').trim());
}

function buildSessionKeyAccount(sessionKey) {
  return {
    sessionKey,
    cookies: [buildSessionCookie(sessionKey)],
    plan: 'Unknown',
    status: 'ready'
  };
}

function buildSessionCookie(sessionKey) {
  return {
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax'
  };
}

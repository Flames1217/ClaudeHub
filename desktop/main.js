const fs = require('node:fs');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { createStore } = require('./store');
const { routeAccount, buildHandoffPrompt } = require('./account-router');
const { sendWithAccount, openAccountWindow, refreshAccountSnapshot } = require('./claude-executor');

let mainWindow;
let store;
let refreshTimer = null;

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
    title: '导入 Claude 账号 JSON',
    filters: [{ name: 'Claude accounts', extensions: ['json'] }],
    properties: ['openFile']
  });

  if (result.canceled || !result.filePaths[0]) return store.read();

  const raw = fs.readFileSync(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(raw);
  const accounts = Array.isArray(parsed) ? parsed : parsed.accounts;
  if (!Array.isArray(accounts)) throw new Error('导入文件不是账号数组');
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

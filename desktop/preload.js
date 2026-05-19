const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudeHub', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  newConversation: () => ipcRenderer.invoke('app:new-conversation'),
  setActiveConversation: (conversationId) => ipcRenderer.invoke('app:set-active-conversation', conversationId),
  importAccounts: () => ipcRenderer.invoke('app:import-accounts'),
  importAccountsFromText: (raw) => ipcRenderer.invoke('app:import-accounts-from-text', raw),
  importCurrentStore: () => ipcRenderer.invoke('app:import-current-store'),
  updateAccount: (accountId, patch) => ipcRenderer.invoke('app:update-account', accountId, patch),
  setCurrentAccount: (accountId) => ipcRenderer.invoke('app:set-current-account', accountId),
  refreshAccounts: () => ipcRenderer.invoke('app:refresh-accounts'),
  openAccount: (accountId) => ipcRenderer.invoke('app:open-account', accountId),
  openStoreFile: () => ipcRenderer.invoke('app:open-store-file'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  downloadUpdate: () => ipcRenderer.invoke('app:download-update'),
  installUpdate: () => ipcRenderer.invoke('app:install-update'),
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-event', listener);
    return () => ipcRenderer.removeListener('app:update-event', listener);
  },
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload)
});

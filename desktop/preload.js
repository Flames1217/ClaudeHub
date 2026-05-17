const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cockpit', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  newConversation: () => ipcRenderer.invoke('app:new-conversation'),
  setActiveConversation: (conversationId) => ipcRenderer.invoke('app:set-active-conversation', conversationId),
  importAccounts: () => ipcRenderer.invoke('app:import-accounts'),
  updateAccount: (accountId, patch) => ipcRenderer.invoke('app:update-account', accountId, patch),
  setCurrentAccount: (accountId) => ipcRenderer.invoke('app:set-current-account', accountId),
  refreshAccounts: () => ipcRenderer.invoke('app:refresh-accounts'),
  openAccount: (accountId) => ipcRenderer.invoke('app:open-account', accountId),
  openStoreFile: () => ipcRenderer.invoke('app:open-store-file'),
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload)
});

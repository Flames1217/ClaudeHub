const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EMPTY_STATE = {
  version: 1,
  accounts: [],
  conversations: [],
  activeConversationId: null,
  currentAccountId: null,
  settings: {
    contextMessageLimit: 12,
    summaryMaxChars: 1800,
    autoRoute: true,
    autoRefreshIntervalMs: 5 * 60 * 1000
  }
};

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function createStore(userDataPath) {
  const filePath = path.join(userDataPath, 'cockpit-store.json');

  function read() {
    try {
      if (!fs.existsSync(filePath)) return structuredClone(EMPTY_STATE);
      const raw = fs.readFileSync(filePath, 'utf8');
      return { ...structuredClone(EMPTY_STATE), ...JSON.parse(raw) };
    } catch (error) {
      console.error('[store] read failed:', error);
      return structuredClone(EMPTY_STATE);
    }
  }

  function write(nextState) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(nextState, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
    return nextState;
  }

  function update(mutator) {
    const state = read();
    const result = mutator(state) || state;
    return write(result);
  }

  function normalizeAccount(account) {
    const sessionKey = account.sessionKey || account.cookies?.find((cookie) => cookie.name === 'sessionKey')?.value;
    return {
      id: account.id || createId('acc'),
      sessionKey,
      cookies: account.cookies || null,
      email: account.email || '',
      name: account.name || '',
      nickname: account.nickname || '',
      plan: account.plan || 'Unknown',
      userId: account.userId || '',
      valid: account.valid !== false,
      disabled: !!account.disabled,
      disabledReason: account.disabledReason || account.disabled_reason || '',
      disabledAt: account.disabledAt || account.disabled_at || null,
      tags: Array.isArray(account.tags) ? account.tags : [],
      notes: account.notes || '',
      usage: account.usage || null,
      usageUpdatedAt: account.usageUpdatedAt || account.usage_updated_at || null,
      quotaError: account.quotaError || account.quota_error || null,
      status: account.status || 'ready',
      addedAt: account.addedAt || Date.now(),
      lastUsed: account.lastUsed || 0,
      refreshedAt: account.refreshedAt || 0,
      sessionBanner: account.sessionBanner || null
    };
  }

  function listAccounts() {
    return read().accounts;
  }

  function importAccounts(accounts) {
    return update((state) => {
      const byKey = new Map(state.accounts.filter((item) => item.sessionKey).map((item) => [item.sessionKey, item]));
      for (const incoming of accounts) {
        const normalized = normalizeAccount(incoming);
        if (!normalized.sessionKey) continue;
        byKey.set(normalized.sessionKey, { ...(byKey.get(normalized.sessionKey) || {}), ...normalized });
      }
      state.accounts = Array.from(byKey.values()).sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      if (!state.currentAccountId && state.accounts[0]) state.currentAccountId = state.accounts[0].id;
      return state;
    });
  }

  function updateAccount(accountId, patch) {
    return update((state) => {
      const index = state.accounts.findIndex((account) => account.id === accountId);
      if (index >= 0) state.accounts[index] = { ...state.accounts[index], ...patch };
      return state;
    });
  }

  function setCurrentAccount(accountId) {
    return update((state) => {
      state.currentAccountId = accountId;
      return state;
    });
  }

  function replaceAccounts(accounts) {
    return update((state) => {
      state.accounts = accounts;
      if (state.currentAccountId && !accounts.some((account) => account.id === state.currentAccountId)) {
        state.currentAccountId = accounts[0]?.id || null;
      }
      return state;
    });
  }

  function listConversations() {
    return read().conversations;
  }

  function createConversation(title = '新的对话') {
    const conversation = {
      id: createId('conv'),
      title,
      messages: [],
      summary: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const state = update((draft) => {
      draft.conversations.unshift(conversation);
      draft.activeConversationId = conversation.id;
      return draft;
    });
    return { state, conversation };
  }

  function getConversation(conversationId) {
    return read().conversations.find((item) => item.id === conversationId) || null;
  }

  function setActiveConversation(conversationId) {
    return update((state) => {
      state.activeConversationId = conversationId;
      return state;
    });
  }

  function appendMessage(conversationId, message) {
    return update((state) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (!conversation) return state;
      conversation.messages.push({
        id: createId('msg'),
        createdAt: Date.now(),
        ...message
      });
      conversation.updatedAt = Date.now();
      if (message.role === 'user' && conversation.title === '新的对话') {
        conversation.title = message.content.slice(0, 28) || conversation.title;
      }
      return state;
    });
  }

  function updateConversation(conversationId, patch) {
    return update((state) => {
      const conversation = state.conversations.find((item) => item.id === conversationId);
      if (conversation) Object.assign(conversation, patch, { updatedAt: Date.now() });
      return state;
    });
  }

  return {
    filePath,
    read,
    write,
    update,
    listAccounts,
    importAccounts,
    updateAccount,
    setCurrentAccount,
    replaceAccounts,
    listConversations,
    createConversation,
    getConversation,
    setActiveConversation,
    appendMessage,
    updateConversation
  };
}

module.exports = { createStore, createId };

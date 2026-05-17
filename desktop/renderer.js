let state = null;

const $ = (selector) => document.querySelector(selector);

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function activeConversation() {
  return state?.conversations.find((item) => item.id === state.activeConversationId) || state?.conversations[0] || null;
}

function accountLabel(account) {
  return account.email || account.nickname || account.name || account.id;
}

function isLimited(account) {
  return !!(account.sessionBanner?.limited || account.usage?.free_limit?.limited);
}

function accountStatusText(account) {
  if (account.disabled) return `已禁用${account.disabledReason ? ` · ${account.disabledReason}` : ''}`;
  if (account.valid === false) return '登录态失效';
  if (account.quotaError) return `刷新异常 · ${account.quotaError.message}`;
  if (isLimited(account)) return '冷却中或额度受限';
  return '可路由';
}

function statusClass(account) {
  if (account.disabled || account.valid === false || isLimited(account)) return 'limited';
  if (account.quotaError) return 'error';
  return '';
}

function renderConversations() {
  const list = $('#conversationList');
  if (!state.conversations.length) {
    list.innerHTML = '<div class="empty">还没有对话<br>点右上角 + 创建第一场</div>';
    return;
  }

  list.innerHTML = state.conversations.map((conversation) => `
    <div class="conversation-item ${conversation.id === state.activeConversationId ? 'active' : ''}" data-conversation-id="${conversation.id}">
      <div class="conversation-name">${escapeHtml(conversation.title)}</div>
      <div class="conversation-time">${formatTime(conversation.updatedAt)}</div>
    </div>
  `).join('');

  list.querySelectorAll('.conversation-item').forEach((item) => {
    item.addEventListener('click', async () => {
      state = await window.cockpit.setActiveConversation(item.dataset.conversationId);
      render();
    });
  });
}

function renderAccounts() {
  const list = $('#accountList');
  const select = $('#accountSelect');

  select.innerHTML = '<option value="">自动选择账号</option>';
  for (const account of state.accounts) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = accountLabel(account);
    select.appendChild(option);
  }

  if (!state.accounts.length) {
    list.innerHTML = '<div class="empty">暂无账号<br>导入 claude_accounts JSON 后开始</div>';
    return;
  }

  list.innerHTML = state.accounts.map((account) => `
    <article class="account-card ${account.id === state.currentAccountId ? 'current' : ''} ${account.disabled ? 'disabled' : ''}">
      <div class="account-main">
        <div>
          <div class="account-name">${escapeHtml(account.nickname || account.name || account.plan || 'Claude 账号')}</div>
          <div class="account-email">${escapeHtml(account.email || account.sessionKey || '')}</div>
        </div>
        <button class="open-account-btn" data-account-id="${account.id}">打开</button>
      </div>
      <div class="account-status ${statusClass(account)}">
        ${escapeHtml(accountStatusText(account))} · ${escapeHtml(account.plan || 'Unknown')}
        ${account.usageUpdatedAt ? ` · ${formatTime(account.usageUpdatedAt)}` : ''}
      </div>
      <div class="account-actions">
        <button class="link-btn primary" data-action="current" data-account-id="${account.id}">${account.id === state.currentAccountId ? '默认账号' : '设为默认'}</button>
        <button class="link-btn" data-action="toggle" data-account-id="${account.id}">${account.disabled ? '启用' : '禁用'}</button>
      </div>
    </article>
  `).join('');

  list.querySelectorAll('.open-account-btn').forEach((button) => {
    button.addEventListener('click', () => window.cockpit.openAccount(button.dataset.accountId));
  });

  list.querySelectorAll('.link-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const accountId = button.dataset.accountId;
      if (button.dataset.action === 'current') {
        state = await window.cockpit.setCurrentAccount(accountId);
      } else if (button.dataset.action === 'toggle') {
        const account = state.accounts.find((item) => item.id === accountId);
        state = await window.cockpit.updateAccount(accountId, {
          disabled: !account.disabled,
          disabledReason: account.disabled ? '' : '手动禁用',
          disabledAt: account.disabled ? null : Date.now()
        });
      }
      render();
    });
  });
}

function renderMessages() {
  const container = $('#messages');
  const conversation = activeConversation();

  $('#chatTitle').textContent = conversation?.title || '新的对话';
  $('#chatMeta').textContent = conversation
    ? `${conversation.messages.length} 条消息 · 本地统一会话，账号可自动接力`
    : '本地统一会话，账号可自动接力';

  if (!conversation || !conversation.messages.length) {
    container.innerHTML = `
      <div class="empty">
        <div>
          <strong>先导入账号，然后直接聊天。</strong><br>
          第一版会展示账号路由和续聊提示；真实 Web 自动执行层后续接入。
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = conversation.messages.map((message) => `
    <div class="message ${message.role} ${message.status === 'error' ? 'error' : ''}">
      <div>
        <div class="message-bubble">${escapeHtml(message.content)}</div>
        ${message.role === 'assistant' ? `<div class="message-meta">账号：${escapeHtml(message.accountEmail || '未路由')} · ${escapeHtml(message.routeReason || '')}</div>` : ''}
      </div>
    </div>
  `).join('');

  container.scrollTop = container.scrollHeight;
}

function render() {
  renderConversations();
  renderAccounts();
  renderMessages();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refresh() {
  state = await window.cockpit.getState();
  if (!state.activeConversationId && state.conversations[0]) {
    state = await window.cockpit.setActiveConversation(state.conversations[0].id);
  }
  render();
}

async function sendMessage() {
  const input = $('#messageInput');
  const text = input.value.trim();
  if (!text) return;

  $('#sendBtn').disabled = true;
  input.value = '';

  try {
    let conversation = activeConversation();
    if (!conversation) {
      state = await window.cockpit.newConversation();
      conversation = activeConversation();
    }
    state = await window.cockpit.sendMessage({
      conversationId: conversation.id,
      accountId: $('#accountSelect').value || null,
      content: text
    });
    render();
  } finally {
    $('#sendBtn').disabled = false;
    input.focus();
  }
}

$('#newConversationBtn').addEventListener('click', async () => {
  state = await window.cockpit.newConversation();
  render();
  $('#messageInput').focus();
});

$('#importBtn').addEventListener('click', async () => {
  state = await window.cockpit.importAccounts();
  render();
});

$('#refreshAccountsBtn').addEventListener('click', async () => {
  $('#refreshAccountsBtn').disabled = true;
  try {
    state = await window.cockpit.refreshAccounts();
    render();
  } finally {
    $('#refreshAccountsBtn').disabled = false;
  }
});

$('#openStoreBtn').addEventListener('click', () => window.cockpit.openStoreFile());

$('#sendBtn').addEventListener('click', sendMessage);

$('#messageInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendMessage();
  }
});

refresh();

let state = null;
let latestUpdateInfo = null;

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
    list.innerHTML = '<div class="empty">还没有对话<br>点击右上角 + 创建第一场</div>';
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
      state = await window.claudeHub.setActiveConversation(item.dataset.conversationId);
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
    list.innerHTML = '<div class="empty">暂无账号<br>点击“导入”添加 JSON、Cookie 或 sessionKey</div>';
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
    button.addEventListener('click', () => window.claudeHub.openAccount(button.dataset.accountId));
  });

  list.querySelectorAll('.link-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const accountId = button.dataset.accountId;
      if (button.dataset.action === 'current') {
        state = await window.claudeHub.setCurrentAccount(accountId);
      } else if (button.dataset.action === 'toggle') {
        const account = state.accounts.find((item) => item.id === accountId);
        state = await window.claudeHub.updateAccount(accountId, {
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
          后续会展示账号路由和续聊提示；真实 Web 自动执行层会继续接入。
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
  state = await window.claudeHub.getState();
  if (!state.activeConversationId && state.conversations[0]) {
    state = await window.claudeHub.setActiveConversation(state.conversations[0].id);
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
      state = await window.claudeHub.newConversation();
      conversation = activeConversation();
    }
    state = await window.claudeHub.sendMessage({
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

function showImportModal() {
  $('#importMessage').textContent = '';
  $('#importModal').classList.remove('hidden');
}

function hideImportModal() {
  $('#importModal').classList.add('hidden');
}

function setImportMessage(text, tone = '') {
  const node = $('#importMessage');
  node.textContent = text;
  node.className = `modal-message ${tone}`;
}

async function runImport(action) {
  setImportMessage('正在导入...');
  try {
    state = await action();
    const result = state.lastImportResult;
    setImportMessage(`导入完成：新增 ${result?.imported || 0}，更新 ${result?.updated || 0}，跳过 ${result?.skipped || 0}。`, 'success');
    render();
  } catch (error) {
    setImportMessage(error.message || String(error), 'error');
  }
}

function showUpdateModal() {
  $('#updateModal').classList.remove('hidden');
}

function hideUpdateModal() {
  $('#updateModal').classList.add('hidden');
}

function setUpdateStatus(text) {
  $('#updateStatusBox').textContent = text;
}

function setUpdateProgress(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
  $('#updateProgressWrap').classList.remove('hidden');
  $('#updateProgressFill').style.width = `${value}%`;
  $('#updateProgressText').textContent = `${value}%`;
}

function renderUpdateInfo(info) {
  latestUpdateInfo = info;
  $('#downloadUpdateBtn').classList.remove('hidden');
  $('#restartUpdateBtn').classList.add('hidden');
  const version = info?.version || info?.tag || info?.releaseName || '新版本';
  setUpdateStatus(`发现 ${version}，点击下载并安装。`);
  $('#releaseNotes').textContent = info?.releaseNotes || info?.release_notes || '';
}

async function checkUpdate() {
  showUpdateModal();
  setUpdateStatus('正在检查 GitHub Releases...');
  $('#downloadUpdateBtn').classList.add('hidden');
  $('#restartUpdateBtn').classList.add('hidden');
  $('#updateProgressWrap').classList.add('hidden');
  $('#releaseNotes').textContent = '';
  try {
    const result = await window.claudeHub.checkUpdate();
    if (result.status === 'dev') {
      setUpdateStatus(result.message);
    } else if (result.updateInfo) {
      renderUpdateInfo(result.updateInfo);
    } else {
      setUpdateStatus('当前已经是最新版本。');
    }
  } catch (error) {
    setUpdateStatus(error.message || String(error));
  }
}

function wireEvents() {
  $('#newConversationBtn').addEventListener('click', async () => {
    state = await window.claudeHub.newConversation();
    render();
    $('#messageInput').focus();
  });

  $('#importBtn').addEventListener('click', showImportModal);
  $('#accountsNavBtn').addEventListener('click', showImportModal);
  $('#closeImportModal').addEventListener('click', hideImportModal);
  $('#importModal').addEventListener('click', (event) => {
    if (event.target === $('#importModal')) hideImportModal();
  });

  document.querySelectorAll('[data-import-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-import-tab]').forEach((tab) => tab.classList.remove('active'));
      document.querySelectorAll('[data-import-pane]').forEach((pane) => pane.classList.remove('active'));
      button.classList.add('active');
      document.querySelector(`[data-import-pane="${button.dataset.importTab}"]`).classList.add('active');
    });
  });

  $('#chooseImportFilesBtn').addEventListener('click', () => runImport(() => window.claudeHub.importAccounts()));
  $('#pasteImportBtn').addEventListener('click', () => runImport(() => window.claudeHub.importAccountsFromText($('#importText').value)));
  $('#importCurrentStoreBtn').addEventListener('click', () => runImport(() => window.claudeHub.importCurrentStore()));
  $('#pasteExampleBtn').addEventListener('click', () => {
    $('#importText').value = JSON.stringify([{ email: 'name@example.com', sessionKey: 'sk-ant-sid01-your-session-key' }], null, 2);
  });

  $('#refreshAccountsBtn').addEventListener('click', async () => {
    $('#refreshAccountsBtn').disabled = true;
    try {
      state = await window.claudeHub.refreshAccounts();
      render();
    } finally {
      $('#refreshAccountsBtn').disabled = false;
    }
  });

  $('#openStoreBtn').addEventListener('click', () => window.claudeHub.openStoreFile());
  $('#sendBtn').addEventListener('click', sendMessage);
  $('#messageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendMessage();
    }
  });

  $('#checkUpdateBtn').addEventListener('click', checkUpdate);
  $('#updateNavBtn').addEventListener('click', checkUpdate);
  $('#manualCheckUpdateBtn').addEventListener('click', checkUpdate);
  $('#closeUpdateModal').addEventListener('click', hideUpdateModal);
  $('#updateModal').addEventListener('click', (event) => {
    if (event.target === $('#updateModal')) hideUpdateModal();
  });
  $('#downloadUpdateBtn').addEventListener('click', async () => {
    setUpdateStatus(`正在下载 ${latestUpdateInfo?.version || '新版本'}...`);
    $('#downloadUpdateBtn').disabled = true;
    try {
      await window.claudeHub.downloadUpdate();
    } catch (error) {
      setUpdateStatus(error.message || String(error));
      $('#downloadUpdateBtn').disabled = false;
    }
  });
  $('#restartUpdateBtn').addEventListener('click', () => window.claudeHub.installUpdate());

  window.claudeHub.onUpdateEvent((payload) => {
    if (payload.type === 'checking') setUpdateStatus('正在检查 GitHub Releases...');
    if (payload.type === 'available') renderUpdateInfo(payload.info);
    if (payload.type === 'not-available') setUpdateStatus('当前已经是最新版本。');
    if (payload.type === 'progress') setUpdateProgress(payload.progress?.percent || 0);
    if (payload.type === 'downloaded') {
      setUpdateProgress(100);
      setUpdateStatus('更新已下载完成。点击立即重启，应用会自动完成安装。');
      $('#downloadUpdateBtn').classList.add('hidden');
      $('#restartUpdateBtn').classList.remove('hidden');
    }
    if (payload.type === 'error') {
      setUpdateStatus(payload.message || '更新失败');
      $('#downloadUpdateBtn').disabled = false;
    }
  });
}

wireEvents();
refresh();

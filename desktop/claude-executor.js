const { BrowserWindow, session } = require('electron');

const AUTOMATION_TIMEOUT_MS = 180000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieUrl(cookie) {
  const domain = (cookie.domain || '.claude.ai').replace(/^\./, '');
  return `https://${domain}${cookie.path || '/'}`;
}

async function hydrateAccountCookies(account) {
  const partition = `persist:claude-account-${account.id}`;
  const ses = session.fromPartition(partition);
  const cookies = account.cookies?.length
    ? account.cookies
    : [{
        domain: '.claude.ai',
        name: 'sessionKey',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'no_restriction',
        value: account.sessionKey
      }];

  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value) continue;
    await ses.cookies.set({
      url: cookieUrl(cookie),
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '.claude.ai',
      path: cookie.path || '/',
      secure: cookie.secure !== false,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite === 'no_restriction' ? 'no_restriction' : cookie.sameSite
    }).catch((error) => {
      console.warn('[executor] cookie set failed:', cookie.name, error.message);
    });
  }

  return { ses, partition };
}

function normalizePlan(data) {
  if (!data) return 'Unknown';
  const raw = String(data.plan || data.subscriptionType || data.account_type ||
    data.planName || data.tier || data.subscription_type || '').toLowerCase().trim();
  if (raw.includes('max_20') || raw.includes('max20')) return 'Max 20x';
  if (raw.includes('max_5') || raw.includes('max5')) return 'Max 5x';
  if (raw.includes('max')) return 'Max';
  if (raw.includes('team')) return 'Team';
  if (raw.includes('enterprise')) return 'Enterprise';
  if (raw.includes('pro')) return 'Pro';
  if (raw.includes('free') || raw === '') return 'Free';
  return raw || 'Unknown';
}

function normalizeUsageBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const resets_at = block.resets_at || block.reset_at || null;
  if (block.used_pct !== undefined) return { utilization: +Number(block.used_pct).toFixed(2), resets_at, used: block.used, total: block.total || block.limit };
  if (block.utilization !== undefined) return { utilization: +Number(block.utilization).toFixed(2), resets_at, used: block.used, total: block.total || block.limit };
  const total = block.total || block.limit;
  if (block.used !== undefined && total !== undefined) return { utilization: total ? Math.round(block.used / total * 100) : 0, resets_at, used: block.used, total };
  if (block.remaining !== undefined) {
    const used = total != null ? total - block.remaining : null;
    return { utilization: total ? Math.round((total - block.remaining) / total * 100) : null, resets_at, used, total, remaining: block.remaining };
  }
  return null;
}

function parseUsageResponse(d) {
  const empty = { five_hour: null, seven_day: null, message_limit: null, free_limit: null };
  if (!d || typeof d !== 'object') return empty;
  const r = { ...empty };
  r.five_hour = normalizeUsageBlock(d.five_hour || d.session || d.session_cap) || r.five_hour;
  r.seven_day = normalizeUsageBlock(d.seven_day || d.weekly || d.weekly_cap) || r.seven_day;
  r.message_limit = normalizeUsageBlock(d.message_limit) || r.message_limit;
  if (d.messages_remaining !== undefined) {
    r.message_limit = {
      remaining: d.messages_remaining,
      total: d.messages_total || null,
      resets_at: d.resets_at || null,
      utilization: d.messages_total ? Math.round((1 - d.messages_remaining / d.messages_total) * 100) : null
    };
  }
  if (!r.five_hour && !r.seven_day && !r.message_limit) {
    const b = normalizeUsageBlock(d);
    if (b) r.five_hour = b;
  }
  return r;
}

async function fetchJsonWithAccount(account, apiPath) {
  const { ses } = await hydrateAccountCookies(account);
  const cookies = await ses.cookies.get({ url: 'https://claude.ai' });
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const response = await fetch(`https://claude.ai${apiPath}`, {
    headers: {
      accept: 'application/json',
      cookie: cookieHeader,
      'anthropic-client-platform': 'web_claude_ai'
    }
  });

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function refreshAccountSnapshot(account) {
  const patch = {
    refreshedAt: Date.now(),
    status: 'ready',
    quotaError: null
  };

  try {
    for (const endpoint of ['/api/account', '/api/auth/session', '/api/me']) {
      try {
        const data = await fetchJsonWithAccount(account, endpoint);
        const user = data.user || data;
        if (user.email || user.id) {
          patch.email = user.email || user.emailAddress || user.email_address || account.email;
          patch.name = user.name || user.full_name || user.fullName || account.name;
          patch.plan = normalizePlan(user);
          patch.userId = user.id || user.uuid || account.userId;
          patch.valid = true;
          break;
        }
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
      }
    }

    for (const endpoint of ['/api/usage_report/claude_code', '/api/rate_limits', '/api/account/usage', '/api/usage']) {
      try {
        const data = await fetchJsonWithAccount(account, endpoint);
        patch.usage = parseUsageResponse(data);
        patch.usageUpdatedAt = Date.now();
        break;
      } catch (error) {
        if (error.status === 429) {
          patch.status = 'cooldown';
          patch.usage = {
            ...(account.usage || {}),
            free_limit: { limited: true, resets_at: null }
          };
          break;
        }
      }
    }

    return patch;
  } catch (error) {
    return {
      refreshedAt: Date.now(),
      valid: error.status === 401 || error.status === 403 ? false : account.valid,
      status: error.status === 401 || error.status === 403 ? 'invalid' : 'refresh_error',
      quotaError: {
        code: error.status || null,
        message: error.message,
        timestamp: Date.now()
      }
    };
  }
}

async function openAccountWindow(account) {
  const { partition } = await hydrateAccountCookies(account);
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    title: `Claude - ${account.email || account.nickname || account.id}`,
    webPreferences: {
      partition
    }
  });
  await win.loadURL('https://claude.ai/new');
  return true;
}

async function loadUrl(win, url) {
  await new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = (_event, _code, description) => {
      cleanup();
      reject(new Error(description || 'load failed'));
    };
    const cleanup = () => {
      win.webContents.off('did-finish-load', done);
      win.webContents.off('did-fail-load', fail);
    };
    win.webContents.once('did-finish-load', done);
    win.webContents.once('did-fail-load', fail);
    win.loadURL(url).catch(reject);
  });
}

async function waitForEditor(win, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await win.webContents.executeJavaScript(`
      Boolean(document.querySelector('[contenteditable="true"], textarea'))
    `).catch(() => false);
    if (ready) return true;
    await delay(750);
  }
  return false;
}

async function insertPromptAndSend(win, prompt) {
  const promptJson = JSON.stringify(prompt);
  return win.webContents.executeJavaScript(`
    (() => {
      const prompt = ${promptJson};
      const editor = document.querySelector('[contenteditable="true"], textarea');
      if (!editor) return { ok: false, error: '找不到输入框' };

      editor.focus();
      if (editor.tagName === 'TEXTAREA') {
        editor.value = prompt;
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, prompt);
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
      }

      const buttons = Array.from(document.querySelectorAll('button'));
      const send = buttons.find((button) => {
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('data-testid'),
          button.textContent
        ].join(' ').toLowerCase();
        return !button.disabled && (
          label.includes('send') ||
          label.includes('submit') ||
          label.includes('发送') ||
          label.includes('arrow-up')
        );
      });

      if (!send) return { ok: false, error: '找不到发送按钮' };
      send.click();
      return { ok: true };
    })();
  `);
}

async function extractLatestAssistantText(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const selectors = [
        '.font-claude-message',
        '[data-testid*="assistant"]',
        '[class*="assistant"]',
        '[data-message-author-role="assistant"]'
      ];
      const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
      const texts = nodes
        .map((node) => (node.innerText || node.textContent || '').trim())
        .filter((text) => text.length > 0);
      return texts[texts.length - 1] || '';
    })();
  `).catch(() => '');
}

async function waitForStableAssistantText(win, timeoutMs = AUTOMATION_TIMEOUT_MS) {
  const start = Date.now();
  let previous = '';
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    const text = await extractLatestAssistantText(win);
    if (text && text === previous) {
      stableCount += 1;
      if (stableCount >= 3) return text;
    } else {
      previous = text;
      stableCount = text ? 1 : 0;
    }
    await delay(1800);
  }

  return previous;
}

async function automateClaudeWeb(account, prompt) {
  const { partition } = await hydrateAccountCookies(account);
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    show: process.env.CLAUDE_COCKPIT_SHOW_AUTOMATION !== '0',
    title: `Claude Cockpit Runner - ${account.email || account.nickname || account.id}`,
    webPreferences: {
      partition
    }
  });

  try {
    await loadUrl(win, 'https://claude.ai/new');
    const hasEditor = await waitForEditor(win);
    if (!hasEditor) {
      return { ok: false, error: 'Claude 页面未出现输入框，可能需要重新登录或通过 Cloudflare 校验。' };
    }

    const sent = await insertPromptAndSend(win, prompt);
    if (!sent.ok) return sent;

    const answer = await waitForStableAssistantText(win);
    if (!answer) return { ok: false, error: '已发送，但没有成功读取 Claude 回复。' };
    return { ok: true, mode: 'web-automation', content: answer };
  } finally {
    if (process.env.CLAUDE_COCKPIT_KEEP_WINDOWS !== '1' && !win.isDestroyed()) {
      win.close();
    }
  }
}

async function sendWithAccount({ account, prompt }) {
  if (!account) {
    return {
      ok: false,
      error: '没有可用账号。请先导入账号，或等待额度恢复。'
    };
  }

  if (process.env.CLAUDE_COCKPIT_ENABLE_WEB_AUTOMATION !== '1') {
    return {
      ok: true,
      mode: 'handoff-preview',
      content: [
        `已路由到：${account.email || account.nickname || account.name || account.id}`,
        '',
        '桌面 cockpit 的账号池、会话存储和跨账号续聊提示已经接好。',
        '真实 Claude Web 自动发送层还处于保护开关后面，避免在没有校准页面选择器前误操作。',
        '',
        '本次会交给 Claude 的续聊提示预览：',
        prompt
      ].join('\n')
    };
  }

  return automateClaudeWeb(account, prompt);
}

module.exports = {
  hydrateAccountCookies,
  openAccountWindow,
  sendWithAccount,
  refreshAccountSnapshot
};

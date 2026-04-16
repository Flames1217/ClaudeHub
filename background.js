// background.js v10 - Claude Switcher
// 核心修复：切号跳登录页问题

const FETCH_TIMEOUT_MS = 12000;

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

// ── 扩展安装/更新时刷新所有 claude.ai 标签 ──
// 杀死旧的 content script，防止 "Extension context invalidated" 错误
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    try {
      const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
      for (const tab of tabs) {
        try { chrome.tabs.reload(tab.id); } catch {}
      }
    } catch {}
  }
});

// ── Content script keepalive port ──
// content.js 用 chrome.runtime.connect 建立长连接，
// 扩展重载时 port 自动断开，content script 据此自毁
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'content-keepalive') {
    // 保持 port 存活，不需要做任何事
    port.onDisconnect.addListener(() => { /* no-op */ });
  }
});

// ── Cookie 操作 ──
async function getCookie(name) {
  try {
    const c = await chrome.cookies.get({ url: 'https://claude.ai', name });
    return c ? c.value : null;
  } catch { return null; }
}

async function setCookie(name, value) {
  await removeCookie(name);
  return chrome.cookies.set({
    url: 'https://claude.ai',
    domain: '.claude.ai',
    name,
    value,
    path: '/',
    secure: true,
    sameSite: 'no_restriction',
    expirationDate: Math.floor(Date.now() / 1000) + 86400 * 365 * 5
  }).catch(() => {});
}

async function removeCookie(name) {
  try {
    const all = await chrome.cookies.getAll({ name });
    for (const c of all) {
      if (c.domain && c.domain.includes('claude.ai')) {
        const u = `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`;
        await chrome.cookies.remove({ url: u, name, storeId: c.storeId }).catch(() => {});
      }
    }
  } catch {}
}

async function getAllCookies() {
  try { return await chrome.cookies.getAll({ domain: 'claude.ai' }); } catch { return []; }
}

// 切号时必须清除的所有 session 相关 cookie
// ⚠️ Bug3修复关键：__cf_bm / CF_AppSession 是 Cloudflare 反爬 cookie，
// 与用户身份无关，清除后 CF 会重新质询请求，触发重定向到登录页。
// 只清除真正属于用户会话的 cookie（lastActiveOrg / intercom 等）
const SESSION_COOKIES_TO_CLEAR = [
  'activitySessionId',
  'lastActiveOrg',
  'intercom-session-jlmqxicb',
  'intercom-device-nonce-jlmqxicb',
  '__stripe_mid',
  '__stripe_sid',
];

async function clearSessionCookies() {
  for (const name of SESSION_COOKIES_TO_CLEAR) {
    await removeCookie(name);
  }
  // Bug3修复：移除之前的宽泛正则清除逻辑
  // 原来的代码会把所有含 "session"/"auth" 字样的 cookie 全部删除，
  // 导致 Cloudflare/__Secure- 前缀的必要 cookie 被误删，切号后必跳登录页
}

// ── 找 claude.ai 标签（优先 active，其次最近访问，排除 dashboard/login）──
async function getClaudeTab(preferTabId) {
  try {
    const tabs = await chrome.tabs.query({});
    const valid = tabs.filter(t =>
      t.url &&
      t.url.startsWith('https://claude.ai') &&
      !t.url.includes('dashboard.html') &&
      !t.url.includes('/login') &&
      !t.url.startsWith('chrome-extension://')
    );
    if (!valid.length) return null;
    // 1. 调用方指定了 tabId（最准确）
    if (preferTabId) {
      const found = valid.find(t => t.id === preferTabId);
      if (found) return found;
    }
    // 2. 当前窗口 active tab
    const active = valid.find(t => t.active);
    if (active) return active;
    // 3. 按 lastAccessed 排序，取最近
    valid.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return valid[0];
  } catch { return null; }
}

// ── Content script fetch（带 cookie 凭证）──
async function fetchViaContent(tabId, path) {
  try {
    const r = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: 'CONTENT_FETCH', url: `https://claude.ai${path}` }),
      FETCH_TIMEOUT_MS
    );
    return (r && r._ok) ? { ok: true, data: r.data } : { ok: false, status: r?._status || 0 };
  } catch { return { ok: false, status: 0 }; }
}

// ── 套餐识别 ──
function normalizePlan(data) {
  if (!data) return 'Unknown';
  const raw = (data.plan || data.subscriptionType || data.account_type ||
    data.planName || data.tier || data.subscription_type || '').toString().toLowerCase().trim();
  if (raw.includes('max_20') || raw.includes('max20')) return 'Max 20x';
  if (raw.includes('max_5') || raw.includes('max5')) return 'Max 5x';
  if (raw.includes('max')) return 'Max';
  if (raw.includes('team')) return 'Team';
  if (raw.includes('enterprise')) return 'Enterprise';
  if (raw.includes('pro')) return 'Pro';
  if (raw.includes('free') || raw === '') return 'Free';
  return raw || 'Unknown';
}

// ── 获取账号信息 ──
async function fetchAccountInfo(tab) {
  if (!tab) return { email: '', plan: 'Unknown', valid: null };
  for (const ep of ['/api/account', '/api/auth/session', '/api/me']) {
    const r = await fetchViaContent(tab.id, ep);
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) return { email: '', plan: 'Unknown', valid: false };
      continue;
    }
    const d = r.data;
    if (!d) continue;
    const user = d.user || d;
    const email = user.email || user.emailAddress || user.email_address || '';
    if (!email && !user.id) continue;
    return {
      email,
      name: user.name || user.full_name || user.fullName || '',
      plan: normalizePlan(user),
      userId: user.id || user.uuid || '',
      valid: true
    };
  }
  return { email: '', plan: 'Unknown', valid: null };
}

// ── Usage 解析 ──
function normalizeUsageBlock(block) {
  if (!block || typeof block !== 'object') return null;
  const resets_at = block.resets_at || block.reset_at || null;
  if (block.used_pct !== undefined) return { utilization: +block.used_pct.toFixed(2), resets_at, used: block.used, total: block.total || block.limit };
  if (block.utilization !== undefined) return { utilization: +block.utilization.toFixed(2), resets_at, used: block.used, total: block.total || block.limit };
  const total = block.total || block.limit;
  if (block.used !== undefined && total !== undefined) return { utilization: total ? Math.round(block.used / total * 100) : 0, resets_at, used: block.used, total };
  if (block.remaining !== undefined) {
    const used = total != null ? total - block.remaining : null;
    return { utilization: total ? Math.round((total - block.remaining) / total * 100) : null, resets_at, used, total, remaining: block.remaining };
  }
  return null;
}

function parseUsageResponse(d) {
  const empty = { five_hour: null, seven_day: null, message_limit: null };
  if (!d || typeof d !== 'object') return empty;
  const r = { ...empty };
  r.five_hour = normalizeUsageBlock(d.five_hour || d.session || d.session_cap) || r.five_hour;
  r.seven_day = normalizeUsageBlock(d.seven_day || d.weekly || d.weekly_cap) || r.seven_day;
  r.message_limit = normalizeUsageBlock(d.message_limit) || r.message_limit;
  if (d.messages_remaining !== undefined)
    r.message_limit = {
      remaining: d.messages_remaining, total: d.messages_total || null,
      resets_at: d.resets_at || null,
      utilization: d.messages_total ? Math.round((1 - d.messages_remaining / d.messages_total) * 100) : null
    };
  if (Array.isArray(d)) {
    for (const item of d) {
      const wt = (item.window_type || item.type || item.period || '').toLowerCase();
      const block = normalizeUsageBlock(item);
      if (!block) continue;
      if (wt.includes('hour') || wt.includes('session') || wt.includes('5h')) r.five_hour = r.five_hour || block;
      else if (wt.includes('day') || wt.includes('week') || wt.includes('7d')) r.seven_day = r.seven_day || block;
      else if (wt.includes('message') || wt.includes('msg')) r.message_limit = r.message_limit || block;
      else r.five_hour = r.five_hour || block;
    }
  }
  if (!r.five_hour && !r.seven_day && !r.message_limit) {
    const b = normalizeUsageBlock(d);
    if (b) r.five_hour = b;
  }
  return r;
}

function parseFreeRateLimit(data) {
  if (!data || typeof data !== 'object') return null;
  const fields = ['resets_at', 'reset_at', 'available_at', 'retry_after', 'resetAt', 'availableAt'];
  let resets_at = null;
  for (const f of fields) { if (data[f]) { resets_at = data[f]; break; } }
  for (const key of ['rate_limit', 'rateLimit', 'limit', 'chat_limit', 'session']) {
    if (data[key] && typeof data[key] === 'object')
      for (const f of fields) { if (data[key][f]) { resets_at = resets_at || data[key][f]; break; } }
  }
  const remaining = data.remaining ?? data.messages_remaining ?? null;
  const total = data.total ?? data.limit ?? data.messages_total ?? null;
  const used = data.used ?? (total != null && remaining != null ? total - remaining : null);
  if (!resets_at && remaining == null && !used) return null;
  return { remaining, total, used, resets_at, utilization: total ? Math.round(((used ?? 0) / total) * 100) : null };
}

async function fetchUsage(tab) {
  if (!tab) return { five_hour: null, seven_day: null, message_limit: null, free_limit: null };
  const endpoints = ['/api/usage_report/claude_code', '/api/rate_limits', '/api/account/usage', '/api/usage'];
  const raw = {};
  let detectedLimit = null;

  for (const ep of endpoints) {
    const r = await fetchViaContent(tab.id, ep);
    const data = (r && r.ok) ? r.data : null;
    raw[ep] = data || { _status: r?.status || 'error' };
    
    // 核心改进：识别 429 状态码（即便 API 不返回 JSON 数据）
    if (r?.status === 429) {
      detectedLimit = detectedLimit || { limited: true, status: 429, type: 'status_code' };
    }

    if (!data) continue;

    // 识别 API 返回的错误结构
    if (data.error && (data.error.type === 'rate_limit_error' || data.error.status === 429)) {
       const resetsAt = data.error.resets_at || (data.error.message && data.error.message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)?.[0]);
       detectedLimit = { limited: true, resets_at: resetsAt, text: data.error.message, type: 'api_error' };
    }

    const result = parseUsageResponse(data);
    if (result.five_hour || result.seven_day || result.message_limit) {
      const free = parseFreeRateLimit(data);
      if (free && (free.resets_at || free.remaining === 0)) {
        detectedLimit = { limited: true, resets_at: free.resets_at, type: 'parsed_limit' };
      }
      return { ...result, free_limit: free || detectedLimit, _raw: raw };
    }
  }

  let free_limit = detectedLimit;
  for (const ep of endpoints) {
    if (raw[ep] && raw[ep]._status !== 'error') {
       const fl = parseFreeRateLimit(raw[ep]);
       if (fl) { free_limit = fl; break; }
    }
  }
  return { five_hour: null, seven_day: null, message_limit: null, free_limit, _raw: raw };
}

// ── Storage ──
async function getAccounts() {
  try { const r = await chrome.storage.local.get('accounts'); return r.accounts || []; } catch { return []; }
}
async function saveAccounts(a) {
  try { await chrome.storage.local.set({ accounts: a }); } catch {}
}

// 实时读取当前 sessionKey（处理多个同名 cookie 共存的情况）
async function detectCurrentKey() {
  try {
    const all = await chrome.cookies.getAll({ url: 'https://claude.ai', name: 'sessionKey' });
    if (all.length === 0) return null;
    if (all.length === 1) return all[0].value;
    // 多个 sessionKey cookie 共存（host-only vs domain）时，
    // 优先取 domain cookie（服务器设置的，反映最新登录状态）
    const domainCookies = all.filter(c => c.domain.startsWith('.'));
    if (domainCookies.length > 0) {
      domainCookies.sort((a, b) => (b.expirationDate || 0) - (a.expirationDate || 0));
      return domainCookies[0].value;
    }
    all.sort((a, b) => (b.expirationDate || 0) - (a.expirationDate || 0));
    return all[0].value;
  } catch { return null; }
}

// 注意：不在启动时自动清理 cookie（风险太大，可能删除有效 cookie 导致登出）
// 重复 cookie 问题通过以下方式解决：
// 1. setCookie 设置前先清除所有同名 cookie
// 2. detectCurrentKey 多 cookie 共存时优先取 domain cookie（服务器设置的）

// ── 切换账号（重写核心逻辑）──
//
// claude.ai 切号失败根本原因分析：
// 1. claude.ai 是 Next.js SSR 应用，页面加载时服务端会验证 cookie 中的 sessionKey
// 2. 我们换了 sessionKey，但 Next.js 客户端路由（client-side navigation）不会重新走服务端验证
// 3. 必须触发完整的服务端渲染（full page reload），而不是 SPA 导航
// 4. tabs.update 到同域 URL 时，如果页面已经加载过，浏览器可能走 bfcache 或 SPA 路由
//
// 解决方案：
// 先把标签跳转到 about:blank（强制卸载页面，清空 JS 堆内存中缓存的认证状态）
// 然后再跳到 claude.ai/new（此时是全新的页面加载，服务端用新 sessionKey 验证）
//
async function switchToAccount(account) {
  try {
    // Bug3修复：防御性校验，避免用空/无效key覆盖cookie
    if (!account?.sessionKey || !account.sessionKey.startsWith('sk-ant-')) {
      console.error('[Switcher] invalid sessionKey, abort switch');
      return false;
    }

    const claudeTab = await getClaudeTab();

    // Step 1: 恢复该账号保存的全部 cookie（不只是 sessionKey）
    // claude.ai 可能依赖多个认证 cookie，只设 sessionKey 可能不够
    if (account.cookies && Array.isArray(account.cookies)) {
      // 不恢复的 cookie：Cloudflare 反爬 cookie（会自动重新签发）和即将清除的 session cookie
      const skipNames = new Set([
        '__cf_bm', 'CF_AppSession', 'cf_clearance',
        ...SESSION_COOKIES_TO_CLEAR
      ]);
      for (const c of account.cookies) {
        if (!c.name || skipNames.has(c.name)) continue;
        if (c.name === 'sessionKey') continue; // sessionKey 最后单独设置
        try {
          await chrome.cookies.set({
            url: `https://${c.domain?.replace(/^\./, '') || 'claude.ai'}${c.path || '/'}`,
            name: c.name,
            value: c.value,
            path: c.path || '/',
            secure: c.secure !== false,
            sameSite: c.sameSite || 'no_restriction',
            httpOnly: c.httpOnly || false,
            expirationDate: c.expirationDate || Math.floor(Date.now() / 1000) + 86400 * 30
          });
        } catch {}
      }
    }

    // sessionKey 最后设置，确保覆盖
    await setCookie('sessionKey', account.sessionKey);
    await clearSessionCookies();

    // Step 2: 如果有 claude.ai 标签，清除页面端存储后跳转 about:blank
    if (claudeTab) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: claudeTab.id },
          func: () => {
            try { localStorage.clear(); } catch {}
            try { sessionStorage.clear(); } catch {}
            try {
              indexedDB.databases().then(dbs => {
                dbs.forEach(db => indexedDB.deleteDatabase(db.name));
              }).catch(() => {});
            } catch {}
          }
        });
      } catch (err) { console.warn('executeScript failed', err); }

      try {
        // 跳到 about:blank 强制卸载页面，避免 bfcache / SPA 路由缓存
        await chrome.tabs.update(claudeTab.id, { url: 'about:blank' });
        // 等待页面完全卸载
        await new Promise(r => setTimeout(r, 400));
      } catch (err) { console.warn('tabs.update about:blank failed', err); }
    }

    // Step 3: 确保 cookie 写入完成
    await new Promise(r => setTimeout(r, 200));

    // Step 4: 更新 lastUsed
    const all = await getAccounts();
    const idx = all.findIndex(a => a.sessionKey === account.sessionKey);
    if (idx >= 0) { all[idx].lastUsed = Date.now(); await saveAccounts(all); }

    // Step 5: 跳转到 /new（完整服务端渲染，用新 sessionKey 验证）
    if (claudeTab) {
      try {
        await chrome.tabs.update(claudeTab.id, { url: 'https://claude.ai/new' });
      } catch (err) {
        await chrome.tabs.create({ url: 'https://claude.ai/new' });
      }
    } else {
      await chrome.tabs.create({ url: 'https://claude.ai/new' });
    }

    // ── 核心改进：立即广播切号事件 ──
    // 解决 UI 延迟问题，通知所有面板（Background, Popup, Dashboard）立即刷新
    chrome.runtime.sendMessage({ type: 'ACCOUNT_UPDATED', currentSessionKey: account.sessionKey }).catch(() => {});

    return true;
  } catch (e) {
    console.error('[Switcher] switch error:', e);
    return false;
  }
}

// ── 独立刷新非当前账号 ──
async function refreshOneAccount(targetAccount, currentKey, tab) {
  if (!tab) return null;
  const orig = currentKey || await detectCurrentKey();
  try {
    await setCookie('sessionKey', targetAccount.sessionKey);
    await clearSessionCookies();
    await new Promise(r => setTimeout(r, 800));
    const [accInfo, usage] = await Promise.all([fetchAccountInfo(tab), fetchUsage(tab)]);
    return {
      email: accInfo.email || targetAccount.email,
      name: accInfo.name || targetAccount.name,
      plan: (accInfo.plan && accInfo.plan !== 'Unknown') ? accInfo.plan : targetAccount.plan,
      userId: accInfo.userId || targetAccount.userId,
      valid: accInfo.valid !== null ? accInfo.valid : targetAccount.valid,
      usage: { five_hour: usage.five_hour, seven_day: usage.seven_day, message_limit: usage.message_limit, free_limit: usage.free_limit },
      refreshedAt: Date.now()
    };
  } catch (e) {
    console.error('[Switcher] refreshOne error:', e);
    return null;
  } finally {
    if (orig) {
      await setCookie('sessionKey', orig).catch(() => {});
      await clearSessionCookies();
    }
  }
}

// ── Message handler ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'PING': sendResponse({ pong: true }); break;

        case 'GET_ACCOUNTS': {
          const accounts = await getAccounts();
          const currentSessionKey = await detectCurrentKey();
          sendResponse({ accounts, currentSessionKey });
          break;
        }

        case 'GET_CURRENT_KEY': {
          const currentSessionKey = await detectCurrentKey();
          sendResponse({ currentSessionKey });
          break;
        }

        case 'SAVE_ACCOUNT': {
          const accounts = await getAccounts();
          const idx = accounts.findIndex(a => a.sessionKey === msg.account.sessionKey);
          if (idx >= 0) accounts[idx] = { ...accounts[idx], ...msg.account };
          else accounts.push(msg.account);
          await saveAccounts(accounts);
          sendResponse({ success: true, accounts });
          break;
        }

        case 'DELETE_ACCOUNT': {
          const accounts = await getAccounts();
          const filtered = accounts.filter(a => a.sessionKey !== msg.sessionKey);
          await saveAccounts(filtered);
          sendResponse({ success: true, accounts: filtered });
          break;
        }

        case 'SWITCH_ACCOUNT': {
          const ok = await switchToAccount(msg.account);
          sendResponse({ success: ok });
          break;
        }

        case 'FETCH_ACCOUNT_INFO': {
          const sessionKey = await detectCurrentKey();
          if (!sessionKey) { sendResponse({ error: 'not_logged_in' }); break; }
          // 优先使用调用方传入的 tabId，确保从正确标签获取账号信息
          const tab = await getClaudeTab(msg.tabId || null);
          const cookies = await getAllCookies();
          const [accInfo, usage] = await Promise.all([fetchAccountInfo(tab), fetchUsage(tab)]);
          sendResponse({ sessionKey, cookies, usage, ...accInfo });
          break;
        }

        case 'REFRESH_ALL_STATS': {
          const accounts = await getAccounts();
          const currentKey = await detectCurrentKey();
          if (currentKey) {
            const tab = await getClaudeTab();
            if (tab) {
              const [accInfo, usage] = await Promise.all([fetchAccountInfo(tab), fetchUsage(tab)]);
              for (let i = 0; i < accounts.length; i++) {
                if (accounts[i].sessionKey === currentKey) {
                  accounts[i] = {
                    ...accounts[i],
                    email: accInfo.email || accounts[i].email,
                    name: accInfo.name || accounts[i].name,
                    plan: (accInfo.plan && accInfo.plan !== 'Unknown') ? accInfo.plan : accounts[i].plan,
                    userId: accInfo.userId || accounts[i].userId,
                    ...(accInfo.valid !== null ? { valid: accInfo.valid } : {}),
                    usage: { five_hour: usage.five_hour, seven_day: usage.seven_day, message_limit: usage.message_limit, free_limit: usage.free_limit },
                    refreshedAt: Date.now()
                  };
                  // 手动刷新如果确认没有限流，则清理掉之前的 DOM Banner 标记
                  if (!usage.free_limit?.limited && accounts[i].sessionBanner) {
                     accounts[i].sessionBanner.limited = false;
                     accounts[i].sessionBanner.resets_at = null;
                  }
                }
              }
            }
          }
          await saveAccounts(accounts);
          sendResponse({ success: true, accounts, currentSessionKey: currentKey });
          break;
        }

        case 'REFRESH_ONE_ACCOUNT': {
          const accounts = await getAccounts();
          const currentKey = await detectCurrentKey();
          const idx = accounts.findIndex(a => a.sessionKey === msg.sessionKey);
          if (idx < 0) { sendResponse({ success: false, error: 'not_found' }); break; }

          const tab = await getClaudeTab();
          if (accounts[idx].sessionKey === currentKey) {
            if (tab) {
              const [accInfo, usage] = await Promise.all([fetchAccountInfo(tab), fetchUsage(tab)]);
              accounts[idx] = {
                ...accounts[idx],
                email: accInfo.email || accounts[idx].email,
                plan: (accInfo.plan && accInfo.plan !== 'Unknown') ? accInfo.plan : accounts[idx].plan,
                userId: accInfo.userId || accounts[idx].userId,
                ...(accInfo.valid !== null ? { valid: accInfo.valid } : {}),
                usage: { five_hour: usage.five_hour, seven_day: usage.seven_day, message_limit: usage.message_limit, free_limit: usage.free_limit },
                refreshedAt: Date.now()
              };
              if (!usage.free_limit?.limited && accounts[idx].sessionBanner) {
                 accounts[idx].sessionBanner.limited = false;
                 accounts[idx].sessionBanner.resets_at = null;
              }
            }
          } else {
            const stats = await refreshOneAccount(accounts[idx], currentKey, tab);
            if (!stats) { sendResponse({ success: false, error: 'refresh_failed' }); break; }
            accounts[idx] = { ...accounts[idx], ...stats };
          }

          await saveAccounts(accounts);
          // 刷新后重新读取 currentKey，避免 refreshOneAccount 临时切换后状态混乱
          const freshKey = await detectCurrentKey();
          sendResponse({ success: true, account: accounts[idx], accounts, currentSessionKey: freshKey });
          break;
        }

        case 'GET_DEBUG_INFO': {
          const tab = await getClaudeTab();
          const [accInfo, usage] = await Promise.all([fetchAccountInfo(tab), fetchUsage(tab)]);
          sendResponse({ accInfo, usage, raw: usage._raw, hasTab: !!tab });
          break;
        }

        case 'SESSION_BANNER_UPDATE': {
          if (msg.banner && msg.banner.sourceKey) {
            const accounts2 = await getAccounts();
            const sourceKey = msg.banner.sourceKey;
            // 核心改进：只要来源 key 是我们保存过的，就允许静默更新状态，实现真正的全账户监控
            const idx2 = accounts2.findIndex(a => a.sessionKey === sourceKey);
            
            if (idx2 >= 0) {
              let updated = false;
              if (msg.banner.limited) {
                accounts2[idx2].sessionBanner = { ...(accounts2[idx2].sessionBanner || {}), ...msg.banner };
                accounts2[idx2].sessionBannerAt = Date.now();
                accounts2[idx2].usage = accounts2[idx2].usage || {};
                accounts2[idx2].usage.free_limit = {
                  resets_at: msg.banner.resets_at || (accounts2[idx2].usage.free_limit?.resets_at) || null,
                  limited: true,
                  text: msg.banner.text || null,
                  detectedAt: Date.now()
                };
                updated = true;
              } else if (accounts2[idx2].sessionBanner && accounts2[idx2].sessionBanner.limited) {
                // 如果页面检测明确说没限流了，且满足过期/陈旧条件，则清理状态
                const ex = accounts2[idx2].sessionBanner;
                const now = Date.now();
                const isExp = ex.resets_at && new Date(ex.resets_at).getTime() <= now;
                const isStale = accounts2[idx2].sessionBannerAt && (now - accounts2[idx2].sessionBannerAt > 5 * 3600 * 1000);
                const isLikelyWrong = ex.resets_at && (new Date(ex.resets_at).getTime() - now > 24 * 3600000);

                if (isExp || isStale || isLikelyWrong || !ex.resets_at) {
                  accounts2[idx2].sessionBanner.limited = false;
                  accounts2[idx2].sessionBanner.resets_at = null;
                  if (accounts2[idx2].usage && accounts2[idx2].usage.free_limit) {
                    accounts2[idx2].usage.free_limit.limited = false;
                    accounts2[idx2].usage.free_limit.resets_at = null;
                  }
                  updated = true;
                }
              }
              
              if (msg.banner.pct != null) {
                accounts2[idx2].sessionBanner = accounts2[idx2].sessionBanner || {};
                if (accounts2[idx2].sessionBanner.pct !== msg.banner.pct) {
                  accounts2[idx2].sessionBanner.pct = msg.banner.pct;
                  accounts2[idx2].sessionBannerAt = Date.now();
                  updated = true;
                }
              }
              
              if (updated) {
                await saveAccounts(accounts2);
                const currentKey2 = await detectCurrentKey();
                // 广播更新以便 UI 响应
                chrome.runtime.sendMessage({ type: 'ACCOUNT_UPDATED', currentSessionKey: currentKey2 }).catch(() => {});
              }
            }
          }
          sendResponse({ ok: true });
          break;
        }

        case 'GET_SESSION_BANNER': {
          const tab2 = await getClaudeTab();
          if (!tab2) { sendResponse({ pct: null, limited: false }); break; }
          try {
            const r2 = await withTimeout(
              chrome.tabs.sendMessage(tab2.id, { type: 'GET_SESSION_BANNER' }),
              5000
            );
            const currentKey3 = await detectCurrentKey();
            let finalBanner = r2 || { pct: null, limited: false };
            
            // 只有来源匹配才做处理
            if (currentKey3 && r2 && (!r2.sourceKey || r2.sourceKey === currentKey3)) {
              const accounts3 = await getAccounts();
              const idx3 = accounts3.findIndex(a => a.sessionKey === currentKey3);
              if (idx3 >= 0) {
                if (r2.limited || r2.pct != null) {
                  accounts3[idx3].sessionBanner = { ...(accounts3[idx3].sessionBanner || {}), ...r2 };
                  accounts3[idx3].sessionBannerAt = Date.now();
                }
                if (!r2.limited && accounts3[idx3].sessionBanner && accounts3[idx3].sessionBanner.limited) {
                  const ex = accounts3[idx3].sessionBanner;
                  const isExp = ex.resets_at && new Date(ex.resets_at).getTime() <= Date.now();
                  const isStale = accounts3[idx3].sessionBannerAt && (Date.now() - accounts3[idx3].sessionBannerAt > 5 * 3600 * 1000);
                  if (isExp || isStale) {
                    accounts3[idx3].sessionBanner.limited = false;
                    accounts3[idx3].sessionBanner.resets_at = null;
                    if (accounts3[idx3].usage && accounts3[idx3].usage.free_limit) {
                      accounts3[idx3].usage.free_limit.limited = false;
                    }
                  }
                }
                await saveAccounts(accounts3);
                finalBanner = accounts3[idx3].sessionBanner || r2;
              }
            }
            sendResponse(finalBanner);
          } catch { sendResponse({ pct: null, limited: false }); }
          break;
        }

        default: sendResponse({ error: 'unknown_type' });
      }
    } catch (e) {
      console.error('[Claude Switcher BG]', e);
      sendResponse({ error: e.message });
    }
  })();
  return true;
});

// ── 自动刷新（每 10 分钟）──
chrome.alarms.create('autoRefresh', { periodInMinutes: 10 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'autoRefresh') return;
  try {
    const currentKey = await detectCurrentKey();
    if (!currentKey) return;
    const tab = await getClaudeTab();
    if (!tab) return;
    const [accInfo, usage] = await Promise.all([fetchAccountInfo(tab), fetchUsage(tab)]);
    const accounts = await getAccounts();
    for (let i = 0; i < accounts.length; i++) {
      if (accounts[i].sessionKey === currentKey) {
        accounts[i] = {
          ...accounts[i],
          email: accInfo.email || accounts[i].email,
          plan: (accInfo.plan && accInfo.plan !== 'Unknown') ? accInfo.plan : accounts[i].plan,
          ...(accInfo.valid !== null ? { valid: accInfo.valid } : {}),
          usage: { five_hour: usage.five_hour, seven_day: usage.seven_day, message_limit: usage.message_limit, free_limit: usage.free_limit },
          refreshedAt: Date.now()
        };
      }
    }
    await saveAccounts(accounts);
  } catch (e) { console.error('[Switcher] alarm error', e); }
});



// 页面加载完成后更新 lastUsed
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || !tab.url.startsWith('https://claude.ai')) return;
  if (tab.url.includes('dashboard.html') || tab.url === 'https://claude.ai/login') return;
  try {
    const currentKey = await detectCurrentKey();
    if (!currentKey) return;
    const accounts = await getAccounts();
    const idx = accounts.findIndex(a => a.sessionKey === currentKey);
    if (idx >= 0) { accounts[idx].lastUsed = Date.now(); await saveAccounts(accounts); }
  } catch {}
});

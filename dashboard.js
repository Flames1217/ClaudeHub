// dashboard.js v10 - ClaudeHub (Fixed)
// 修复：语法错误、sessionBanner检测、addAuto tabId传递、大面板加载死循环

const COLORS = ['#cc785c','#5c8acc','#5cac78','#ac5c8a','#7c5cac','#5c8a8a','#8a5c5c','#ac8a5c','#4a90a4','#7a9e3e'];
function avatarColor(s) { let h=0; for(let i=0;i<s.length;i++) h=s.charCodeAt(i)+((h<<5)-h); return COLORS[Math.abs(h)%COLORS.length]; }
function initial(s) { return s ? s[0].toUpperCase() : '?'; }
function timeAgo(ts) {
  if (!ts) return '从未';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d/60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d/3600000)} 小时前`;
  return `${Math.floor(d/86400000)} 天前`;
}
function fmtAbsTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function fmtReset(iso) {
  if (!iso) return '';
  const diff = new Date(iso) - Date.now();
  if (diff <= 0) return '即将重置';
  const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000);
  if (h > 48) return `${Math.floor(h/24)} 天后重置`;
  if (h > 0) return `${h}h ${m}m 后重置`;
  return `${m} 分钟后重置`;
}

function send(type, data={}) { return chrome.runtime.sendMessage({type, ...data}); }
function toast(msg, dur=2400) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}
function planClass(plan) {
  if (!plan) return 'b-unk';
  const p = plan.toLowerCase();
  if (p.includes('max')) return 'b-max';
  if (p.includes('enterprise')) return 'b-ent';
  if (p.includes('team')) return 'b-team';
  if (p.includes('pro')) return 'b-pro';
  if (p.includes('free')) return 'b-free';
  return 'b-unk';
}
function planEmoji(plan) {
  if (!plan) return '';
  const p = plan.toLowerCase();
  if (p.includes('max')) return '⚡';
  if (p.includes('enterprise')) return '🏢';
  if (p.includes('team')) return '👥';
  if (p.includes('pro')) return '✨';
  if (p.includes('free')) return '🆓';
  return '';
}

// ── State ──
let accounts = [], currentKey = null, refreshing = false, isSwitching = false;
let rawDebugData = null;
const refreshingSet = new Set();

// ── Navigation ──
function goPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${name}`)?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${name}"]`)?.classList.add('active');
}
window.goPage = goPage;
document.querySelectorAll('.nav-item').forEach(n => n.addEventListener('click', () => goPage(n.dataset.page)));

// ── Load ──
async function load() {
  try {
    const r = await send('GET_ACCOUNTS');
    accounts = r.accounts || [];
    currentKey = r.currentSessionKey;
    renderAccounts();
  } catch(e) {
    console.error('[Dashboard] load error:', e);
    // 即使出错也清除 loading 状态
    const grid = document.getElementById('acc-grid');
    if (grid) grid.innerHTML = '<div style="text-align:center;padding:40px;color:#d04040">加载失败，请刷新页面</div>';
  }
}

// ── 静默检测当前账号（已废弃：这会导致疯狂刷新和脏数据） ──
// 配合 background.js 的 ACCOUNT_UPDATED 全权接管状态更新

// ── 冷却状态渲染（大面板）──
// 优先级：sessionBanner > usage.resets_at > free_limit.limited > 正常
function renderUsageArea(acc, isActive) {
  const usage = acc.usage;
  const now = Date.now();
  const banner = acc.sessionBanner;

  // 1. 优先检查 sessionBanner（DOM 实时检测）
  if (banner && banner.limited) {
    let isExpired = false;
    if (banner.resets_at) {
      isExpired = new Date(banner.resets_at) - now <= 0;
    }
    if (!isExpired) {
      if (banner.resets_at) {
        const absTime = fmtAbsTime(banner.resets_at);
        const diff = new Date(banner.resets_at) - now;
        const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000);
        const countdown = h > 48 ? `${Math.floor(h/24)} 天后` : h > 0 ? `${h}h ${m}m 后` : `${m} 分钟后`;
        return `<div class="usage-area usage-area-single">
          <div class="cooldown-banner-red">
            <span style="font-size:18px;flex-shrink:0">⏸</span>
            <div>
              <div class="cd-title">冷却中 · <strong>${countdown}</strong>恢复</div>
              <div class="cd-time">📅 ${absTime} 可再次使用（页面检测：${banner.text || '已达限制'}）</div>
            </div>
          </div>
        </div>`;
      }
      return `<div class="usage-area usage-area-single">
        <div class="cooldown-banner-red">
          <span style="font-size:18px;flex-shrink:0">⏸</span>
          <div>
            <div class="cd-title">冷却中 · 重置时间未知</div>
            <div class="cd-time">${banner.text || '页面检测到限制提示'}</div>
          </div>
        </div>
      </div>`;
    }
  }

  const hasAnyUsage = (usage && (usage.five_hour || usage.seven_day || usage.message_limit || usage.free_limit)) || (banner && banner.pct != null);
  if (!hasAnyUsage) {
    return `<div class="usage-area usage-area-single">
      <div class="cooldown-banner-green">✅ 当前可正常使用（暂无配额数据，点「⟳ 刷新」获取）</div>
    </div>`;
  }

  // 2. API 返回的冷却时间
  const cooldownItems = [];
  const check = (block, label) => {
    if (block?.resets_at && new Date(block.resets_at) - now > 0)
      cooldownItems.push({ resets_at: block.resets_at, label });
  };
  check(usage?.free_limit, '免费配额');
  check(usage?.message_limit, '消息配额');
  check(usage?.five_hour, '5小时配额');
  check(usage?.seven_day, '7天配额');
  cooldownItems.sort((a, b) => new Date(a.resets_at) - new Date(b.resets_at));
  const earliest = cooldownItems[0] || null;

  const blocks = [];
  if (usage?.five_hour)     blocks.push(renderUsageBlock('⏱ 5小时配额', usage.five_hour));
  if (usage?.seven_day)     blocks.push(renderUsageBlock('📅 7天配额',   usage.seven_day));
  if (usage?.message_limit) blocks.push(renderUsageBlock('💬 消息配额',  usage.message_limit));
  if (usage?.free_limit)    blocks.push(renderUsageBlock('🆓 免费限额',  usage.free_limit));
  
  // 添加页面检测到的会话进度
  if (banner && banner.pct != null) {
    blocks.push(renderUsageBlock('会话用量（页面检测）', { utilization: banner.pct }));
  }

  const cols = blocks.length <= 1 ? '1fr' : blocks.length === 2 ? '1fr 1fr' : '1fr 1fr 1fr';

  let bannerHtml = '';
  if (earliest) {
    const absTime = fmtAbsTime(earliest.resets_at);
    const diff = new Date(earliest.resets_at) - now;
    const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000);
    const countdown = h > 48 ? `${Math.floor(h/24)} 天后` : h > 0 ? `${h}h ${m}m 后` : `${m} 分钟后`;
    bannerHtml = `<div style="grid-column:1/-1">
      <div class="cooldown-banner-red">
        <span style="font-size:18px;flex-shrink:0">⏸</span>
        <div>
          <div class="cd-title">冷却中 · <strong>${countdown}</strong>恢复</div>
          <div class="cd-time">📅 ${absTime} 可再次使用</div>
        </div>
      </div>
    </div>`;
  } else if (usage?.free_limit?.limited) {
    bannerHtml = `<div style="grid-column:1/-1">
      <div class="cooldown-banner-red">
        <span style="font-size:18px;flex-shrink:0">⏸</span>
        <div>
          <div class="cd-title">冷却中 · 重置时间未知</div>
          <div class="cd-time">切换到该账号后可获取具体时间</div>
        </div>
      </div>
    </div>`;
  } else if (banner && banner.pct >= 90) {
    bannerHtml = `<div style="grid-column:1/-1">
      <div class="cooldown-banner-red" style="background:#fff2f0;border-color:#ffccc7;border-style:dashed;">
        <span style="font-size:18px;flex-shrink:0">⚠️</span>
        <div>
          <div class="cd-title" style="color:#cf1322">即将达到限制 · <strong>${banner.pct}%</strong></div>
          <div class="cd-time">页面检测到会话额度即将耗尽（${banner.text || '实时提示'}）</div>
        </div>
      </div>
    </div>`;
  } else {
    bannerHtml = `<div style="grid-column:1/-1">
      <div class="cooldown-banner-green">✅ 当前可正常使用</div>
    </div>`;
  }

  const staleNote = !isActive
    ? `<div style="grid-column:1/-1"><div class="usage-stale-note">📌 来自上次刷新 · 点「⟳ 刷新」更新</div></div>`
    : '';

  return `<div class="usage-area" style="grid-template-columns:${cols}">
    ${bannerHtml}
    ${blocks.join('')}
    ${staleNote}
  </div>`;
}

function renderUsageBlock(label, data) {
  if (!data) return `<div class="usage-block"><div class="usage-lbl">${label}</div><div class="usage-na">—</div></div>`;
  const pct = data.utilization != null ? Math.round(data.utilization) : null;
  const cls = pct != null ? (pct >= 90 ? 'bar-danger' : pct >= 65 ? 'bar-warn' : 'bar-ok') : 'bar-ok';
  const total = data.total, used = data.used;
  const remaining = data.remaining != null ? data.remaining : (total != null && used != null ? total - used : null);
  const resetStr = fmtReset(data.resets_at);
  return `<div class="usage-block">
    <div class="usage-lbl">${label}</div>
    ${pct != null ? `<div class="usage-bar-wrap"><div class="usage-bar ${cls}" style="width:${Math.min(pct,100)}%"></div></div>` : ''}
    <div class="usage-nums">
      ${pct != null ? `<span class="used">${pct}% 已用</span>` : ''}
      ${remaining != null ? `<span>${remaining.toLocaleString()} 剩余${total ? ` / ${total.toLocaleString()}` : ''}</span>` : ''}
    </div>
    ${resetStr ? `<div class="usage-reset">🔄 ${resetStr}</div>` : ''}
  </div>`;
}

// ── Render accounts ──
function renderAccounts() {
  const grid = document.getElementById('acc-grid');
  if (!grid) return;
  const currentAcc = accounts.find(a => a.sessionKey === currentKey);
  document.getElementById('tb-count').textContent = `共 ${accounts.length} 个账号`;
  document.getElementById('acc-sub').textContent = `${accounts.length} 个账号 · 当前: ${currentAcc?.email || currentAcc?.nickname || '无'}`;

  if (accounts.length === 0) {
    grid.innerHTML = `<div style="text-align:center;padding:60px;color:#aaa;background:#fff;border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.07)">
      <div style="font-size:48px;margin-bottom:14px">👤</div>
      <div style="font-size:16px;font-weight:600;color:#666;margin-bottom:8px">还没有账号</div>
      <button class="btn btn-primary" id="btn-goto-add">＋ 添加第一个账号</button>
    </div>`;
    document.getElementById('btn-goto-add')?.addEventListener('click', () => goPage('add'));
    return;
  }
  grid.innerHTML = accounts.map(acc => renderAccCard(acc)).join('');
  bindCardEvents();
}

function renderAccCard(acc) {
  const isActive = acc.sessionKey === currentKey;
  const displayName = acc.nickname || acc.email || '未知账号';
  const color = avatarColor(displayName);
  const plan = acc.plan || 'Unknown';
  const isRefreshing = refreshingSet.has(acc.sessionKey);

    const email = acc.email || '';
    const nick = acc.nickname || '';
    const name = acc.name || '';
    
    let isCustomNick = nick && nick !== email && nick !== name && nick !== '未知账号';
    let mainLabel = isCustomNick ? nick : (name || email || '未知账号');
    
    let subTexts = [];
    if (name && name !== mainLabel) subTexts.push(`👤 ${name}`);
    if (email && email !== mainLabel) subTexts.push(`✉️ ${email}`);
    const subBlock = subTexts.length > 0 ? `<div class="acc-email" style="margin-top:4px;color:#777;font-size:12px;">${subTexts.join(' &nbsp;&nbsp; ')}</div>` : '';

    return `<div class="acc-card ${isActive ? 'active-acc' : ''}" data-key="${acc.sessionKey}">
      <div class="acc-card-head">
        <div class="acc-avatar" style="background:${color}">${initial(mainLabel)}</div>
        <div class="acc-info">
          <div class="acc-name">${isActive ? '<span class="ldot"></span>' : ''}<span>${mainLabel}</span></div>
          ${subBlock}
          <div class="acc-meta">
          ${isActive ? '<span class="badge b-active">✓ 当前使用中</span>' : ''}
          <span class="badge ${planClass(plan)}">${planEmoji(plan)} ${plan}</span>
          <span style="font-size:11px;color:#bbb;margin-left:4px">同步于 ${timeAgo(acc.refreshedAt)}</span>
        </div>
      </div>
      <div class="acc-actions">
        ${!isActive ? `<button class="btn btn-primary btn-switch-acc" data-key="${acc.sessionKey}">切换</button>` : ''}
        <button class="btn btn-secondary btn-refresh-one" data-key="${acc.sessionKey}" ${isRefreshing ? 'disabled' : ''}>
          ${isRefreshing ? '<span class="spin"></span>' : '⟳ 刷新'}
        </button>
        <button class="btn btn-danger btn-del-acc" data-key="${acc.sessionKey}">删除</button>
      </div>
    </div>
    ${renderInfoGrid(acc)}
    ${renderUsageArea(acc, isActive)}
  </div>`;
}

function renderInfoGrid(acc) {
  const userId = acc.userId || '—';
  const sessionShort = acc.sessionKey ? acc.sessionKey.substring(0, 22) + '...' : '—';
  return `<div class="info-grid">
    <div class="info-cell">
      <div class="info-lbl">用户 ID</div>
      <div class="info-val" style="font-size:11px;font-family:monospace;word-break:break-all">${userId}</div>
    </div>
    <div class="info-cell">
      <div class="info-lbl">Session Key</div>
      <div class="info-val" style="font-size:11px;font-family:monospace">${sessionShort}</div>
      <div class="info-sub info-copy" data-copy="${acc.sessionKey}" style="cursor:pointer;color:var(--brand)">点击复制</div>
    </div>
    <div class="info-cell">
      <div class="info-lbl">添加时间</div>
      <div class="info-val">${timeAgo(acc.addedAt)}</div>
    </div>
    <div class="info-cell">
      <div class="info-lbl">最近使用</div>
      <div class="info-val">${timeAgo(acc.lastUsed)}</div>
    </div>
  </div>`;
}

// ── Bind events ──
function bindCardEvents() {
  document.querySelectorAll('.btn-switch-acc').forEach(btn =>
    btn.addEventListener('click', () => doSwitch(btn.dataset.key))
  );
  document.querySelectorAll('.btn-refresh-one').forEach(btn =>
    btn.addEventListener('click', () => doRefreshOne(btn.dataset.key))
  );
  document.querySelectorAll('.btn-del-acc').forEach(btn =>
    btn.addEventListener('click', () => doDelete(btn.dataset.key))
  );
  document.querySelectorAll('.info-copy').forEach(el =>
    el.addEventListener('click', () => {
      navigator.clipboard.writeText(el.dataset.copy).then(() => toast('✓ Session Key 已复制'));
    })
  );
}

// ── Switch ──
async function doSwitch(key) {
  const acc = accounts.find(a => a.sessionKey === key);
  if (!acc) return;
  if (!confirm(`切换到「${acc.nickname || acc.email || '该账号'}」？\nclaude.ai 将跳转到首页。`)) return;
  
  isSwitching = true;
  // 乐观更新 UI：立即将焦点切给新账号
  const oldKey = currentKey;
  currentKey = key;
  renderAccounts();
  
  const card = document.querySelector(`.acc-card[data-key="${key}"]`);
  if (card) {
    const badge = card.querySelector('.b-active');
    if (badge) badge.innerHTML = '<span class="spin" style="width:10px;height:10px;border-width:2px;margin-right:4px;border-top-color:#1a7a46"></span>切换中';
  }

  toast('切换中...', 4000);
  const r = await send('SWITCH_ACCOUNT', { account: acc });
  if (r?.success) {
    setTimeout(async () => {
      const fresh = await send('GET_ACCOUNTS');
      accounts = fresh.accounts || [];
      currentKey = fresh.currentSessionKey;
      isSwitching = false;
      renderAccounts();
    }, 800);
    toast('✓ 切换成功');
  } else {
    isSwitching = false;
    currentKey = oldKey; // 回滚 UI
    renderAccounts();
    toast('切换失败，请重试');
  }
}

// ── 独立刷新 ──
async function doRefreshOne(key) {
  if (refreshingSet.has(key)) return;
  refreshingSet.add(key);
  const lockedKey = currentKey;
  renderAccounts();
  toast('正在刷新账号数据...', 5000);
  const r = await send('REFRESH_ONE_ACCOUNT', { sessionKey: key });
  refreshingSet.delete(key);
  if (r?.success) {
    accounts = r.accounts;
    currentKey = lockedKey;
    renderAccounts();
    toast('✓ 刷新完成');
  } else {
    toast('刷新失败：' + (r?.error || '未知错误'));
    currentKey = lockedKey;
    renderAccounts();
  }
}

// ── 刷新全部 ──
async function doRefresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = document.getElementById('tb-refresh');
  const icon = document.getElementById('refresh-icon');
  if (btn) btn.disabled = true;
  if (icon) icon.innerHTML = '<span class="spin"></span>';
  toast('刷新配额中...', 4000);
  const r = await send('REFRESH_ALL_STATS');
  if (r?.success) { accounts = r.accounts; currentKey = r.currentSessionKey; renderAccounts(); toast('✓ 刷新完成'); }
  else toast('刷新失败');
  if (btn) btn.disabled = false;
  if (icon) icon.textContent = '⟳';
  refreshing = false;
}
window.doRefresh = doRefresh;
document.getElementById('tb-refresh')?.addEventListener('click', doRefresh);

// ── Delete ──
async function doDelete(key) {
  const acc = accounts.find(a => a.sessionKey === key);
  if (!acc) return;
  if (!confirm(`删除「${acc.nickname || acc.email || '该账号'}」？此操作不可恢复。`)) return;
  const r = await send('DELETE_ACCOUNT', { sessionKey: key });
  accounts = r.accounts;
  toast('已删除');
  renderAccounts();
}

// ── 获取当前激活的 claude.ai 标签 ──
function getActiveCloudeTab(tabs) {
  const sorted = [...tabs].sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  return sorted[0] || null;
}

// ── Add account ──
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  const tab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
  document.getElementById('tab-auto').style.display = tab === 'auto' ? 'block' : 'none';
  document.getElementById('tab-manual').style.display = tab === 'manual' ? 'block' : 'none';
  setAddStatus('', '');
}));

function setAddStatus(type, msg) {
  const el = document.getElementById('add-status');
  if (!el) return;
  el.className = 'status-msg' + (type ? ` ${type}` : '');
  el.textContent = msg;
}

async function saveNewAccountDash(r, nick) {
  const cookieKey = r.sessionKey;
  const apiEmail = r.email || '';
  const apiUserId = r.userId || '';

  // ── 核心修复：用 email/userId 匹配账号身份，而非仅靠 sessionKey ──
  // 与 popup.js 相同的修复逻辑

  // 1. 按 email 匹配
  let matched = null;
  if (apiEmail) {
    matched = accounts.find(a => a.email && a.email === apiEmail);
  }
  // 2. 按 userId 匹配
  if (!matched && apiUserId) {
    matched = accounts.find(a => a.userId && a.userId === apiUserId);
  }

  if (matched) {
    let changed = false;

    if (matched.sessionKey !== cookieKey) {
      const conflict = accounts.find(a => a !== matched && a.sessionKey === cookieKey);
      if (conflict) {
        conflict.valid = false;
        await send('SAVE_ACCOUNT', { account: conflict });
      }
      matched.sessionKey = cookieKey;
      changed = true;
    }

    if (r.name && r.name !== matched.name) { matched.name = r.name; changed = true; }
    if (r.plan && r.plan !== 'Unknown' && r.plan !== matched.plan) { matched.plan = r.plan; changed = true; }
    if (nick && nick !== matched.nickname) { matched.nickname = nick; changed = true; }
    matched.valid = true;
    matched.refreshedAt = Date.now();

    if (changed) {
      await send('SAVE_ACCOUNT', { account: matched });
      const fresh = await send('GET_ACCOUNTS');
      accounts = fresh.accounts || accounts;
      currentKey = cookieKey;
      setAddStatus('ok', `✓ 已更新：${matched.nickname || matched.email}`);
      renderAccounts();
    } else {
      setAddStatus('err', '该账号已存在');
    }
    return;
  }

  // 3. 全新账号，检查 sessionKey 冲突
  const existingByKey = accounts.find(a => a.sessionKey === cookieKey);
  if (existingByKey) {
    if (apiEmail && existingByKey.email && existingByKey.email !== apiEmail) {
      existingByKey.valid = false;
      await send('SAVE_ACCOUNT', { account: existingByKey });
    } else if (!apiEmail || existingByKey.email === apiEmail) {
      setAddStatus('err', '该账号已存在');
      return;
    }
  }

  const saveR = await send('SAVE_ACCOUNT', { account: {
    sessionKey: cookieKey, email: apiEmail, name: r.name || '',
    nickname: nick || apiEmail || r.name || '未知账号',
    plan: r.plan || 'Unknown', userId: apiUserId,
    valid: true, usage: r.usage || null,
    cookies: r.cookies, addedAt: Date.now(), lastUsed: Date.now(), refreshedAt: Date.now()
  }});
  accounts = saveR.accounts; currentKey = cookieKey;
  document.getElementById('auto-nick').value = '';
  setAddStatus('ok', `✓ 已添加：${nick || apiEmail || '新账号'}`);
  renderAccounts(); toast('✓ 账号添加成功');
}

document.getElementById('btn-auto-add')?.addEventListener('click', async () => {
  const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  const validTabs = claudeTabs.filter(t =>
    !t.url.includes('dashboard.html') && !t.url.includes('/login')
  );
  const btn = document.getElementById('btn-auto-add');
  const nick = document.getElementById('auto-nick').value.trim();

  if (!validTabs.length) {
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 等待登录...';
    setAddStatus('info', '已打开登录页，请在新标签中完成登录，登录后将自动添加账号...');
    const loginTab = await chrome.tabs.create({ url: 'https://claude.ai/login' });
    let resolved = false;
    const listener = async (tabId, changeInfo, tab) => {
      if (tabId !== loginTab.id || changeInfo.status !== 'complete') return;
      if (!tab.url || tab.url.includes('/login') || tab.url.includes('/callback')) return;
      if (!tab.url.startsWith('https://claude.ai')) return;
      if (resolved) return;
      resolved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      await new Promise(r => setTimeout(r, 1000));
      const r = await send('FETCH_ACCOUNT_INFO', { tabId: loginTab.id });
      btn.disabled = false; btn.innerHTML = '⚡ 自动抓取当前登录';
      if (!r?.sessionKey) { setAddStatus('err', '获取登录信息失败，请重试'); return; }
      await saveNewAccountDash(r, nick);
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        btn.disabled = false; btn.innerHTML = '⚡ 自动抓取当前登录';
        setAddStatus('err', '登录超时，请重试');
      }
    }, 60000);
    return;
  }

  // 已有登录标签 —— 传 tabId 确保从正确上下文获取
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 获取中...';
  setAddStatus('info', '正在读取登录信息...');
  const targetTab = getActiveCloudeTab(validTabs);
  const r = await send('FETCH_ACCOUNT_INFO', { tabId: targetTab?.id || null });
  btn.disabled = false; btn.innerHTML = '⚡ 自动抓取当前登录';
  if (!r?.sessionKey) { setAddStatus('err', '未检测到登录状态，请先登录 claude.ai。'); return; }
  await saveNewAccountDash(r, nick);
});

document.getElementById('btn-manual-add')?.addEventListener('click', async () => {
  const emailVal = document.getElementById('m-email').value.trim();
  const sessionVal = document.getElementById('m-session').value.trim();
  if (!emailVal) { setAddStatus('err', '请输入邮箱或备注名称'); return; }
  if (!sessionVal) { setAddStatus('err', '请输入 Session Key'); return; }
  if (!sessionVal.startsWith('sk-ant-')) { setAddStatus('err', 'Session Key 格式不正确'); return; }
  if (accounts.find(a => a.sessionKey === sessionVal)) { setAddStatus('err', '该账号已存在'); return; }
  const saveR = await send('SAVE_ACCOUNT', { account: {
    sessionKey: sessionVal, email: emailVal.includes('@') ? emailVal : '',
    nickname: emailVal, plan: 'Unknown', valid: true,
    cookies: null, manualAdded: true, addedAt: Date.now(), lastUsed: null
  }});
  accounts = saveR.accounts;
  document.getElementById('m-email').value = '';
  document.getElementById('m-session').value = '';
  setAddStatus('ok', `✓ 已添加：${emailVal}`);
  renderAccounts(); toast('✓ 账号添加成功');
});

// ── Debug ──
document.getElementById('btn-run-debug')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('debug-status');
  const cardsEl = document.getElementById('debug-cards');
  const rawWrapEl = document.getElementById('debug-raw-wrap');
  const btn = document.getElementById('btn-run-debug');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 检测中...';
  statusEl.textContent = '正在请求各 API 端点...'; statusEl.style.color = '#888';
  const r = await send('GET_DEBUG_INFO');
  btn.disabled = false; btn.innerHTML = '▶ 运行 API 检测';
  rawDebugData = r;
  if (!r || r.error) {
    statusEl.textContent = '⚠ 检测失败：' + (r?.error || '未知错误');
    statusEl.style.color = '#d04040'; return;
  }
  document.getElementById('dbg-accinfo').textContent = JSON.stringify(r.accInfo, null, 2);
  document.getElementById('dbg-usage').textContent = JSON.stringify({ five_hour: r.usage?.five_hour, seven_day: r.usage?.seven_day, message_limit: r.usage?.message_limit }, null, 2);
  const raw = r.raw || {};
  const chips = document.getElementById('debug-endpoint-chips');
  chips.innerHTML = '';
  let rawText = '';
  for (const [ep, data] of Object.entries(raw)) {
    const isNull = data === null || data === undefined;
    const isErr = data && (data._status >= 400 || data._error);
    chips.innerHTML += `<span class="status-chip ${isNull || isErr ? 'chip-err' : 'chip-ok'}">${ep.split('/').pop()} ${isNull ? 'null' : isErr ? data._status || 'err' : '✓'}</span>`;
    rawText += `\n${'─'.repeat(50)}\n📡 ${ep}\n${'─'.repeat(50)}\n${JSON.stringify(data, null, 2)}\n`;
  }
  document.getElementById('dbg-raw').textContent = rawText;
  cardsEl.style.display = 'grid'; rawWrapEl.style.display = 'block';
  statusEl.textContent = `✓ 检测完成 · 账号: ${r.accInfo?.email || '未知'}`;
  statusEl.style.color = '#2e9e62';
});
document.getElementById('btn-copy-debug')?.addEventListener('click', () => {
  if (!rawDebugData) { toast('请先运行 API 检测'); return; }
  navigator.clipboard.writeText(JSON.stringify(rawDebugData, null, 2)).then(() => toast('✓ 已复制'));
});

// ── Settings ──
document.getElementById('btn-clear-all')?.addEventListener('click', async () => {
  if (!confirm('确定要清空所有账号数据吗？')) return;
  await chrome.storage.local.clear();
  accounts = []; currentKey = null; renderAccounts(); toast('✓ 已清空');
});

window.copyText = function(text, msg) { navigator.clipboard.writeText(text).then(() => toast(msg || '已复制')); };

// ── Export & Import ──
document.getElementById('btn-export-data')?.addEventListener('click', async () => {
  if (accounts.length === 0) { toast('没有可导出的数据'); return; }
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: `claude_accounts_${new Date().toISOString().substring(0, 10)}.json`,
        types: [{ description: 'JSON 数据备份', accept: { 'application/json': ['.json'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(accounts, null, 2));
      await writable.close();
      toast('✓ 已导出数据备份');
    } else {
      // Fallback
      const blob = new Blob([JSON.stringify(accounts, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `claude_accounts_${new Date().toISOString().substring(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('✓ 已导出数据备份');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Export error:', err);
      toast('导出失败');
    }
  }
});

document.getElementById('btn-import-data')?.addEventListener('click', () => {
  document.getElementById('file-import-data')?.click();
});

document.getElementById('file-import-data')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error('Invalid format');
    
    const existing = await chrome.storage.local.get('accounts');
    const current = existing.accounts || [];
    const map = new Map(current.map(a => [a.sessionKey, a]));
    imported.forEach(a => { if (a.sessionKey) map.set(a.sessionKey, a); });
    const merged = Array.from(map.values());
    
    await chrome.storage.local.set({ accounts: merged });
    
    const r = await send('GET_ACCOUNTS');
    accounts = r.accounts || [];
    currentKey = r.currentSessionKey;
    renderAccounts();
    
    toast(`✓ 成功导入 ${imported.length} 个账号`);
  } catch (err) {
    toast('导入失败：文件格式不正确');
    console.error(err);
  }
  e.target.value = '';
});

// ── Init ──
load();
document.getElementById('btn-goto-add')?.addEventListener('click', () => goPage('add'));
document.getElementById('tb-open-claude')?.addEventListener('click', () => chrome.tabs.create({ url: 'https://claude.ai' }));

// 删除所有定时检测，由后台单源真相推送

// 监听即时广播（消除切号延迟）
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'ACCOUNT_UPDATED') {
    if (msg.currentSessionKey) {
      currentKey = msg.currentSessionKey;
      const r = await send('GET_ACCOUNTS');
      if (r?.accounts) accounts = r.accounts;
      renderAccounts();
    } else {
      load(); // 兜底全量刷新
    }
  }
});

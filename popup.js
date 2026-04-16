// popup.js v10 - Claude Switcher (Fixed)
// 修复：重复声明、sessionBanner检测位置、addAuto tabId传递、当前账号识别

const COLORS = ['#cc785c','#5c8acc','#5cac78','#ac5c8a','#7c5cac','#5c8a8a','#8a5c5c','#ac8a5c','#4a90a4','#7a9e3e'];
function avatarColor(s) { let h=0; for(let i=0;i<s.length;i++) h=s.charCodeAt(i)+((h<<5)-h); return COLORS[Math.abs(h)%COLORS.length]; }
function initial(s) { return s ? s[0].toUpperCase() : '?'; }
function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return `${Math.floor(d/60000)}m前`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h前`;
  return `${Math.floor(d/86400000)}d前`;
}
function fmtAbsTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth()+1}月${d.getDate()}日 ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function fmtCountdown(iso) {
  if (!iso) return '';
  const diff = new Date(iso) - Date.now();
  if (diff <= 0) return '即将恢复';
  const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000);
  if (h > 48) return `${Math.floor(h/24)}天后`;
  if (h > 0) return `${h}h${m}m后`;
  return `${m}分钟后`;
}

function send(type, data={}) { return chrome.runtime.sendMessage({type, ...data}); }

function toast(msg, dur=2200) {
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

// ── 渲染冷却/配额状态（小面板）──
// 优先级：sessionBanner(DOM实时) > usage.resets_at > free_limit.limited > 进度条 > 绿色
function renderMiniUsage(acc) {
  const usage = acc.usage;
  const now = Date.now();

  // 1. 优先检查 sessionBanner（DOM 实时检测到的限制提示，最准确）
  const banner = acc.sessionBanner;
  let isExpired = false;
  if (banner?.resets_at) {
    isExpired = new Date(banner.resets_at).getTime() <= now;
  }

  if (banner && banner.limited && !isExpired) {
    if (banner.resets_at) {
      return `<div class="usage-cooldown">⏸ 冷却中 · ${fmtAbsTime(banner.resets_at)}恢复（${fmtCountdown(banner.resets_at)}）</div>`;
    }
    return `<div class="usage-cooldown">⏸ 冷却中 · 重置时间未知</div>`;
  }

  const slots = usage ? [usage.free_limit, usage.message_limit, usage.five_hour, usage.seven_day] : [];

  // 2. 找最早的有效冷却时间（API返回的 resets_at）
  const activeCooldowns = slots
    .map(s => s?.resets_at)
    .filter(r => r && new Date(r) - now > 0)
    .sort();

  if (activeCooldowns.length > 0) {
    const earliest = activeCooldowns[0];
    return `<div class="usage-cooldown">⏸ 冷却中 · ${fmtAbsTime(earliest)}恢复（${fmtCountdown(earliest)}）</div>`;
  }

  // 3. free_limit 检测到限制但没有具体时间
  if (usage?.free_limit?.limited && !usage.free_limit.resets_at) {
    return `<div class="usage-cooldown">⏸ 冷却中 · 重置时间未知</div>`;
  }

  // 4. banner 有 pct 且达到预警线 (90%) -> 即使 API 数据还没更新，也优先显示
  if (banner && banner.pct != null && banner.pct >= 90) {
    return `<div class="ubar-wrap"><div class="ubar bar-danger" style="width:${banner.pct}%"></div></div>
            <div class="ubar-label">会话用量 ${banner.pct}% 已用 (DOM实时)</div>`;
  }

  // 5. 有进度条数据且未冷却
  const hasRealData = slots.some(s => s != null);
  if (hasRealData) {
    const block = usage.five_hour || usage.seven_day || usage.message_limit || usage.free_limit;
    if (block && block.utilization != null) {
      const pct = Math.round(block.utilization);
      const cls = pct >= 90 ? 'bar-danger' : pct >= 65 ? 'bar-warn' : 'bar-ok';
      const label = usage.five_hour ? '5h' : usage.seven_day ? '7d' : usage.message_limit ? '消息' : '免费';
      const resetStr = block.resets_at ? ` · ${fmtCountdown(block.resets_at)}重置` : '';
      return `<div class="ubar-wrap"><div class="ubar ${cls}" style="width:${Math.min(pct,100)}%"></div></div>
              <div class="ubar-label">${label} ${pct}% 已用${resetStr}</div>`;
    }
  }

  // 6. banner 有 pct 但不到 90%
  if (banner && banner.pct != null) {
    const cls = banner.pct >= 65 ? 'bar-warn' : 'bar-ok';
    return `<div class="ubar-wrap"><div class="ubar ${cls}" style="width:${banner.pct}%"></div></div>
            <div class="ubar-label">会话用量 ${banner.pct}% 已用</div>`;
  }

  // 7. 无数据 → 绿色
  return `<div class="usage-ok">✅ 可正常使用</div>`;
}

// ── State ──
let accounts = [], currentKey = null, refreshing = false, activeTab = 'auto', isSwitching = false;
let detectInterval = null;

// ── 静默检测当前账号（已废弃：由于轮询机制会导致切号时的Cookie争用状态引起在UI上疯狂跳跃和覆盖Cooldown状态，已彻底删除该轮询）──
// 采用 background.js 的 onUpdated + broadcast 进行稳态更新

// ── Render ──
function render() {
  const list = document.getElementById('list');
  document.getElementById('hdr-sub').textContent = `共 ${accounts.length} 个账号`;

  if (accounts.length === 0) {
    list.innerHTML = `<div class="empty">
      <div class="empty-icon">👤</div>
      <div class="empty-title">还没有账号</div>
      <div class="empty-desc">点右上角「添加」<br>可自动抓取或手动输入 Session Key</div>
      <button class="btn-open" id="btn-go">打开 Claude</button>
    </div>`;
    document.getElementById('btn-go')?.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://claude.ai' }); window.close();
    });
    return;
  }

  list.innerHTML = accounts.map(acc => {
    const isActive = acc.sessionKey === currentKey;
    const displayName = acc.nickname || acc.email || '未知账号';
    const color = avatarColor(displayName);
    const plan = acc.plan || 'Unknown';

    const email = acc.email || '';
    const nick = acc.nickname || '';
    const name = acc.name || '';
    
    let isCustomNick = nick && nick !== email && nick !== name && nick !== '未知账号';
    let mainLabel = isCustomNick ? nick : (name || email || '未知账号');
    
    let subTexts = [];
    if (name && name !== mainLabel) subTexts.push(`👤 ${name}`);
    if (email && email !== mainLabel) subTexts.push(`✉️ ${email}`);
    const subBlock = subTexts.length > 0 ? `<div style="font-size:11.5px;color:#777;margin-top:2px;">${subTexts.join(' &nbsp; ')}</div>` : '';

    return `<div class="card ${isActive ? 'active' : ''}" data-key="${acc.sessionKey}">
      <div class="card-main">
        <div class="avatar" style="background:${color}">${initial(mainLabel)}</div>
        <div class="ci">
          <div class="cname" style="margin-bottom:2px">
            ${isActive ? '<span class="ldot"></span>' : ''}
            <span title="${mainLabel}">${mainLabel}</span>
          </div>
          ${subBlock}
          ${renderMiniUsage(acc)}
        </div>
        <div class="cr">
          ${isActive
            ? '<span class="badge b-active">✓ 使用中</span>'
            : `<button class="btn-sw" data-key="${acc.sessionKey}">切换</button>`
          }
          <span class="badge ${planClass(plan)}">${plan}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.btn-sw').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); doSwitch(btn.dataset.key); })
  );
  list.querySelectorAll('.card:not(.active)').forEach(card =>
    card.addEventListener('click', () => doSwitch(card.dataset.key))
  );
}

// ── Switch ──
async function doSwitch(key) {
  const acc = accounts.find(a => a.sessionKey === key);
  if (!acc) return;
  
  isSwitching = true;
  // 乐观更新 UI：立即将焦点切给新账号，消除视觉延迟感
  const oldKey = currentKey;
  currentKey = key;
  render();

  const card = document.querySelector(`[data-key="${key}"]`);
  if (card) {
    card.classList.add('switching');
    const badge = card.querySelector('.b-active');
    if (badge) badge.innerHTML = '<span class="spin" style="width:10px;height:10px;border-width:2px;margin-right:4px;border-top-color:#1a7a46"></span>切换中';
  }

  toast('切换中...', 4000);
  const r = await send('SWITCH_ACCOUNT', { account: acc });
  
  if (r?.success) {
    toast('✓ 切换成功');
  } else {
    toast('切换失败，请重试');
  }
  
  isSwitching = false;
  
  // 主动找后台要一次当前的绝对状态，防止卡死
  const fresh = await send('GET_CURRENT_KEY');
  if (fresh?.currentSessionKey) {
    currentKey = fresh.currentSessionKey;
  }
  render();
}

// ── Refresh ──
async function doRefresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = document.getElementById('btn-refresh');
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  toast('刷新中...', 3000);
  const r = await send('REFRESH_ALL_STATS');
  if (r?.success) {
    accounts = r.accounts;
    currentKey = r.currentSessionKey;
    // Bug2修复：同步拉取DOM冷却banner，让后台去更新并广播
    if (currentKey) {
      send('GET_SESSION_BANNER').catch(() => {});
    }
    render(); toast('✓ 已刷新');
  } else toast('刷新失败');
  btn.disabled = false; btn.innerHTML = '⟳';
  refreshing = false;
}

// ── Load ──
async function load() {
  const r = await send('GET_ACCOUNTS');
  accounts = r.accounts || [];
  currentKey = r.currentSessionKey;
  render();

  if (currentKey) {
    try {
      const banner = await send('GET_SESSION_BANNER');
      const idx = accounts.findIndex(a => a.sessionKey === currentKey);
      
      // 合并保证不会将正常的 true 擦成 false，接受限流或百分比更新
      if (idx >= 0 && banner) {
        if (banner.limited || banner.pct != null) {
           accounts[idx].sessionBanner = { ...(accounts[idx].sessionBanner || {}), ...banner };
           accounts[idx].sessionBannerAt = Date.now();
           render();
        }
      }
    } catch {}
  }
}

// ── Modal ──
const overlay = document.getElementById('overlay');
const tabs = document.querySelectorAll('.mtab');

function openModal() { overlay.classList.add('open'); }
function closeModal() {
  overlay.classList.remove('open');
  document.getElementById('auto-nick').value = '';
  document.getElementById('m-email').value = '';
  document.getElementById('m-session').value = '';
}

document.getElementById('btn-add').addEventListener('click', openModal);
document.getElementById('btn-cancel').addEventListener('click', closeModal);
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

tabs.forEach(t => t.addEventListener('click', () => {
  activeTab = t.dataset.tab;
  tabs.forEach(x => x.classList.toggle('active', x.dataset.tab === activeTab));
  document.getElementById('panel-auto').style.display = activeTab === 'auto' ? 'block' : 'none';
  document.getElementById('panel-manual').style.display = activeTab === 'manual' ? 'block' : 'none';
}));

document.getElementById('btn-confirm').addEventListener('click', async () => {
  if (activeTab === 'auto') await addAuto(); else await addManual();
});

// ── 获取当前激活的 claude.ai 标签（排除 dashboard/login）──
function getActiveCloudeTab(tabs) {
  const sorted = [...tabs].sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  return sorted[0] || null;
}

async function addAuto() {
  const nick = document.getElementById('auto-nick').value.trim();
  const btn = document.getElementById('btn-confirm');

  const claudeTabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  const validTabs = claudeTabs.filter(t =>
    !t.url.includes('dashboard.html') && !t.url.includes('/login')
  );

  if (!validTabs.length) {
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 等待登录...';
    toast('请在新窗口中登录 Claude...', 8000);

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
      // 登录后的标签就是目标标签，直接传 tabId
      const r = await send('FETCH_ACCOUNT_INFO', { tabId: loginTab.id });
      btn.disabled = false; btn.innerHTML = '✓ 添加';
      if (!r?.sessionKey) { toast('获取登录信息失败，请重试'); return; }
      await saveNewAccount(r, nick);
    };
    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        btn.disabled = false; btn.innerHTML = '✓ 添加';
        toast('登录超时，请重试');
      }
    }, 60000);
    return;
  }

  // 已有登录标签 —— 传入激活标签的 tabId，确保从正确上下文获取信息
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 获取中...';
  const targetTab = getActiveCloudeTab(validTabs);
  const r = await send('FETCH_ACCOUNT_INFO', { tabId: targetTab?.id || null });
  btn.disabled = false; btn.innerHTML = '✓ 添加';
  if (!r?.sessionKey) { toast('未检测到登录状态，请先登录 claude.ai'); return; }
  await saveNewAccount(r, nick);
}

async function saveNewAccount(r, nick) {
  const cookieKey = r.sessionKey;
  if (cookieKey) currentKey = cookieKey;

  const apiEmail = r.email || '';
  const apiUserId = r.userId || '';

  // ── 核心修复：用 email/userId 匹配账号身份，而非仅靠 sessionKey ──
  // 场景：用户在 claude.ai 上重新登录为 B 号，但 cookie 中 sessionKey 仍为 A 号的值
  //       此时 API 返回 B 的 email，但 sessionKey 匹配到了 A → 旧逻辑误判「已存在」
  // 修复：优先用 email → userId → sessionKey 的顺序识别账号真实身份

  // 1. 按 email 匹配（最可靠的身份标识）
  let matched = null;
  if (apiEmail) {
    matched = accounts.find(a => a.email && a.email === apiEmail);
  }
  // 2. 按 userId 匹配
  if (!matched && apiUserId) {
    matched = accounts.find(a => a.userId && a.userId === apiUserId);
  }

  if (matched) {
    // 身份匹配到了已有账号
    let changed = false;

    // sessionKey 变了 → 更新（token 续签、重新登录）
    if (matched.sessionKey !== cookieKey) {
      // 如果另一个账号也占着这个 key，标记它需要重新登录
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
      toast(`✓ 已更新：${matched.nickname || matched.email}`);
    } else {
      toast('该账号已存在');
    }
    closeModal(); render();
    return;
  }

  // 3. email/userId 都没匹配 → 全新账号
  // 检查 sessionKey 冲突：如果另一个已存账号占着同一个 key 但 email 不同
  const existingByKey = accounts.find(a => a.sessionKey === cookieKey);
  if (existingByKey) {
    if (apiEmail && existingByKey.email && existingByKey.email !== apiEmail) {
      // 同 key 不同身份 → 旧账号的 session 已被新账号覆盖
      existingByKey.valid = false;
      await send('SAVE_ACCOUNT', { account: existingByKey });
    } else if (!apiEmail || existingByKey.email === apiEmail) {
      // 无法区分身份 or 完全一致 → 视为已存在
      toast('该账号已存在');
      closeModal(); render();
      return;
    }
  }

  // 添加新账号
  const saveR = await send('SAVE_ACCOUNT', { account: {
    sessionKey: cookieKey, email: apiEmail, name: r.name || '',
    nickname: nick || apiEmail || '', plan: r.plan || 'Unknown', userId: apiUserId,
    valid: true, usage: r.usage || null, cookies: r.cookies,
    addedAt: Date.now(), lastUsed: Date.now(), refreshedAt: Date.now()
  }});
  accounts = saveR.accounts; currentKey = cookieKey;
  toast(`✓ 已添加：${nick || apiEmail || '新账号'}`);
  closeModal(); render();
}

async function addManual() {
  const emailVal = document.getElementById('m-email').value.trim();
  const sessionVal = document.getElementById('m-session').value.trim();
  if (!emailVal) { toast('请输入邮箱或备注名称'); return; }
  if (!sessionVal) { toast('请输入 Session Key'); return; }
  if (!sessionVal.startsWith('sk-ant-')) { toast('Session Key 应以 sk-ant- 开头'); return; }
  if (accounts.find(a => a.sessionKey === sessionVal)) { toast('该账号已存在'); closeModal(); return; }
  const saveR = await send('SAVE_ACCOUNT', { account: {
    sessionKey: sessionVal, email: emailVal.includes('@') ? emailVal : '',
    nickname: emailVal, plan: 'Unknown', valid: true,
    cookies: null, manualAdded: true, addedAt: Date.now(), lastUsed: null
  }});
  accounts = saveR.accounts;
  toast(`✓ 已添加：${emailVal}`); closeModal(); render();
}

document.getElementById('btn-refresh').addEventListener('click', doRefresh);
document.getElementById('btn-dash')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'dashboard.html' });
});
load();

// 清理不需要的轮询
window.addEventListener('unload', () => {});

// 监听即时广播（消除切号延迟）
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === 'ACCOUNT_UPDATED' && msg.currentSessionKey) {
    currentKey = msg.currentSessionKey;
    const r = await send('GET_ACCOUNTS');
    if (r?.accounts) accounts = r.accounts;
    render();
  }
});

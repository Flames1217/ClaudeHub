// content.js - ClaudeHub
// Runs inside claude.ai page. Handles API requests on behalf of background.js

// ── 孤儿检测（仅在扩展真正失效时标记）──

let _orphaned = false;
let _monitorInterval = null;
let _observer = null;
let _lastReportState = null;
let _cachedSessionKey = null; // 缓存 sessionKey（httpOnly cookie 无法通过 document.cookie 读取）

/**
 * 检查扩展上下文是否已失效
 * 只有真正的 "Extension context invalidated" 才标记孤儿
 */
function isContextDead() {
  if (_orphaned) return true;
  try {
    return !chrome?.runtime?.id;
  } catch {
    return true;
  }
}

/**
 * 标记孤儿并清理所有定时器
 */
function killSelf() {
  _orphaned = true;
  try { if (_monitorInterval) clearInterval(_monitorInterval); } catch {}
  try { if (_observer) _observer.disconnect(); } catch {}
  _monitorInterval = null;
  _observer = null;
}

/**
 * 判断错误是否为 "Extension context invalidated"
 */
function isContextError(e) {
  return e && (
    (typeof e.message === 'string' && e.message.includes('Extension context invalidated')) ||
    (typeof e === 'string' && e.includes('Extension context invalidated'))
  );
}

// 全局错误拦截：压制 context invalidated 在控制台的显示
window.addEventListener('error', (evt) => {
  if (evt.message && evt.message.includes('Extension context invalidated')) {
    evt.preventDefault();
    evt.stopImmediatePropagation();
    killSelf();
    return true;
  }
});
window.addEventListener('unhandledrejection', (evt) => {
  const m = evt.reason?.message || String(evt.reason || '');
  if (m.includes('Extension context invalidated')) {
    evt.preventDefault();
    killSelf();
  }
});

/**
 * 安全发送消息到 background（只在 context invalidated 时标记孤儿，其他错误忽略）
 */
function safeSend(msg, cb) {
  if (_orphaned) return;
  if (isContextDead()) { killSelf(); return; }
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      try { void chrome.runtime.lastError; } catch (e) {
        if (isContextError(e)) killSelf();
      }
      try { if (cb) cb(res); } catch {}
    });
  } catch (e) {
    if (isContextError(e)) killSelf();
    // 其他错误（如 service worker 暂时不可用）不标记孤儿，下次重试
  }
}

// ── CONTENT_FETCH 消息处理 ──

try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (_orphaned || isContextDead()) return false;
    
    if (msg.type !== 'CONTENT_FETCH') return false;
    const { url } = msg;

    fetch(url, {
      headers: {
        'Accept': 'application/json',
        'anthropic-client-platform': 'web_claude_ai'
      },
      credentials: 'include'
    })
      .then(async res => {
        if (_orphaned) return;
        if (!res.ok) {
          try { sendResponse({ _status: res.status, _ok: false }); } catch {}
          return;
        }
        try {
          const data = await res.json();
          try { sendResponse({ _ok: true, data }); } catch {}
        } catch {
          try { sendResponse({ _ok: false, _error: 'json_parse_failed' }); } catch {}
        }
      })
      .catch(e => {
        if (!_orphaned) {
          try { sendResponse({ _ok: false, _error: e.message }); } catch {}
        }
      });

    return true;
  });
} catch (e) {
  if (isContextError(e)) killSelf();
}

// ── 冷却提示检测 ──

function detectRateLimit() {
  const result = { limited: false, resets_at: null, text: null, pct: null };
  
  let allText = '';
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        let p = node.parentElement;
        while (p && p !== document.body) {
          if (p.classList.contains('font-user-message') || 
              p.classList.contains('font-claude-message') || 
              p.classList.contains('ProseMirror') ||
              p.tagName === 'SCRIPT' || p.tagName === 'STYLE') {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    let count = 0;
    while ((node = walker.nextNode()) && count < 6000) { 
      allText += node.textContent + ' ';
      count++;
    }
  } catch {}

  try {
    const inner = (document.body?.innerText || '').substring(0, 15000); 
    allText += ' ' + inner;
  } catch {}

  // ── 百分比匹配 ──
  // 英文格式："You've used 90% of your session limit" / "You've used 90% of your message limit"
  const pctMatch = allText.match(/(?:you.?ve used|you have used|you.?re at)\s*(\d+)%\s*(?:of (?:your |the )?)?(?:message |usage |session |chat )?limit/i)
                // 中文格式："已使用90%的会话限制"
                || allText.match(/(?:you.?ve used|you have used|you.?re at|使用了|已使用|已达|已经使用了|接近)\s*(\d+)%\s*(?:的)?(?:message |usage |session |chat |消息|使用|会话|聊天)?限制/i)
                || allText.match(/(\d+)%\s*(?:的)?(?:message |usage |session |chat |消息|使用|会话|聊天)?限制\s*(?:已用|已使用|has been used)/i)
                // 通用：捕获 "used X%" 的模式
                || allText.match(/(?:you.?ve used|you have used)\s*(\d+)%/i);
  if (pctMatch) { result.pct = parseInt(pctMatch[1]); }

  // ── 限流关键词匹配 ──
  const enKeywords = [
    /hit your (?:\w+ )*(?:message )?limit/i,
    /you.?ve reached your (?:\w+ )*(?:message |usage |session |chat )?limit/i,
    /you are out of (?:\w+ )?messages/i,
    /out of (?:\w+ )?messages/i,
    /limit reached/i,
    /run out of messages/i,
    /try again (?:at|after)/i,
    /available again/i,
    /keep chatting with claude/i,
    /upgrade to (?:pro|max)/i
  ];
  
  for (const reg of enKeywords) {
    const match = allText.match(reg);
    if (match) {
      result.limited = true;
      result.text = match[0];
      break;
    }
  }

  // ── 英文日期格式：January 15 at 11:00 AM ──
  const enDate = allText.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,?\s+\d{4})?\s+(?:at|until)\s+(\d{1,2})[:：](\d{2})\s*(AM|PM)?/i);
  if (enDate) {
    try {
      const d = new Date(enDate[0].replace(/ (at|until) /i, ' '));
      if (!isNaN(d)) { result.resets_at = d.toISOString(); result.limited = true; }
    } catch {}
  }

  // ── 英文时间格式：until 11:00 AM ──
  const enTime = allText.match(/(?:resets?|available again|try again|available|until|after)(?: (?:at|until))?\s*(\d{1,2})[:：](\d{2})\s*(AM|PM)?/i);
  if (enTime && !result.resets_at) {
    try {
      const h = parseInt(enTime[1]), m = parseInt(enTime[2]), meridiem = enTime[3];
      const now = new Date(), target = new Date();
      let finalH = h;
      if (meridiem?.toUpperCase() === 'PM' && finalH < 12) finalH += 12;
      if (meridiem?.toUpperCase() === 'AM' && finalH === 12) finalH = 0;
      target.setHours(finalH, m, 0, 0);
      const diffMs = target.getTime() - now.getTime();
      if (diffMs < -4 * 3600000) { target.setDate(target.getDate() + 1); }
      if (result.limited || target > now || allText.toLowerCase().includes('until ' + enTime[1]) || allText.toLowerCase().includes('at ' + enTime[1])) {
        result.resets_at = target.toISOString();
        result.limited = true;
      }
    } catch {}
  }

  // ── 中文限流匹配 ──
  const zhLimited = allText.match(/(?:您?已达到|达到了|已用完).{0,6}(?:消息|使用|聊天|对话|频率)?限制|暂时无法(?:发送|使用)|使用次数已达上限/);
  if (zhLimited) {
    result.limited = true;
    result.text = result.text || zhLimited[0];
  }

  if (!result.resets_at) {
    const zhTime = allText.match(/(?:等到|将在|预计|恢复于|直至|直到)\s*(\d{1,2})[：:点](\d{0,2})\s*(?:分钟?)?(?:才能|可以|恢复|使用|重试|后)/);
    if (zhTime) {
      try {
        const now = new Date(), target = new Date();
        const h = parseInt(zhTime[1]), m = parseInt(zhTime[2] || '0');
        target.setHours(h, m, 0, 0);
        const diffMs = target.getTime() - now.getTime();
        if (diffMs < -4 * 3600000) { target.setDate(target.getDate() + 1); }
        if (result.limited || target > now) {
          result.resets_at = target.toISOString();
          result.limited = true;
        }
      } catch {}
    }
  }

  const zhDate = allText.match(/(\d{1,2})月(\d{1,2})日.{0,10}(\d{1,2}):(\d{2})/);
  if (zhDate && !result.resets_at) {
    try {
      const now = new Date();
      const month = parseInt(zhDate[1]) - 1, day = parseInt(zhDate[2]), hour = parseInt(zhDate[3]), min = parseInt(zhDate[4]);
      const d = new Date(now.getFullYear(), month, day, hour, min, 0);
      if (d < now) d.setFullYear(d.getFullYear() + 1);
      result.resets_at = d.toISOString();
    } catch {}
    result.limited = true;
  }

  return result;
}

function getMySessionKey() {
  try {
    const cookies = document.cookie.split(';');
    for (let c of cookies) {
      c = c.trim();
      if (c.startsWith('sessionKey=')) {
        _cachedSessionKey = c.substring(11);
        return _cachedSessionKey;
      }
    }
  } catch {}
  // httpOnly cookie 无法通过 document.cookie 读取，使用缓存
  return _cachedSessionKey;
}

// 从 background 获取当前 sessionKey 并缓存
function fetchAndCacheSessionKey() {
  if (_orphaned || isContextDead()) return;
  try {
    chrome.runtime.sendMessage({ type: 'GET_CURRENT_KEY' }, (res) => {
      try { void chrome.runtime.lastError; } catch (e) {
        if (isContextError(e)) killSelf();
        return;
      }
      if (res?.currentSessionKey) {
        _cachedSessionKey = res.currentSessionKey;
      }
    });
  } catch (e) {
    if (isContextError(e)) killSelf();
  }
}

function reportIfLimited() {
  if (_orphaned) return;
  if (isContextDead()) { killSelf(); return; }
  try {
    const info = detectRateLimit();
    let currentKey = getMySessionKey();
    
    // sessionKey 为空时，尝试从 background 异步获取
    if (!currentKey) {
      fetchAndCacheSessionKey();
      // 如果缓存仍为空，跳过本次（下次 interval 重试时缓存应已填充）
      if (!_cachedSessionKey) return;
      currentKey = _cachedSessionKey;
    }
    info.sourceKey = currentKey;
    
    const stateKey = `${info.limited}-${info.resets_at}-${info.pct}-${currentKey}`;
    if (stateKey !== _lastReportState) {
      _lastReportState = stateKey;
      safeSend({ type: 'SESSION_BANNER_UPDATE', banner: info });
    }
  } catch {}
}

// ── 静默实时监听 ──

if (!_orphaned) {
  // 启动时立即从 background 获取并缓存 sessionKey
  fetchAndCacheSessionKey();

  _monitorInterval = setInterval(() => {
    if (_orphaned) { clearInterval(_monitorInterval); _monitorInterval = null; return; }
    reportIfLimited();
  }, 2000);

  _observer = new MutationObserver((mutations) => {
    if (_orphaned) return;
    try {
      const shouldCheck = mutations.some(m => 
        m.type === 'childList' || m.type === 'characterData' || (m.type === 'attributes' && m.target.className?.includes('modal'))
      );
      if (shouldCheck) reportIfLimited();
    } catch {}
  });

  try {
    _observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  } catch {}

  if (document.readyState === 'complete') {
    reportIfLimited();
  } else {
    window.addEventListener('load', () => { if (!_orphaned) reportIfLimited(); });
  }

  // GET_SESSION_BANNER 处理
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (_orphaned || isContextDead()) return false;
      if (msg.type === 'GET_SESSION_BANNER') {
        try {
          const res = detectRateLimit();
          res.sourceKey = getMySessionKey();
          sendResponse(res);
        } catch {
          try { sendResponse({}); } catch {}
        }
      }
    });
  } catch (e) {
    if (isContextError(e)) killSelf();
  }
}

// ══════════════════════════════════════════════════════════════════
// ── 续接对话：对话快照 & 上下文注入 ──
// ══════════════════════════════════════════════════════════════════

/**
 * 抓取当前页面的对话历史
 * 返回 [{role:'User'|'Claude', text:string}]
 */
function snapshotConversation() {
  const normalizeText = (text) => (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const hasClassLike = (el, needle) => {
    const cls = String(el?.className || '').toLowerCase();
    return cls.includes(needle) || !!el?.querySelector?.(`[class*="${needle}"]`);
  };

  const getRole = (el) => {
    const roleNode = el.closest?.('[data-message-author-role]');
    const role = ((roleNode || el).getAttribute('data-message-author-role') || '').toLowerCase();
    const testNode = el.closest?.('[data-testid]');
    const testId = [
      el.getAttribute('data-testid') || '',
      testNode?.getAttribute('data-testid') || ''
    ].join(' ').toLowerCase();
    const cls = String(el.className || '').toLowerCase();
    if (role.includes('user') || testId.includes('user') || testId.includes('human')) return 'User';
    if (
      role.includes('assistant') ||
      testId.includes('assistant') ||
      testId.includes('ai-turn') ||
      cls.includes('font-claude-message') ||
      hasClassLike(el, 'font-claude-message') ||
      el.querySelector?.('[data-message-author-role="assistant"], [data-testid*="assistant"], [data-testid*="ai-turn"]')
    ) return 'Claude';
    return null;
  };

  const selector = [
    '[data-message-author-role]',
    '[data-testid*="conversation-turn"]',
    '[data-testid*="message"]',
    '[data-testid="user-message"]',
    '[data-testid="human-turn"]',
    '[data-testid="assistant-message"]',
    '[data-testid="ai-turn"]',
    '.font-claude-message',
    '[class*="font-claude-message"]'
  ].join(',');

  const candidates = Array.from(document.querySelectorAll(selector))
    .map((node) => ({ node, role: getRole(node), text: normalizeText(node.innerText || node.textContent || '') }))
    .filter((item) => item.role && item.text.length > 0)
    // Claude 的 turn wrapper 和正文节点可能同时命中，优先保留更内层的正文节点。
    .filter((item, _index, all) => !all.some((other) =>
      other !== item &&
      other.role === item.role &&
      item.node.contains(other.node) &&
      normalizeText(other.text).length > 0
    ))
    .sort((a, b) => {
      const pos = a.node.compareDocumentPosition(b.node);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

  const turns = [];
  for (const item of candidates) {
    const prev = turns[turns.length - 1];
    if (prev && prev.role === item.role && prev.text === item.text) continue;
    turns.push({ role: item.role, text: item.text });
  }

  const noisyLines = new Set([
    'Claude', 'New chat', 'Search', 'Chats', 'Projects', 'Artifacts', 'Code',
    'Customize', 'Recents', 'Share', 'Upgrade', 'Free plan', 'Write a message...'
  ]);

  const cleanFallbackText = (text) => normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !noisyLines.has(line))
    .join('\n');

  const main = document.querySelector('main, [role="main"]') || document.body;
  let fallbackText = cleanFallbackText(main?.innerText || '');

  if (turns.length > 0) {
    const hasClaude = turns.some((turn) => turn.role === 'Claude');
    if (!hasClaude && fallbackText) {
      for (const turn of turns) {
        fallbackText = normalizeText(fallbackText.replace(turn.text, ''));
      }
      if (fallbackText.length > 30) {
        turns.push({ role: 'Claude', text: fallbackText });
      }
    }
    return turns;
  }

  // 兜底：Claude DOM 改版时，至少把主内容区可见正文带过去，避免误判“页面无对话”。
  if (!fallbackText) return [];
  const text = fallbackText;
  return text ? [{ role: 'Claude', text }] : [];
}

/**
 * 把续接 prompt 注入到 ProseMirror 编辑器
 * 使用 execCommand（在 content script 中仍有效）
 */
function injectToEditor(text) {
  const editor = document.querySelector(
    '.ProseMirror[contenteditable="true"], [contenteditable="true"][data-placeholder], [contenteditable="true"], textarea'
  );
  if (!editor) return false;
  editor.focus();
  if (editor.tagName === 'TEXTAREA') {
    editor.value = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    return true;
  }
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, text);
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  return true;
}

/**
 * 把对话历史数组格式化为续接 prompt 字符串
 */
function buildContinuePrompt(turns) {
  if (!turns || turns.length === 0) return '';

  // 中间的 Claude 消息截断到 300 字，避免 prompt 过长
  const CLAUDE_MAX = 300;
  const lines = turns.map((t, i) => {
    const isLast = i === turns.length - 1;
    let text = t.text;
    if (t.role === 'Claude' && !isLast && text.length > CLAUDE_MAX) {
      text = text.slice(0, CLAUDE_MAX) + '…（已截断）';
    }
    return `【${t.role}】${text}`;
  });

  return (
    '[续接对话]\n' +
    '以下是我在上一个账号中的对话记录，请继续帮我解决最后一个问题。\n\n' +
    lines.join('\n\n') +
    '\n\n---\n请直接接着回答最后的问题，不需要重新介绍背景。'
  );
}

// ── 监听来自 background 的消息 ──

try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (_orphaned || isContextDead()) return false;

    // 1. 快照请求：抓取对话历史并返回
    if (msg.type === 'SNAPSHOT_CONVERSATION') {
      try {
        const turns = snapshotConversation();
        sendResponse({ ok: true, turns, url: window.location.href });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return false; // 同步返回
    }

    // 2. 注入请求：将续接 prompt 写入输入框
    if (msg.type === 'INJECT_CONTEXT') {
      try {
        const prompt = buildContinuePrompt(msg.turns);
        const ok = prompt ? injectToEditor(prompt) : false;
        sendResponse({ ok });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return false;
    }

    return false;
  });
} catch (e) {
  if (isContextError(e)) killSelf();
}

// ── 页面加载完成后：检查是否有待注入的续接上下文 ──
// 切号后新页面加载完成，background.js 会把 pendingContext 写入 storage，
// content.js 读取到后自动注入并清除，实现"无感续接"。

function tryAutoInjectContext() {
  if (_orphaned || isContextDead()) return;
  // 只在 claude.ai 主对话页（非 dashboard/login）执行
  if (!window.location.href.startsWith('https://claude.ai')) return;
  if (window.location.href.includes('/login') || window.location.href.includes('dashboard.html')) return;

  chrome.storage.local.get('pendingContext', (result) => {
    if (!result.pendingContext) return;
    const { turns, targetKey } = result.pendingContext;
    if (!turns || turns.length === 0) { chrome.storage.local.remove('pendingContext'); return; }

    // 等待编辑器渲染完成，最多重试 8 次（每次 500ms）
    let attempts = 0;
    const tryInject = () => {
      attempts++;
      const prompt = buildContinuePrompt(turns);
      const ok = injectToEditor(prompt);
      if (ok) {
        chrome.storage.local.remove('pendingContext');
        // 可选：显示提示
        try {
          safeSend({ type: 'CONTEXT_INJECTED', targetKey });
        } catch {}
      } else if (attempts < 8) {
        setTimeout(tryInject, 500);
      } else {
        // 注入失败：把内容存剪贴板作为兜底
        chrome.storage.local.remove('pendingContext');
      }
    };
    setTimeout(tryInject, 800); // 初始等待页面渲染
  });
}

// 页面加载完成时触发
if (document.readyState === 'complete') {
  tryAutoInjectContext();
} else {
  window.addEventListener('load', tryAutoInjectContext);
}

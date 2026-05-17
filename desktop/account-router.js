function hasCooldown(account) {
  const banner = account.sessionBanner;
  const freeLimit = account.usage?.free_limit;
  const resetAt = account.cooldownUntil || banner?.resets_at || freeLimit?.resets_at;
  if (banner?.limited || freeLimit?.limited) {
    if (!resetAt) return true;
    return new Date(resetAt).getTime() > Date.now();
  }
  return false;
}

function usageScore(account) {
  const blocks = [
    account.usage?.free_limit,
    account.usage?.message_limit,
    account.usage?.five_hour,
    account.usage?.seven_day
  ].filter(Boolean);

  if (!blocks.length) return 0;
  return Math.max(...blocks.map((block) => Number(block.utilization || 0)));
}

function accountHealth(account) {
  if (!account.sessionKey) return { ok: false, reason: 'missing_session' };
  if (account.disabled) return { ok: false, reason: account.disabledReason || 'disabled' };
  if (account.valid === false) return { ok: false, reason: 'invalid' };
  if (hasCooldown(account)) return { ok: false, reason: 'cooldown' };
  return { ok: true, reason: 'ready' };
}

function routeAccount(accounts, preferredAccountId = null, currentAccountId = null) {
  const preferred = accounts.find((account) => account.id === preferredAccountId);
  if (preferred && accountHealth(preferred).ok) {
    return { account: preferred, reason: 'preferred' };
  }

  const candidates = accounts
    .filter((account) => accountHealth(account).ok)
    .sort((a, b) => {
      if (currentAccountId) {
        const aCurrent = a.id === currentAccountId;
        const bCurrent = b.id === currentAccountId;
        if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
      }
      const usageDiff = usageScore(a) - usageScore(b);
      if (usageDiff !== 0) return usageDiff;
      return (a.lastUsed || 0) - (b.lastUsed || 0);
    });

  if (!candidates.length) {
    return {
      account: null,
      reason: accounts.length ? 'all_limited_or_invalid' : 'no_accounts'
    };
  }

  return { account: candidates[0], reason: 'lowest_usage' };
}

function buildHandoffPrompt(conversation, userMessage, settings = {}) {
  const limit = settings.contextMessageLimit || 12;
  const recent = conversation.messages.slice(-limit);
  const lines = [];

  if (conversation.summary) {
    lines.push('以下是此前对话摘要，请保持连续性：');
    lines.push(conversation.summary);
    lines.push('');
  }

  if (recent.length) {
    lines.push('最近对话：');
    for (const message of recent) {
      const role = message.role === 'assistant' ? 'Claude' : 'User';
      lines.push(`${role}: ${message.content}`);
    }
    lines.push('');
  }

  lines.push('请继续这场对话，直接回答用户最新消息：');
  lines.push(userMessage);
  return lines.join('\n');
}

module.exports = {
  hasCooldown,
  usageScore,
  accountHealth,
  routeAccount,
  buildHandoffPrompt
};

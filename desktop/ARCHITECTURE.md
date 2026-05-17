# Claude Cockpit Architecture

This desktop layer borrows the useful shape of cockpit-tools without copying its provider-specific code:

- Account state is platform data, not UI state.
- Each account can be disabled, refreshed, routed, and opened in an isolated runtime.
- The active conversation belongs to this app, not to Claude Web.
- Claude accounts are execution channels; handoff prompts carry continuity across accounts.

## Current Modules

- `main.js`: Electron lifecycle, IPC commands, refresh scheduler.
- `store.js`: atomic JSON store for accounts, conversations, settings, and current account.
- `account-router.js`: account health checks, cooldown filtering, usage-aware routing, handoff prompt generation.
- `claude-executor.js`: Claude Web session hydration, quota/account snapshot refresh, optional Web automation.
- `renderer.js`: cockpit UI for conversations, account pool, routing, and sending messages.

## Execution Modes

Default mode is a safe handoff preview. It routes the message and shows the prompt that would be sent to Claude.

Set `CLAUDE_COCKPIT_ENABLE_WEB_AUTOMATION=1` to try the real Claude Web runner. The runner uses an isolated Electron session partition per account.

## Next Hardening Points

- Calibrate Claude Web selectors with real logged-in pages.
- Persist per-account runner windows and surface their lifecycle in the UI.
- Add a better summarizer for long conversations.
- Add refresh backoff so accounts with repeated 401/403/429 responses are paused automatically.

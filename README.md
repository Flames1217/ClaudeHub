# Claude Switcher

A Manifest V3 browser extension for quickly switching and managing multiple `claude.ai` accounts in Chrome/Edge.

## Features

- Multi-account local storage (`chrome.storage.local`)
- One-click account switching by restoring `sessionKey` and related cookies
- Popup quick switch UI
- Dashboard management UI (add/remove/import/export/debug)
- Usage/rate-limit status detection from API + page signals

## Project Structure

- `manifest.json`: MV3 extension config
- `background.js`: core logic (account store, cookie switching, message router)
- `content.js`: in-page fetch proxy and rate-limit banner detection
- `popup.html` / `popup.js`: compact switcher UI
- `dashboard.html` / `dashboard.js`: full management UI
- `icons/`: extension icons

## Install (Developer Mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select this folder.

## Security Notes

- Account export JSON contains sensitive session data.
- Keep backup files private and encrypted.
- Do not commit account backup files to git.
- This repo ignores `claude_accounts*.json` by default and keeps `claude_accounts.sample.json` as the only shareable sample.

## Local Development

No build step is required. Edit files directly and reload the extension.

Quick syntax checks:

```powershell
node --check background.js
node --check content.js
node --check popup.js
node --check dashboard.js
```

## License

MIT

## Disclaimer

This is an independent tool and is not affiliated with or endorsed by Anthropic.

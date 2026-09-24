# Drive on Demand

**Browse, sync and edit your Google Drive from inside Obsidian — files-on-demand, selective offline, and automatic two-way sync. Works on desktop *and* mobile (iPhone/iPad included).**

Google Drive's official desktop app keeps your files in sync on macOS/Windows, but there is no such thing on iOS. *Drive on Demand* brings your Drive into Obsidian on every platform: navigate a lazy Drive tree, tick exactly the folders/files you want available offline, and let the plugin keep them in sync in both directions.

---

## ⏳ Free for now — a subscription is coming

This plugin is **free during the current beta**. Later, a low-cost subscription (planned around **1–2 €/month**) will be introduced to cover the hosted authentication service and ongoing development.

- **You get 1 month free.** Early adopters keep a **free first month** once the paid plan launches — you will be notified well in advance inside the plugin and here.
- A **free tier** with core functionality is intended to remain available.
- No payment is required today, and nothing is charged automatically. When the paid plan arrives, **full access will require an account and a subscription** (this notice is your disclosure per Obsidian's developer policies).

---

## Features

- **Lazy Drive panel** — browse your whole Drive (tested on 15 000+ items) without downloading anything.
- **Selective sync** — tri-state checkboxes (empty / partial / full) per file and folder. Only what you tick is materialised in your vault.
- **Files-on-demand** — text, Markdown, PDFs, images and other binaries download on demand, no size limit.
- **Automatic two-way sync** — edits made in Obsidian push to Drive; changes made elsewhere (Drive web, Drive Desktop, another device) are pulled back automatically (checked every ~60 s via Google's efficient Changes API). Renames, moves and deletions follow in both directions.
- **Safe deletions** — a deletion is never permanent: it goes to the Google Drive trash (30 days) or to the vault's `.trash` folder. A file with local edits not yet uploaded is never deleted. More than 10 deletions at once ask for confirmation first. Unticking a file only removes the local copy, never the Drive one.
- **Offline-resilient** — a persistent outbox re-sends your local changes when you come back online; nothing is lost during an outage.
- **Conflict-safe** — if both sides changed, a `(conflict …)` copy is created; your data is never silently overwritten.
- **Google Docs / Sheets / Slides** — synced as clickable `.md` link notes to their native editor.
- **Working folder** — pick any sub-folder of your Drive as the root of your vault.
- **Connection status** — a single indicator in the status bar (online / offline / syncing).
- **Localised** — English and French (follows your Obsidian language).

---

## How it works & what it talks to (network disclosure)

To keep your credentials safe, *Drive on Demand* does **not** embed any Google client secret in the plugin. Instead it uses a small **hosted authentication broker** operated by Real-IT.

The plugin communicates with exactly two remote services:

1. **Google Drive API** (`googleapis.com`) — to list, download and upload the files you choose to sync. This is the whole point of the plugin.
2. **Real-IT authentication broker** (`https://obsidian-drive-on-demand-server.real-it.org`) — used **only** for the Google sign-in flow: it exchanges the one-time authorization code for tokens and refreshes your access token server-side, so the Google *client secret* never ships inside the plugin (which would be insecure on a public/mobile app). The broker never receives your notes or file contents — only OAuth tokens tied to your Google account.

Your Google **refresh token is stored locally** in the plugin's own data (`data.json`) on your device. The broker holds the client secret required to refresh it; see the [Privacy Policy](PRIVACY.md) for exactly what the broker stores and for how long.

## Account requirement (disclosure)

A **Google account** is required (to authorise Drive access). You connect it once via **Settings → Drive on Demand → Connect my account**. When the paid plan launches, a Real-IT account/subscription will additionally be required for full access.

### Advanced: use your own Google credentials (no user cap)

Prefer to stay fully independent of the Real-IT broker? You can connect the
plugin to **your own Google Cloud project** — this removes the managed
service's 100-user cap and the weekly re-login. See the step-by-step guide:
**[docs/setup-byo.md](docs/setup-byo.md)**.

---

## Installation

### Community plugins (once approved)

Settings → Community plugins → Browse → search **"Drive on Demand"** → Install → Enable.

### Beta via BRAT (available now)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. BRAT → *Add beta plugin* → `realitorg/app-realitorg-obsidian-drive-on-demand-client-obsidian-ts`.
3. Enable **Drive on Demand**, then open **Settings → Drive on Demand → Connect my account** and follow the Google sign-in.

---

## Privacy & security

- No client-side telemetry. No ads.
- The plugin only accesses your vault and the Google Drive scope you authorise.
- Full details: **[Privacy Policy](PRIVACY.md)** and <https://real-it.org/drive-on-demand>.

## Building from source

```bash
npm install
npm run build      # produces main.js
npm test           # unit tests (vitest)
npm run check      # type-check
```

## Support

Issues and feature requests: this repository's issue tracker.
Project page: <https://real-it.org/drive-on-demand>

## License

[MIT](LICENSE) © Real-IT (Loïc Bertrand)

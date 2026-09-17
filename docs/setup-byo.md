# Advanced setup — use your own Google credentials (BYO)

By default, *Drive on Demand* signs you in through the managed Real-IT
authentication service. That service is capped at **100 total users** until
Google finishes verifying it, and in that mode Google also expires the sign-in
every 7 days.

You can lift both limits by connecting the plugin to **your own Google Cloud
project**. It takes ~10 minutes, once. After that:

- **No 100-user cap** (it's your project, only you use it).
- **No weekly re-login** (once you publish your project — see step 3).
- Your Google **client secret stays on your device** — it never passes through
  the Real-IT broker (the broker only bounces the sign-in redirect).

> This is the same pattern used by tools like rclone. You stay fully independent.

---

## What you'll need

A Google account. Everything below is free.

## Step 1 — Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top bar → project selector → **New Project**. Name it e.g. `obsidian-drive`,
   then **Create** and select it.

## Step 2 — Enable the Google Drive API

1. Left menu → **APIs & Services → Library**.
2. Search **Google Drive API** → open it → **Enable**.

## Step 3 — Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External** → **Create**.
3. Fill the required fields (app name, your email) → **Save and continue**.
4. **Scopes**: you can skip adding scopes here (the plugin requests them at
   sign-in) → **Save and continue**.
5. **Test users**: add your own Google address → **Save and continue**.
6. Back on the consent screen, to avoid the 7-day sign-in expiry, click
   **Publish app** (status → *In production*). Since it's your own project used
   only by you, the "unverified app" warning at sign-in is harmless — you just
   click **Advanced → Go to … (unsafe)** once.

## Step 4 — Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Under **Authorized redirect URIs**, click **Add URI** and paste **exactly**:

   ```
   https://obsidian-drive-on-demand-server.real-it.org/callback-byo
   ```

4. **Create**. Google shows your **Client ID** and **Client secret** — keep this
   dialog open (or copy both somewhere safe).

## Step 5 — Enter them in Obsidian

1. Obsidian → **Settings → Drive on Demand → Advanced — use my own Google
   credentials**.
2. Paste your **Client ID** and **Client secret** → **Save and enable**.
3. Click **Connect my account** and complete the Google sign-in.

Done — you're now running on your own project, with no user cap.

---

## Notes

- The redirect URI must match **character for character**, including
  `/callback-byo`. A mismatch causes a `redirect_uri_mismatch` error.
- To go back to the managed service, use **Back to managed mode** in the same
  settings section.
- Your client secret is stored locally in the plugin's `data.json` (lightly
  obfuscated, not encrypted). Treat it like any credential on your device.
- The plugin requests the full Google Drive scope, which is what makes the
  "browse your whole Drive" explorer possible.

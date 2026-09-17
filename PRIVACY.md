# Privacy Policy — Drive on Demand

_Last updated: 2026-07-23_

This policy explains what data the **Drive on Demand** Obsidian plugin and its
authentication broker process, and why. The plugin and broker are operated by
**Real-IT (Loïc Bertrand)**, France.

## Summary

- The plugin runs **on your device** inside Obsidian.
- Your **notes and file contents never pass through our servers.** File data
  travels **directly between your device and Google Drive**.
- Our **authentication broker** is used **only** for the Google sign-in flow
  (exchanging and refreshing OAuth tokens), because the Google *client secret*
  must not be embedded in a public/mobile application.
- We do **not** use client-side telemetry, analytics or advertising, and we do
  **not** sell or share your data.

## What is stored on your device

Stored locally in the plugin's own data file (`data.json`), on your device only:

- Your Google **OAuth refresh token** (used to obtain short-lived access tokens).
- Your **selective-sync state** (which files/folders you chose to sync).
- A **mirror index** and a **cached copy of your Drive folder tree** (metadata
  such as file names and revision ids), to work offline and avoid re-downloading.

This data is under your control. Removing the plugin and its folder deletes it.

## What the authentication broker processes

The broker (`https://obsidian-drive-on-demand-server.real-it.org`, operated by Real-IT) is
involved **only** during Google authentication:

- **Sign-in:** it exchanges the one-time Google authorization code for tokens,
  holds them **transiently** under a single-use pairing that is deleted once
  your device claims it.
- **Token refresh:** your device sends the refresh token to the broker, which
  uses the Google *client secret* to return a short-lived access token. Tokens
  are processed to perform this exchange and are **not** retained for analytics.
- **Request logs:** the broker keeps minimal operational logs (timestamps,
  endpoint, status) **without token values**, for reliability and abuse
  prevention.

The broker **never receives your notes, documents or file contents.**

## What Google receives

The plugin calls the Google Drive API directly, using the access scope you
authorise, to **list, download and upload the files you choose to sync**. Your
use of Google Drive is also governed by
[Google's Privacy Policy](https://policies.google.com/privacy).

## Legal basis & your rights (GDPR)

Processing is based on your **consent** (you explicitly connect your account)
and on the **performance of the service** you request. As a data subject you may
request access to, correction of, or deletion of data we hold, and you may
**revoke access at any time** from your
[Google Account permissions](https://myaccount.google.com/permissions) and by
removing the plugin.

## Data retention

- On-device data: kept until you delete it (uninstall / remove the plugin folder).
- Broker: pairing data is single-use and short-lived; operational logs are kept
  for a limited period for reliability and security, then rotated.

## Payments

No payment is processed today. When a paid plan is introduced, billing will be
handled by a third-party payment provider (e.g. Stripe); this policy will be
updated to describe it before any charge occurs.

## Changes

We may update this policy; the "Last updated" date will reflect changes.
The current version is always available at
<https://real-it.org/drive-on-demand>.

## Contact

For any privacy request: **loic.bert.marcel@gmail.com** (Real-IT).

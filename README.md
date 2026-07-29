# Smart Board — Live Site

A public, no-login web version of the HubSpot ticket Smart Board with **two-way
sync**: changes in HubSpot appear on the board (auto-refresh every 30s), and
edits on the board (status, priority, dates, type, tasks, descriptions, notes)
write straight back to HubSpot.

## How it works

```
Browser (public board)  ──►  /api/hs  (serverless, holds token)  ──►  HubSpot CRM API
        │  passcode header          │  Bearer token (never sent to browser)
        └──────────── tickets / writes ◄─────────────────────────────────┘
```

- `index.html` — the board. A small bridge script routes its data calls to
  `/api/hs` and shows a passcode gate.
- `api/hs.js` — the proxy. Holds the HubSpot token and translates the board's
  four operations into HubSpot v3/v4 API calls.

The board is locked behind a shared **passcode** (there is no HubSpot login on a
public URL, so this is what stops strangers editing the CRM). The HubSpot token
lives only in the server environment and is never exposed to the browser.

## 1. Create the HubSpot Private App

In portal **242531638**: Settings → Integrations → Private Apps → **Create a private app**.

On the **Scopes** tab, enable read **and** write for the CRM objects the board uses:

| Object   | Scopes to enable                                     |
| -------- | ---------------------------------------------------- |
| Tickets  | `crm.objects.tickets.read`, `crm.objects.tickets.write` |
| Deals    | `crm.objects.deals.read`  (for the hotel names)      |
| Tasks    | read + write (checklists)                            |
| Notes    | read + write (ticket notes)                          |

> In current HubSpot portals, Tasks and Notes read/write are covered by the
> **`crm.objects.commercepayments`**-style granular toggles listed under
> **CRM → “Tasks”** and **“Notes”**. If you don't see separate Note/Task
> toggles, granting `crm.objects.contacts.read/write` plus the engagement
> scopes shown in the picker is sufficient — enable read + write wherever
> "Tasks" and "Notes" appear.

Create the app, then copy the **Access token** (looks like `pat-na2-…`).
**Keep it secret — do not paste it into chat or commit it.**

## 2. Deploy to Vercel

**Option A — Vercel CLI (from this folder):**

```bash
npm i -g vercel
vercel            # first run: link/create the project, accept defaults
vercel --prod     # deploy to the production URL
```

**Option B — Dashboard:** push this folder to a Git repo, then Vercel →
**Add New → Project → Import**, and deploy (framework preset: *Other*).

## 3. Set the two environment variables

Vercel → your project → **Settings → Environment Variables**. Add both for the
**Production** (and Preview) environment:

| Name             | Value                                              |
| ---------------- | -------------------------------------------------- |
| `HUBSPOT_TOKEN`  | the `pat-na2-…` token from step 1                  |
| `BOARD_PASSCODE` | a strong passcode you'll share with board users    |

Then **redeploy** (`vercel --prod`, or Deployments → ⋯ → Redeploy) so the
functions pick up the variables.

## 4. Use it

Open the production URL, enter the passcode once (it's remembered on that
device), and the board loads live from HubSpot. Share the URL + passcode with
whoever needs access.

## Notes & tuning

- **Refresh cadence:** `index.html` polls every 30s (`setInterval(..., 30000)`).
  Raise the number to reduce API calls; lower it for fresher data.
- **Rotate access:** change `BOARD_PASSCODE` in Vercel and redeploy to cut off
  old links. Rotate `HUBSPOT_TOKEN` in HubSpot if it's ever exposed.
- **Owner/portal** are pinned in `api/hs.js` (`OWNER`) and `index.html`
  (`OWNER`, `PORTAL`, region `na2`). Update both if they change.
- **Near-instant HubSpot→board updates** would need HubSpot webhooks + a push
  channel; polling every 30s is the simple, reliable default.

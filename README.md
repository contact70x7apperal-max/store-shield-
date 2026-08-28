# StoreShield

A Shopify app that adds a small set of **real, checkable** storefront and
theme security features — built as an honest alternative to listings that
sell vague "improve trust / strengthen security" copy without saying what
the code actually does.

`StoreShield` is a placeholder name. Rename it (in `shopify.app.toml`,
`package.json`, and the UI copy in `app/routes/app.tsx` /
`app/routes/app._index/route.tsx`) before you publish it anywhere.

## What's real vs. what's cosmetic

Every feature below is scoped honestly. Nothing here replaces Shopify's own
platform security (HTTPS/TLS, PCI-compliant checkout, DDoS protection,
secure session cookies) — that's already active on every Shopify store
regardless of installed apps, because Shopify controls the infrastructure
and merchants don't have server access to change it. Any app claiming to
add that layer is describing something it structurally cannot do.

| Feature | What it actually does | Real limitation |
|---|---|---|
| CSP hardening | Adds a `Content-Security-Policy` meta tag restricting which domains can run scripts on your storefront. Narrows damage from a compromised third-party script. | Theme app extensions can only inject into the page `<body>`, not `<head>` — a Shopify platform rule, not a shortcut we took. For full effect you paste one snippet into `theme.liquid`'s `<head>` (the settings page shows the exact tag). The body-injected version is still applied at runtime as a weaker, best-effort layer. |
| Bot/scraper mitigation | Honeypot field + submission-timing check on every storefront form. | Stops naive/scripted bots. Does nothing against a human attacker or a bot written specifically to target this app. |
| Rate limiting | Server-side cap on submissions per browser (random client id, not a device fingerprint) within a time window. | Cleared by clearing localStorage or using a different browser — this blunts casual abuse, it isn't fraud-proof. |
| Security scan | Greps your live theme's `.liquid`/`.js`/`.json` files for hardcoded API keys, risky inline patterns, and known-outdated libraries via the Admin GraphQL API. | Pattern-based, not a full static analyzer — reports the exact file/line for every hit so you can verify each one yourself; it won't catch everything. |
| Trust badge | A small "Protected by StoreShield" badge near checkout. | **Explicitly cosmetic.** It's a conversion/trust signal, not a security mechanism, and the UI says so. Off by default. |

If you plan to sell this in the Shopify App Store, keep the copy on your
listing this specific — a specific, checkable claim ("blocks form-spam
bots via honeypot + timing checks") builds more durable trust than a vague
one ("strengthens security"), and vague security claims are also more
likely to draw App Store review scrutiny.

## Project layout

```
app/                     Remix admin app (embedded in Shopify admin)
  routes/app._index      Settings dashboard (feature toggles)
  routes/app.scan        On-demand theme vulnerability scan
  routes/app.activity    Log of blocked/allowed submissions
  routes/proxy.*         App Proxy endpoints the storefront script calls
  routes/webhooks.*      GDPR/uninstall cleanup webhooks
extensions/security-suite/
  blocks/security-suite.liquid   App embed block (merchant toggles on once)
  blocks/csp-meta-tag.liquid     Optional manual <head> snippet for full CSP
  assets/security-suite.js       All storefront-side logic, one file
prisma/schema.prisma      Session storage + settings + event log + scan findings
```

## Setup

1. **Prerequisites**: a [Shopify Partner account](https://partners.shopify.com)
   and a development store, plus the [Shopify CLI](https://shopify.dev/docs/apps/tools/cli)
   (`npm install -g @shopify/cli@latest`).
2. Install dependencies:
   ```
   npm install
   ```
3. Link the app to a Partner Dashboard app record (creates one if needed):
   ```
   npm run config:link
   ```
   This fills in `client_id` and the URLs in `shopify.app.toml` for you —
   the placeholders in that file (`REPLACE_WITH_YOUR_CLIENT_ID`,
   `REPLACE_WITH_YOUR_APP_URL`) get overwritten.
4. Copy `.env.example` to `.env` and fill in `SHOPIFY_API_KEY` /
   `SHOPIFY_API_SECRET` from the Partner Dashboard (Client credentials).
5. Set up the database:
   ```
   npx prisma migrate dev --name init
   ```
6. Start the dev server (this also tunnels a public URL and installs the
   app on your dev store):
   ```
   npm run dev
   ```
7. In the dev store's theme editor, go to **App embeds** and turn on
   "StoreShield protection" — this is the one manual step every merchant
   does once after installing.
8. Open the app in Shopify admin, go to **Protection settings**, and turn
   on the features you want. If you enable CSP hardening, copy the tag
   shown there into `theme.liquid`'s `<head>` for full effect.

## Deploying

```
npm run deploy
```
pushes the extension config to Shopify. For production you'll also want a
real Postgres/MySQL database instead of the default SQLite (`prisma/schema.prisma`
`datasource db` block) and to host the Remix server somewhere persistent
(Fly.io, Render, Heroku, etc.) rather than the CLI's dev tunnel.

## Before listing this on the Shopify App Store

- Rename everything from the `StoreShield` placeholder to your own brand.
- Have someone else's eyes on the scan rules (`app/routes/app.scan/scan-rules.server.ts`)
  before relying on them — they're a reasonable starting set, not exhaustive.
- Shopify's App Store review checks that listing claims match what the app
  does; the table above is written so you can copy it almost directly into
  your listing description without overselling.

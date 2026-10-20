# Build prompt — FRN Ad Board

Paste this whole file to your coding agent in VS Code. Build it exactly as specified. Where a decision is already made below, don't re-open it. Where something is a config value, put it in `config.js` and leave a clearly marked `FILL ME` so a non-engineer can edit it later.

---

## 1. What we're building

A single-page website that shows Food Revolution Network (FRN) every ad that runs under their whitelisting, which ones are live right now, which ones are paused, and a one-click preview of each ad.

FRN has no access to Ads Manager. This board is their window into it. One public URL, no login, works on phone. It refreshes itself once a day.

**It is partner-facing, not internal.** Never put spend, ROAS, CTR, CPA, budgets, audiences, or any performance metric into the data file or the UI. Only: ad name, campaign, status, launch date, preview.

---

## 2. Stack (locked — don't substitute)

- Node 20 sync script, no framework. Native `fetch`. Zero runtime dependencies if possible (`dotenv` for local dev is fine).
- Frontend: one `index.html` + `styles.css` + `app.js`. Vanilla JS. No React, no build step, no bundler, no Tailwind CDN.
- Data handoff: the sync script writes `public/data.json`. The frontend only ever reads that file. The frontend never talks to Meta.
- Scheduling: GitHub Actions cron. Hosting: Vercel, auto-deploying from the repo on push.

Repo layout:

```
/config.js            # everything a human might want to change
/sync.js              # pulls from Meta, writes public/data.json
/public/index.html
/public/styles.css
/public/app.js
/public/data.json     # generated — committed by the Action
/.github/workflows/refresh.yml
/.env.example
/README.md
```

---

## 3. Config file

`config.js` exports one object. Top of the file, in a block comment, list the values a human has to fill in. Use these defaults:

```js
export default {
  apiVersion: "v21.0",              // pin it; bump deliberately
  adAccountId: "FILL ME",           // act_XXXXXXXXXX  -> env META_AD_ACCOUNT_ID
  startDate: "2026-01-01",          // nothing created before this date is shown

  // How we know an ad is FRN whitelisting (see §5.2)
  frn: {
    pageIds: ["FILL ME"],           // FRN Facebook Page ID(s)
    instagramIds: ["FILL ME"],      // FRN Instagram account ID(s)
    nameTokens: ["FRN", "WL-FRN", "FOODREV"]  // fallback match on ad name
  },

  // How we read batch + version out of an ad name (see §5.3)
  batchRegex: "\\bB[-_ ]?(\\d{2,6})\\b",
  versionRegex: "\\bV[-_ ]?(\\d{1,3})\\b",

  // Campaign buckets for the filter. First match wins, order matters.
  campaignBuckets: [
    { label: "Webinar — Laurie & Ocean", match: "laurie|ocean" },
    { label: "Cheat Sheet",              match: "cheat ?sheet" },
    { label: "Direct Response",          match: "\\b(dr|direct ?response|sales|conversion|purchase)\\b" }
  ],
  fallbackBucket: "Other",

  brand: {
    title: "FRN Ad Board",
    subtitle: "Every Complement ad running under Food Revolution Network whitelisting.",
    timezone: "America/New_York"
  }
};
```

`adAccountId` and the Meta token come from env vars at runtime (`META_AD_ACCOUNT_ID`, `META_ACCESS_TOKEN`). **The access token must never be written into `data.json`, logged, or committed.**

---

## 4. Meta access

- Long-lived System User token with `ads_read` and `ads_management` (previews need it).
- Local dev: `.env`. CI: GitHub Actions secrets. Ship `.env.example` with the two names and no values.
- Respect rate limits: max 5 concurrent requests, exponential backoff with jitter on HTTP 429 and on Meta error codes 17, 32, 613, 80000–80004. Retry 4 times, then record the ad as `previewUrl: null` and keep going. **A single failed ad must never abort the run.**

---

## 5. The sync script

### 5.1 Pull the ads

`GET /{apiVersion}/act_{adAccountId}/ads`

Fields:
```
id,name,status,effective_status,created_time,
adset{id,name},campaign{id,name},
creative{id,thumbnail_url,effective_object_story_id,instagram_user_id,source_instagram_media_id,object_story_spec}
```

- `limit=200`, follow `paging.next` until exhausted.
- Pass `effective_status` including `ACTIVE, PAUSED, ADSET_PAUSED, CAMPAIGN_PAUSED, PENDING_REVIEW, DISAPPROVED, WITH_ISSUES, ARCHIVED` so paused and archived ads come back too. If the API rejects `ARCHIVED` in that array, drop it and log a one-line warning.
- Also send `filtering` on `ad.created_time` greater than `startDate` — but **re-filter in code on `created_time >= startDate` regardless**. The code-side filter is the source of truth.
- Drop anything with `effective_status === "DELETED"`.

### 5.2 Keep only FRN whitelisting ads

An ad qualifies if **either** rule hits:

**Rule A — identity (authoritative).** Any of:
- `creative.object_story_spec.page_id` is in `frn.pageIds`
- `creative.object_story_spec.instagram_actor_id` or `creative.instagram_user_id` is in `frn.instagramIds`
- `creative.effective_object_story_id` starts with `"{frnPageId}_"`

**Rule B — name fallback.** The ad name contains one of `frn.nameTokens`, case-insensitive, bounded by a non-alphanumeric character or string edge (so `FRN` matches, `FRNT` doesn't).

Record which rule matched as `frnMatch: "identity" | "name"` in the JSON. At the end of the run, print to the log: total ads pulled, kept by identity, kept by name only, dropped. That log is how we audit whether the page IDs are right.

### 5.3 Reconcile duplicates

We duplicate the same ad across ad sets to test audiences, so the same creative shows up many times with near-identical names. FRN must see each ad **once**.

1. **Clean the name.** Repeatedly strip, until the string stops changing:
   - trailing `- Copy`, `– Copy`, `_copy`, `copy 2`, `copia 3` (case-insensitive, optional number)
   - trailing ` (1)`, ` (2)`
   - then collapse whitespace and trim.
2. **Parse** `batchRegex` and `versionRegex` against the cleaned name.
3. **Group key:**
   - both found → `` `${batch}|${version}` ``
   - otherwise → `` `name:${cleanedName.toLowerCase()}` ``
   Never drop an ad because it didn't parse. Falling back to the cleaned name is always correct enough.
4. **Status of the group:** if **any** ad in the group has `effective_status === "ACTIVE"` → the group is **Live**. Only if **every** ad in the group is non-active → **Paused**. One live beats four paused, always.
5. **Representative ad:** the most recently created `ACTIVE` ad if the group is Live; otherwise the most recently created ad in the group. Its name, thumbnail, campaign and preview represent the group.
6. Keep `copies` = number of ads in the group, and `campaignBuckets` = the set of buckets any ad in the group falls into (a group matches a campaign filter if **any** of its ads is in that campaign).

### 5.4 Previews

For the representative ad only (not every duplicate — it's the same creative):

`GET /{apiVersion}/{adId}/previews?ad_format=...`

Try in order, take the first that returns an iframe: `MOBILE_FEED_STANDARD` → `DESKTOP_FEED_STANDARD` → `INSTAGRAM_STANDARD`. Extract the `src` from the returned iframe HTML and store it as `previewUrl`, plus `previewFormat`. If all three fail, `previewUrl: null`.

These preview URLs carry a short-lived preview token — that's exactly why we regenerate them on every daily run. Never try to cache them longer than a run.

### 5.5 Output

`public/data.json`:

```json
{
  "lastUpdated": "2026-10-20T12:03:11.000Z",
  "timezone": "America/New_York",
  "counts": { "total": 61, "live": 18, "paused": 43 },
  "buckets": ["Webinar — Laurie & Ocean", "Cheat Sheet", "Direct Response", "Other"],
  "ads": [
    {
      "id": "1203...",
      "name": "B0142_V3_Ocean_Testimonial_30s",
      "batch": "0142",
      "version": "3",
      "status": "live",
      "campaignName": "FRN WL — Webinar Laurie & Ocean — Broad",
      "buckets": ["Webinar — Laurie & Ocean"],
      "launchedAt": "2026-03-04T00:00:00.000Z",
      "thumbnailUrl": "https://...",
      "previewUrl": "https://www.facebook.com/ads/api/preview_iframe.php?...",
      "previewFormat": "MOBILE_FEED_STANDARD",
      "copies": 4,
      "frnMatch": "identity"
    }
  ]
}
```

Write the file atomically (temp file, then rename). If the Meta pull fails entirely, **leave the previous `data.json` untouched and exit non-zero** — a stale board beats an empty one.

---

## 6. Daily refresh

`.github/workflows/refresh.yml`:

- `on: schedule` at `0 12 * * *` **and** `0 13 * * *`, plus `workflow_dispatch` for manual runs.
- First step guards the time: compute the current hour in `America/New_York`; if it isn't `8`, exit 0 without doing anything. Two crons + this guard = always 8:00 AM ET, through daylight saving, with no drift.
- Then: checkout, Node 20, `node sync.js`, and commit `public/data.json` if it changed (`git diff --quiet || commit && push`). The push is what triggers the Vercel deploy.
- Secrets: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`.

---

## 7. The interface

This is the part that matters most. It should look like a small, well-made product — not an internal tool, not a spreadsheet, not a dashboard full of widgets. Calm, warm, obvious. A person who has never seen it should understand it in three seconds without instructions.

### Layout

One centered column, `max-width: 1120px`, `padding: 24px`.

1. **Top bar.** Far left, small and muted (12px): `Last updated · today at 8:00 AM ET`. Use "today" / "yesterday" / the date, computed from `lastUpdated` rendered in the config timezone. Nothing else in that row.
2. **Header.** Title (28px, 600) and one-line subtitle (15px, muted). Generous space below.
3. **Filter bar.** Sticky to the top on scroll with a soft blur backdrop.
   - Row 1: campaign pills — `All` first, then one per bucket that actually has ads, each with its count: `Cheat Sheet · 12`. Hide empty buckets.
   - Row 2: status segmented control — `All` / `Live` / `Paused` — and a search box on the right (placeholder: `Search ads…`, filters on ad name and batch, debounced 150ms).
   - Below, muted 13px: `Showing 24 of 61 ads`.
4. **Grid.** `repeat(auto-fill, minmax(300px, 1fr))`, `gap: 20px`. One column on mobile.
5. **Footer.** One muted line: `Ads shown once per version — duplicates across ad sets are merged.` Nothing else.

### The card

- Thumbnail on top, 16:9, `object-fit: cover`. If there's no thumbnail, a soft gradient block with the batch number centered in it — never a broken image.
- Status pill, absolute, top-right over the thumbnail, white background with a slight blur: a 6px dot + label. **Live** = green dot `#16A34A`. **Paused** = grey dot `#9CA3AF`.
- Ad name: 15px, 600, clamped to two lines.
- Meta row: small chips, 12px, muted — campaign bucket · `Batch 0142 · V3` · `Launched Mar 4`. If the group spans more than one bucket, add a `+1` chip.
- If `copies > 1`, a 12px muted line: `4 versions running across ad sets`.
- Footer button, full width, ghost style: `View ad preview`. If `previewUrl` is null, it's disabled with the label `Preview unavailable`.
- Hover: lift 2px, shadow deepens, 150ms ease. Whole card is clickable, not just the button.

### The preview modal

- Opens centered, dimmed backdrop, `max-width: 480px` (phone-feed proportions), rounded 16px.
- Header: ad name + status pill, close ×.
- Body: the preview iframe, lazy-loaded **only when the modal opens** (never render iframes in the grid — it would be unusably slow).
- Below the iframe: `Open in a new tab ↗` linking to the same URL.
- Closes on ×, backdrop click, and Esc. Restores scroll position and focus to the card that opened it.
- If the iframe fails to load within 8 seconds: a friendly line — `This preview expired. It'll be back after tomorrow morning's refresh.`

### Sorting

Live first, then newest launch date first. Inside the same status, newest first.

### States

- **Loading:** six grey skeleton cards, gentle pulse. No spinner.
- **No results:** centered, friendly — `No ads match those filters.` plus a `Clear filters` button.
- **Stale data:** if `lastUpdated` is more than 36 hours old, a soft amber bar under the header: `Heads up — this board hasn't refreshed since Saturday. We're on it.`
- **data.json missing or broken:** `We couldn't load the board right now. Try again in a few minutes.` Never a raw error, never a blank page.

### Visual system

```
Background      #FAFAF7   (warm paper, not white)
Surface         #FFFFFF
Border          #ECEAE4
Text            #1C1B19
Muted text      #6B6962
Accent          #2E7D5B
Live            #16A34A
Paused          #9CA3AF
Radius          cards 14px · pills 999px · modal 16px
Shadow          0 1px 2px rgba(0,0,0,.04) → hover 0 8px 24px rgba(0,0,0,.08)
Spacing         4 / 8 / 12 / 16 / 24 / 32 only
Font            Inter (Google Fonts, 400/500/600) with a system fallback stack
```

Rules: light theme only — set `color-scheme: light` so dark-mode browsers don't invert it. No gradients except the thumbnail fallback. No icon library — inline SVG for the search icon and the close ×. No emoji in the UI. Visible focus rings on every interactive element. Everything responsive down to 360px; the filter rows scroll horizontally on mobile instead of wrapping into a tall block.

Plain words only. Live, Paused, Campaign, Launched, Preview. Never "effective status", "ad set", "creative ID", "batch ID" — on the card it's just `Batch 0142`.

---

## 8. Deploy

1. Private GitHub repo.
2. Import it into Vercel. Root directory `public`, framework preset "Other", no build command.
3. **Turn Deployment Protection off** so the link works for anyone, no Vercel login.
4. Add the two secrets in GitHub (Actions → Secrets): `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`.
5. Run the workflow manually once to seed `data.json`, confirm the board renders, then hand over the URL.

---

## 9. README

Short, written for a marketer, not an engineer. Four sections only:

- What this board shows
- How to add or rename a campaign filter (edit `campaignBuckets` in `config.js`, push)
- How to force a refresh right now (Actions → Refresh board → Run workflow)
- What to do if the board looks empty or stale (check the latest Action run)

---

## 10. Done when

- [ ] Only ads created on or after `startDate` appear.
- [ ] Only FRN-whitelisted ads appear, and the run log shows how many matched by identity vs. by name.
- [ ] Each version appears exactly once. A group with one active ad and four paused shows as **Live**. A group with zero active shows as **Paused**.
- [ ] Ads whose names don't parse still appear, grouped by cleaned name.
- [ ] Every card either opens a working preview or says the preview is unavailable.
- [ ] Campaign filter, status filter and search combine correctly, and the result count matches what's on screen.
- [ ] No spend, performance, audience or budget data anywhere in `data.json` or the UI.
- [ ] The access token appears in no committed file and in no log line.
- [ ] The board renders cleanly at 360px and at 1440px.
- [ ] The timestamp reads `Last updated · today at 8:00 AM ET` and is still correct the day daylight saving changes.
- [ ] A failed Meta pull leaves yesterday's board up instead of wiping it.

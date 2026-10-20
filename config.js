/*
 * FRN Ad Board — settings
 *
 * Values a human has to fill in before the first run:
 *
 *   1. frn.pageIds       FRN's Facebook Page ID(s) — filled in (282915761783958)
 *   2. frn.instagramIds  FRN's Instagram account ID(s), e.g. ["17841400000000000"] (optional)
 *
 * Set as secrets (GitHub → Settings → Secrets and variables → Actions),
 * or in a local .env file. Never paste them into this file:
 *
 *   META_AD_ACCOUNT_ID   act_XXXXXXXXXX (the "act_" part is optional)
 *   META_ACCESS_TOKEN    long-lived System User token (ads_read + ads_management)
 *
 * Anything still reading "FILL ME" is ignored by the sync.
 *
 * To add or rename a campaign filter, edit campaignBuckets below and push.
 * "match" is checked against the campaign name, ignoring upper/lower case.
 */

export default {
  apiVersion: "v21.0",              // pin it; bump deliberately
  adAccountId: "FILL ME",           // act_XXXXXXXXXX  -> env META_AD_ACCOUNT_ID
  startDate: "2026-01-01",          // nothing created before this date is shown

  // How we know an ad is FRN whitelisting (see §5.2)
  frn: {
    pageIds: ["282915761783958"],   // Food Revolution Network Facebook Page
    instagramIds: [],               // FRN Instagram account ID(s) — none linked to the Complement ad account yet
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

#!/usr/bin/env node
// Pulls FRN whitelisting ads from Meta and writes public/data.json.
// The frontend only ever reads that file. Run: node sync.js

import { existsSync, readFileSync } from "node:fs";
import { writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "./config.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(ROOT, "public", "data.json");
const GRAPH = "https://graph.facebook.com";

const MAX_CONCURRENT = 5;
const MAX_RETRIES = 4;
const RETRY_CODES = new Set([17, 32, 613, 80000, 80001, 80002, 80003, 80004]);
const STATUSES = ["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "PENDING_REVIEW", "DISAPPROVED", "WITH_ISSUES", "ARCHIVED"];
const PREVIEW_FORMATS = ["MOBILE_FEED_STANDARD", "DESKTOP_FEED_STANDARD", "INSTAGRAM_STANDARD"];
const AD_FIELDS = [
  "id", "name", "status", "effective_status", "created_time",
  "adset{id,name}", "campaign{id,name}",
  // Only the object_story_spec keys we match on; the full spec is huge and trips Meta's size limit.
  "creative{id,thumbnail_url,effective_object_story_id,instagram_user_id,source_instagram_media_id,object_story_spec{page_id,instagram_actor_id,instagram_user_id}}"
].join(",");
const PAGE_SIZES = [200, 100, 50, 25];
// Meta's "Please reduce the amount of data you're asking for" (code 1).
const isTooMuchData = e => e.code === 1 && /reduce the amount of data/i.test(e.message);

// ---------- env + logging ----------

loadDotEnv(path.join(ROOT, ".env"));

const TOKEN = (process.env.META_ACCESS_TOKEN || "").trim();
const ACCOUNT_ID = (process.env.META_AD_ACCOUNT_ID || config.adAccountId || "").trim().replace(/^act_/, "");

// Every log line goes through here so the token can never be printed.
function log(...parts) {
  const line = parts.map(p => (p instanceof Error ? p.message : String(p))).join(" ");
  console.log(TOKEN ? line.split(TOKEN).join("[redacted]") : line);
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

// ---------- Graph API client ----------

class GraphError extends Error {
  constructor(message, { status = 0, code = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

const limit = createLimiter(MAX_CONCURRENT);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Exponential backoff with jitter: ~2s, 4s, 8s, 16s (each randomised between half and full).
const backoff = attempt => {
  const cap = 2000 * 2 ** attempt;
  return cap / 2 + Math.random() * (cap / 2);
};

async function graph(pathOrUrl, params = {}) {
  const url = pathOrUrl.startsWith("https://")
    ? new URL(pathOrUrl)
    : new URL(`${GRAPH}/${config.apiVersion}/${pathOrUrl}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  // The token travels in a header only, never in a URL that could be logged.
  url.searchParams.delete("access_token");

  for (let attempt = 0; ; attempt++) {
    let error;
    try {
      const body = await limit(async () => {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const json = await res.json().catch(() => null);
        if (res.ok && json && !json.error) return json;
        const e = json?.error || {};
        const code = typeof e.code === "number" ? e.code : null;
        const err = new GraphError(e.message || `HTTP ${res.status}`, { status: res.status, code });
        // A too-big response won't shrink by waiting; the caller asks for less instead.
        err.retryable = !isTooMuchData(err) && (res.status === 429 || res.status >= 500 || RETRY_CODES.has(code));
        throw err;
      });
      return body;
    } catch (e) {
      error = e instanceof GraphError ? e : new GraphError(`Network error: ${e.message}`, { retryable: true });
    }
    if (!error.retryable || attempt >= MAX_RETRIES) throw error;
    await sleep(backoff(attempt));
  }
}

// ---------- helpers ----------

const isFilled = v => v != null && String(v).trim() !== "" && !/fill me/i.test(String(v));
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Meta returns "2026-03-04T10:22:11-0500"; make the offset ISO so Date.parse is reliable.
const parseMetaTime = t => Date.parse(String(t || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

// Midnight of a YYYY-MM-DD date in the given time zone, as epoch ms.
function startOfDayIn(dateStr, timeZone) {
  const guess = Date.parse(`${dateStr}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(new Date(guess));
  const get = type => Number(parts.find(p => p.type === type).value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return guess - (asIfUtc - guess);
}

// ---------- 5.1 pull ----------

async function pullAds(startMs) {
  const afterSeconds = Math.floor(startMs / 1000) - 1;
  const withoutArchived = STATUSES.filter(s => s !== "ARCHIVED");
  const attempts = [
    { statuses: STATUSES, filter: true },
    { statuses: withoutArchived, filter: true, warn: "Warning: Meta rejected ARCHIVED in effective_status; pulling without it." },
    { statuses: withoutArchived, filter: false, warn: "Warning: Meta rejected the created_time filter; filtering in code only." }
  ];

  for (let i = 0; i < attempts.length; i++) {
    const { statuses, filter, warn } = attempts[i];
    if (warn) log(warn);
    const params = { fields: AD_FIELDS, limit: String(PAGE_SIZES[0]), effective_status: statuses };
    if (filter) params.filtering = [{ field: "ad.created_time", operator: "GREATER_THAN", value: afterSeconds }];

    let page;
    try {
      page = await fetchPage(`act_${ACCOUNT_ID}/ads`, params);
    } catch (e) {
      // Code 100 = invalid parameter. Step down to a simpler request; anything else is fatal.
      if (e.code === 100 && i < attempts.length - 1) continue;
      throw e;
    }

    const ads = [...(page.data || [])];
    while (page.paging?.next) {
      page = await fetchPage(page.paging.next);
      ads.push(...(page.data || []));
    }
    return ads;
  }
  return [];
}

// Fetch one page of ads, shrinking the page size whenever Meta says the response is too big.
let pageSize = PAGE_SIZES[0];
async function fetchPage(pathOrUrl, params) {
  for (;;) {
    const url = pathOrUrl.startsWith("https://") ? new URL(pathOrUrl) : null;
    if (url) url.searchParams.set("limit", String(pageSize));
    try {
      return url ? await graph(url.href) : await graph(pathOrUrl, { ...params, limit: String(pageSize) });
    } catch (e) {
      const smaller = PAGE_SIZES.find(n => n < pageSize);
      if (!isTooMuchData(e) || !smaller) throw e;
      log(`Meta asked for smaller pages; retrying with ${smaller} ads per page.`);
      pageSize = smaller;
    }
  }
}

// ---------- 5.2 FRN filter ----------

function buildFrnMatcher() {
  const pageIds = new Set(config.frn.pageIds.filter(isFilled).map(String));
  const igIds = new Set(config.frn.instagramIds.filter(isFilled).map(String));
  const tokens = config.frn.nameTokens.filter(isFilled).map(escapeRe);
  const nameRe = tokens.length ? new RegExp(`(?:^|[^a-z0-9])(?:${tokens.join("|")})(?=$|[^a-z0-9])`, "i") : null;

  if (pageIds.size === 0) log("Warning: frn.pageIds is not filled in; matching by Instagram ID and ad name only.");
  if (igIds.size === 0) log("Warning: frn.instagramIds is not filled in.");

  return ad => {
    const creative = ad.creative || {};
    const spec = creative.object_story_spec || {};
    if (spec.page_id && pageIds.has(String(spec.page_id))) return "identity";
    for (const id of [spec.instagram_actor_id, spec.instagram_user_id, creative.instagram_user_id]) {
      if (id && igIds.has(String(id))) return "identity";
    }
    const story = creative.effective_object_story_id;
    if (story && [...pageIds].some(p => String(story).startsWith(`${p}_`))) return "identity";
    if (nameRe && nameRe.test(ad.name || "")) return "name";
    return null;
  };
}

// ---------- 5.3 reconcile duplicates ----------

const COPY_SUFFIX = /(?:^|[\s_\-–—]+)(?:copy|copia)(?:[\s_]*\d+)?\s*$/i;
const NUMBER_SUFFIX = /\s*\(\d+\)\s*$/;

function cleanName(name) {
  let s = String(name || "").trim();
  for (;;) {
    const next = s.replace(COPY_SUFFIX, "").replace(NUMBER_SUFFIX, "").replace(/\s+/g, " ").trim();
    if (next === s || next === "") break;
    s = next;
  }
  return s;
}

const batchRe = new RegExp(config.batchRegex, "i");
const versionRe = new RegExp(config.versionRegex, "i");

// Underscores count as word characters for \b, so "B0142_V3" would never match.
// Parse a copy of the name with underscores read as spaces.
function parseBatchVersion(cleaned) {
  const s = cleaned.replace(/_/g, " ");
  return { batch: s.match(batchRe)?.[1] ?? null, version: s.match(versionRe)?.[1] ?? null };
}

const bucketMatchers = config.campaignBuckets.map(b => ({ label: b.label, re: new RegExp(b.match, "i") }));
const bucketOf = campaignName =>
  bucketMatchers.find(b => b.re.test(campaignName || ""))?.label ??
  (config.autoBuckets && autoBucket(campaignName)) ??
  config.fallbackBucket;

// Campaigns are named "KH | Lead Gen | Cyrus Protein Webinar - Jul 23 | CBO":
// owner initials | type | topic | setup details. Build a label from type + topic.
const CAMPAIGN_NOISE = /^(?:[A-Z]{2,3}|cbo|abo|asc|scaling|evergreen|v?\d+(?:\.\d+)*)$/i;
function autoBucket(campaignName) {
  const parts = String(campaignName || "").split("|").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const [type, topic] = parts.length >= 3 && /^[A-Z]{2,3}$/.test(parts[0]) ? [parts[1], parts[2]] : [null, parts.find(p => !CAMPAIGN_NOISE.test(p))];
  if (!topic) return null;
  const webinar = topic.match(/^(.*?)\s*\bwebinar\b\s*(?:-\s*)?(.*)$/i);
  if (webinar) return `Webinar — ${webinar[1] || topic}${webinar[2] ? ` (${webinar[2]})` : ""}`;
  return type && !/lead ?gen/i.test(type) ? `${type} — ${topic}` : topic;
}

// Configured buckets first in config order, then auto ones alphabetically, then the fallback.
function bucketOrder(used) {
  const fixed = config.campaignBuckets.map(b => b.label);
  const auto = [...used].filter(b => !fixed.includes(b) && b !== config.fallbackBucket).sort();
  return [...fixed, ...auto, config.fallbackBucket];
}

// Ad names follow "META | PROS | EVG | BV | 30%-OFF | WOMEN 40+ | EXPERT-AUTHORITY | | ITR- | V1 |
// UGC VID | OCEAN | WL_YES | … | EXP239 | H1 - WL". Fields shift around, so pick them out by shape.
// Returns a short title ("EXP239 · H1") and a details line ("UGC video · Ocean · Plant-based"),
// or null when the name doesn't follow the convention (the card then shows the plain name).
const FORMATS = { "STATIC": "Static", "UGC VID": "UGC video", "VIDEO": "Video", "MASHUP": "Mashup", "CAROUSEL": "Carousel", "GIF": "GIF" };
const titleCase = s => s.toLowerCase().replace(/(^|[\s,\-+/])([a-z])/g, (_, p, c) => p + c.toUpperCase()).replace(/\b(Ugc|Bv|Frn)\b/g, w => w.toUpperCase());
function describeAdName(name) {
  const parts = String(name || "").split("|").map(s => s.trim());
  const expAt = parts.findIndex(p => /^EXP\d+$/i.test(p));
  if (expAt === -1) return null;

  const tail = parts.slice(expAt + 1).join(" ").replace(/\s*-\s*WL\s*$/i, "").trim();
  const hook = tail.match(/\bI?H\d+\b/i)?.[0].toUpperCase() ?? (tail ? titleCase(tail) : null);
  const title = [parts[expAt].toUpperCase(), hook].filter(Boolean).join(" · ");

  const formatAt = parts.findIndex(p => FORMATS[p.toUpperCase()]);
  // Talent sits between the format and the WL_ flag; anything after WL_ is team initials.
  const wlAt = parts.findIndex((p, i) => i > formatAt && /^WL_/i.test(p));
  const talent = formatAt === -1 ? null : parts.slice(formatAt + 1, wlAt === -1 ? expAt : wlAt)
    .find(p => p && !/^\d+x\d+$/i.test(p) && !FORMATS[p.toUpperCase()]);
  const offerAt = parts.findIndex(p => /%|^NA$/i.test(p));
  const audience = offerAt === -1 ? null : parts[offerAt + 1];

  const details = [
    formatAt === -1 ? null : FORMATS[parts[formatAt].toUpperCase()],
    talent ? titleCase(talent) : null,
    audience ? titleCase(audience) : null
  ].filter(Boolean).join(" · ");

  return { title, details: details || null };
}

function reconcile(ads) {
  const groups = new Map();
  for (const ad of ads) {
    const cleaned = cleanName(ad.name);
    const { batch, version } = parseBatchVersion(cleaned);
    const key = batch && version ? `${batch}|${version}` : `name:${cleaned.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ad, cleaned, batch, version, createdMs: parseMetaTime(ad.created_time) });
  }

  return [...groups.values()].map(members => {
    const newestFirst = [...members].sort((a, b) => b.createdMs - a.createdMs);
    const live = members.some(m => m.ad.effective_status === "ACTIVE");
    const rep = live ? newestFirst.find(m => m.ad.effective_status === "ACTIVE") : newestFirst[0];
    const bucketSet = new Set(members.map(m => bucketOf(m.ad.campaign?.name)));
    const parsed = members.find(m => m.batch || m.version) || rep;
    return {
      rep,
      id: rep.ad.id,
      name: rep.cleaned || rep.ad.name || "Untitled ad",
      described: describeAdName(rep.cleaned),
      batch: rep.batch ?? parsed.batch,
      version: rep.version ?? parsed.version,
      status: live ? "live" : "paused",
      campaignName: rep.ad.campaign?.name || "",
      buckets: [...bucketSet],
      launchedAt: new Date(Math.min(...members.map(m => m.createdMs))).toISOString(),
      thumbnailUrl: rep.ad.creative?.thumbnail_url || null,
      copies: members.length,
      frnMatch: members.some(m => m.ad._frnMatch === "identity") ? "identity" : "name"
    };
  });
}

// ---------- 5.4 previews + thumbnails ----------

function extractIframeSrc(html) {
  const m = String(html || "").match(/<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function fetchPreview(adId) {
  for (const format of PREVIEW_FORMATS) {
    try {
      const body = await graph(`${adId}/previews`, { ad_format: format });
      const src = extractIframeSrc(body?.data?.[0]?.body);
      if (src) return { previewUrl: src, previewFormat: format };
    } catch (e) {
      // Rate-limited even after retries: give up on this ad, keep the run going.
      if (e.retryable) break;
      // Otherwise this format just isn't available for this ad; try the next one.
    }
  }
  return { previewUrl: null, previewFormat: null };
}

// The thumbnail_url on the ad list is 64x64. Ask the creative for a card-sized one.
async function fetchThumbnail(creativeId, fallback) {
  if (!creativeId) return fallback;
  try {
    const body = await graph(creativeId, { fields: "thumbnail_url", thumbnail_width: "640", thumbnail_height: "360" });
    return body.thumbnail_url || fallback;
  } catch {
    return fallback;
  }
}

// ---------- 5.5 output ----------

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// ---------- main ----------

async function main() {
  if (!TOKEN) throw new Error("META_ACCESS_TOKEN is not set.");
  if (!isFilled(ACCOUNT_ID)) throw new Error("META_AD_ACCOUNT_ID is not set.");

  const timezone = config.brand.timezone;
  const startMs = startOfDayIn(config.startDate, timezone);

  log(`Pulling ads from Meta (${config.apiVersion}), created on or after ${config.startDate}…`);
  const pulled = await pullAds(startMs);

  const inRange = pulled.filter(ad =>
    ad.effective_status !== "DELETED" && parseMetaTime(ad.created_time) >= startMs
  );

  const matchFrn = buildFrnMatcher();
  const frnAds = [];
  let byIdentity = 0, byName = 0;
  for (const ad of inRange) {
    const match = matchFrn(ad);
    if (!match) continue;
    ad._frnMatch = match;
    match === "identity" ? byIdentity++ : byName++;
    frnAds.push(ad);
  }

  const groups = reconcile(frnAds);

  log(`Fetching previews for ${groups.length} ads…`);
  await Promise.all(groups.map(async g => {
    const [preview, thumb] = await Promise.all([
      fetchPreview(g.id),
      fetchThumbnail(g.rep.ad.creative?.id, g.thumbnailUrl)
    ]);
    Object.assign(g, preview, { thumbnailUrl: thumb });
  }));

  const ads = groups
    .map(({ rep, ...g }) => ({
      id: g.id,
      name: g.name,
      title: g.described?.title ?? null,
      details: g.described?.details ?? null,
      batch: g.batch,
      version: g.version,
      status: g.status,
      campaignName: g.campaignName,
      buckets: g.buckets,
      launchedAt: g.launchedAt,
      thumbnailUrl: g.thumbnailUrl,
      previewUrl: g.previewUrl,
      previewFormat: g.previewFormat,
      copies: g.copies,
      frnMatch: g.frnMatch
    }))
    .sort((a, b) =>
      (a.status === b.status ? 0 : a.status === "live" ? -1 : 1) ||
      Date.parse(b.launchedAt) - Date.parse(a.launchedAt)
    );

  const order = bucketOrder(new Set(ads.flatMap(a => a.buckets)));
  for (const ad of ads) ad.buckets.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const live = ads.filter(a => a.status === "live").length;
  const data = {
    lastUpdated: new Date().toISOString(),
    timezone,
    title: config.brand.title,
    subtitle: config.brand.subtitle,
    counts: { total: ads.length, live, paused: ads.length - live },
    buckets: order,
    ads
  };

  await writeAtomic(OUT_FILE, data);

  const withPreview = ads.filter(a => a.previewUrl).length;
  log("");
  log("Run summary");
  log(`  Ads pulled from Meta:          ${pulled.length}`);
  log(`  Skipped (before start/deleted): ${pulled.length - inRange.length}`);
  log(`  Kept by identity (page/IG):    ${byIdentity}`);
  log(`  Kept by name only:             ${byName}`);
  log(`  Dropped (not FRN):             ${inRange.length - frnAds.length}`);
  log(`  Shown on board (after merge):  ${ads.length}  (${live} live, ${ads.length - live} paused)`);
  log(`  Previews:                      ${withPreview} ok, ${ads.length - withPreview} unavailable`);
  log(`Wrote public/data.json`);
}

main().catch(e => {
  log(`Sync failed: ${e.message}`);
  log("public/data.json was left untouched.");
  process.exit(1);
});

# FRN Ad Board

## What this board shows

Every Complement ad running under Food Revolution Network whitelisting since January 1, 2026: whether it's **Live** or **Paused**, which campaign it belongs to, when it launched, and a preview of the ad itself.

Each ad appears once. We often run the same ad in several places to test different audiences. The board merges those copies into one card, and it shows as Live if any copy is still running.

It refreshes by itself every morning at 8:00 AM Eastern. There's no spend or performance data on it, so it's safe to share.

## How to add or rename a campaign filter

1. Open `config.js` on GitHub and click the pencil icon to edit.
2. Find `campaignBuckets`. Each line is one filter:
   ```js
   { label: "Cheat Sheet", match: "cheat ?sheet" },
   ```
   - `label` is what FRN sees on the button.
   - `match` is a word or phrase from the **campaign name** (upper or lower case doesn't matter). Use `|` for "or", e.g. `"laurie|ocean"`.
3. Filters are checked top to bottom, and an ad goes in the first one that matches. Anything that matches nothing goes in "Other".
4. Commit the change, then force a refresh (below) so the board picks it up.

## How to force a refresh right now

On GitHub, go to **Actions → Refresh board → Run workflow**, then click the green **Run workflow** button. The board updates a minute or two after the run turns green.

## What to do if the board looks empty or stale

Go to **Actions → Refresh board** and open the most recent run.

- **Red run:** the board kept yesterday's ads on purpose. Open the "Pull ads from Meta" step to see why. "Error validating access token" means the Meta token needs replacing (Settings → Secrets and variables → Actions → `META_ACCESS_TOKEN`).
- **Green run, but ads are missing:** open the "Pull ads from Meta" step and read the **Run summary** at the bottom. If "Kept by identity" is 0, FRN's Page or Instagram IDs in `config.js` are probably wrong or missing.
- **No run this morning:** GitHub sometimes skips scheduled runs. Run it by hand (above).

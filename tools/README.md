# Live prices via Amazon Product Advertising API v5

`index.html` ships with hand-captured prices. This fetcher replaces them with
live ones from PA-API, writing `data/prices.json`, which the page reads at load.

## Why a script and not browser-side

PA-API requires every request to be signed with AWS SigV4 using your **secret
key**. A static page cannot do that:

* the secret would be readable by every visitor in devtools, and
* PA-API sends no CORS headers, so browsers block the call regardless.

So signing happens here, on your machine, and the page consumes the resulting
JSON. Your keys never enter the HTML and never leave your machine.

## Setup

1. **Get credentials** — <https://affiliate-program.amazon.com/assoc_credentials/home>
   PA-API access requires **3 qualifying sales within 180 days**. Until then the
   API returns 403; the page keeps using its static prices, so nothing breaks.

2. **Create `.env`** in the project root:

   ```
   cp .env.example .env
   ```

   Then paste your keys into `.env`. It is gitignored — do not commit it, and
   do not paste keys into chat or into `index.html`.

3. **Verify signing without calling Amazon:**

   ```
   node tools/paapi-fetch.mjs --dry-run
   ```

4. **Fetch for real:**

   ```
   node tools/paapi-fetch.mjs
   ```

   Reads every `asin:"..."` out of `index.html`, batches them 10 per request
   (the PA-API limit), throttles to 1 request/second, and writes
   `data/prices.json`.

## Serving

`fetch()` on a `file://` page is blocked, so run a server:

```
python3 -m http.server 8000
```

then open <http://localhost:8000>. Opened directly from disk the page silently
falls back to its built-in prices.

## Keeping it fresh

Prices move constantly. A daily refresh via cron:

```
0 6 * * *  cd "/path/to/project" && /usr/local/bin/node tools/paapi-fetch.mjs >> /tmp/paapi.log 2>&1
```

## Operating-agreement notes

* Prices from PA-API must display the time they were retrieved — the page shows
  "live prices · <timestamp>" in the footer, driven by `fetchedAt`.
* Cached PA-API data must be refreshed at least every 24 hours.
* `data/prices.json` holds only price, title, availability and URL — no keys.

## Troubleshooting

| Symptom | Cause |
|---|---|
| 401 / 403 | Bad keys, wrong partner tag, or no qualifying sales yet |
| 429 | Rate limited — PA-API starts at 1 TPS and grows with revenue |
| `InvalidParameterValue` for an ASIN | Item delisted or not sold in this marketplace |
| Item present but `price: null` | No buyable offer right now (out of stock / 3P only) |

---

# Hosting on GitHub Pages with a price bot

Static page on GitHub Pages; a launchd job on your Mac refreshes prices and
pushes. Amazon only ever talks to your machine — your keys never go near GitHub.

```
   your Mac                          GitHub                    visitors
┌──────────────┐   git push     ┌──────────────┐   Pages   ┌──────────────┐
│ launchd /6h  │ ─────────────► │ index.html   │ ────────► │  live prices │
│ paapi-fetch  │                │ data/prices  │           │              │
│ .env (local) │                │  .json       │           └──────────────┘
└──────┬───────┘                └──────────────┘
       │ SigV4
       ▼
   PA-API
```

## 1. Repo

```
git init
git add -A
git commit -m "LLM hardware comparison"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

`.env` is gitignored. Confirm before the first push:

```
git status --porcelain | grep -c '\.env$'     # must print 0
```

## 2. Pages

Repo → Settings → Pages → Source: `Deploy from a branch`, branch `main`, folder
`/ (root)`. Live at `https://<you>.github.io/<repo>/` in a minute or two.

Because Pages serves over HTTPS, `fetch("data/prices.json")` works — the
file:// fallback to static prices no longer applies.

## 3. The bot

`tools/update-prices.sh` fetches, compares against the committed file, and
**only commits when a price actually moved** — a changed timestamp alone is
reverted, so you don't get a junk commit every 6 hours.

Install the launchd job:

```
sed "s|__PROJECT_DIR__|$PWD|g" tools/com.amznbargain.prices.plist \
  > ~/Library/LaunchAgents/com.amznbargain.prices.plist
launchctl load ~/Library/LaunchAgents/com.amznbargain.prices.plist
```

Check on it:

```
launchctl list | grep amznbargain      # 2nd column 0 = last run OK
tail -f tools/prices.log
```

Stop it:

```
launchctl unload ~/Library/LaunchAgents/com.amznbargain.prices.plist
```

Runs every 6 hours and once at load. If the Mac is asleep at the scheduled
time, launchd runs the job when it wakes.

### Push auth

The job runs non-interactively, so pushes must not prompt:

* **SSH key with no passphrase**, or one added to the Agent with
  `ssh-add --apple-use-keychain`, or
* HTTPS with a PAT in the macOS keychain
  (`git config --global credential.helper osxkeychain`).

Test it by hand once before trusting the schedule:

```
./tools/update-prices.sh
```

## Why not GitHub Actions

Actions would need your PA-API secret in repo secrets, and Amazon's rate limits
are per-account. Signing on your own machine keeps the credentials on one box
you control. The tradeoff: prices only update while your Mac is on.

## Compliance

* PA-API cached data must be refreshed **at least every 24h** — the 6h interval
  keeps you well inside that, and the page turns its badge amber past 24h.
* Prices must show when they were retrieved — the footer badge does this.
* Don't publish `data/prices.json` as a general-purpose price feed or dataset;
  redistributing PA-API data outside your own site breaks the agreement. Using
  it to render your own page is exactly what it's for.

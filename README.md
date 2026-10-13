# Base Watch

A phone app that scans US stocks for breakout setups (big move → tight base → push through the top on volume) and pings your phone.

- **Scanner:** `scan.mjs` runs on GitHub Actions on weekdays at 15:00 and 21:30 UTC.
- **App:** `docs/` is served free by GitHub Pages. Open it in Chrome and add it to your home screen.
- **Alerts:** pushed to the free **ntfy** app.

## Setup (about 15 minutes)

### 1. Make the repository
1. Sign up at github.com (free).
2. Top right **+** → **New repository**. Name it `base-watch`, set it to **Public**, and tick **Add a README**. Then click **Create repository**.
3. Click **Add file → Upload files**. Drag in `scan.mjs`, `README.md` and the whole `docs` folder. Click **Commit changes**.
4. The workflow file sits in a hidden folder, so add it by hand:
   - Click **Add file → Create new file**.
   - Type the name `.github/workflows/scan.yml` (the slashes create the folders).
   - Paste in the contents of `scan.yml` from this download.
   - Click **Commit changes**.

### 2. Turn on the app
**Settings → Pages**. Under *Build and deployment*, set:
- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/docs**

Click **Save**. After a minute your app is live at `https://YOUR-USERNAME.github.io/base-watch/`.

### 3. Turn on phone alerts
1. Install **ntfy** from the App Store or Google Play.
2. In ntfy, tap **+** and subscribe to your private topic name, e.g. `basewatch-99d59dbf6b`. Anyone who knows the name can read the alerts, so keep it random.
3. In GitHub, go to **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `NTFY_TOPIC`
   - Value: your topic name
   - Click **Add secret**.

### 4. Run the first scan
**Actions** tab → **Scan** → **Run workflow**. Wait 5–15 minutes, then open the app.

### 5. Put it on your phone
Open the app link in **Chrome** → **⋮** menu → **Add to Home screen**. On iPhone, use Safari → **Share** → **Add to Home Screen**.

## Changing the rules
Edit the `S` settings block near the top of `scan.mjs` (prior move, base depth, base length, ADR, near-breakout %, breakout volume).

## If something stops working
- **Scan fails:** the Actions tab shows a red ❌, and ntfy gets a "scan failed" message.
- **"Price data failed" alert:** Yahoo is blocking the requests. Try again later.
- **No runs for a long time:** GitHub pauses scheduled workflows in repos with no activity for 60 days. The scan's own commits should count as activity, but if it ever pauses, Actions shows an **Enable workflow** button.

Not financial advice. Prices: Yahoo Finance. Stock list: TradingView screener.

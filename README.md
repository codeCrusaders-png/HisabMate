# HisabMate

> *“HisabMate hai, toh sab sorted hai.”*

🌐 **Live Website:** **[https://codecrusaders-png.github.io/HisabMate/](https://codecrusaders-png.github.io/HisabMate/)**

A simple, zero-friction expense ledger that turns casual post-dinner stories and trip notes into exact, paise-accurate settlements with greedy cash-flow optimization.

Runs 100% locally in your browser with zero tracking, no accounts or signups, and full offline PWA support.

---

## Features

- **Natural Language & Voice Dictation:** Type or speak what happened casually (e.g. *"Plaban paid 1200 for lunch for all of us except Priyasi. Priyasi ate veg for 250 paid by Anuj."*).
- **Exact Integer-Paise Math:** Eliminates rounding errors by converting everything to integer paise with deterministic remainder allocation ($0.00\text{p}$ drift).
- **Debt Minimization:** Uses the Greedy Minimum Cash-Flow algorithm to resolve debts in at most $N - 1$ total transfers.
- **Strictly Outgoing "Pay To" Cards:** Clearly shows who owes whom with direct 1-click UPI payment links and QR code generator for desktop.
- **Offline PWA:** Install directly to your phone's home screen; works completely offline with a service worker.
- **Share Outing:** Generate a scannable QR code or link to instantly sync the outing with friends without a backend server.
- **Local History:** Saves active outing and past trips directly in your browser's `localStorage`.

---

## Files

- `index.html` — The complete web app (UI, parser, calculation engine, SEO metadata)
- `manifest.json` — PWA configuration for home screen installation
- `sw.js` — Service worker for offline caching
- `icon.svg`, `icon-192.png`, `icon-512.png` — App icons
- `sitemap.xml` & `robots.txt` — Search engine indexing and crawling configs
- `.nojekyll` — Bypasses Jekyll for static GitHub Pages delivery

---

## How to Run & Deploy

### Live Deployment
Access the app directly at:
👉 **[https://codecrusaders-png.github.io/HisabMate/](https://codecrusaders-png.github.io/HisabMate/)**

### Run Locally
Open `index.html` directly in any web browser, or serve it with:
```bash
npx serve .
# or
python -m http.server 8000
```

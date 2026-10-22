<div align="center">

# HisabMate

### *“HisabMate hai, toh sab sorted hai.”*

**The zero-friction, narrative expense ledger that turns casual post-dinner stories and trip notes into exact, paise-accurate settlements with greedy cash-flow debt minimization.**

[![PWA Ready](https://img.shields.io/badge/PWA-100%25%20Offline-emerald?style=for-the-badge&logo=pwa&logoColor=white)](https://github.com)
[![Zero Cloud](https://img.shields.io/badge/Privacy-100%25%20Client--Side-amber?style=for-the-badge&logo=shields.io&logoColor=white)](https://github.com)
[![Zero Drift](https://img.shields.io/badge/Math-0.00p%20Drift%20Guaranteed-sky?style=for-the-badge&logo=expert&logoColor=white)](https://github.com)
[![License](https://img.shields.io/badge/License-MIT-purple?style=for-the-badge)](LICENSE)

[Live Demo](#quick-start--deployment) • [Key Features](#key-features) • [The Mathematical Engine](#the-mathematical-engine) • [Deployment](#quick-start--deployment)

---

</div>

## Overview

Post-dinner bill math and trip settlements shouldn't feel like an engineering exam. Most bill-splitting apps force every friend to download an app, create an account, log in with phone numbers, and manually fill out 15 form fields per receipt.

**HisabMate** rethinks group expenses from first principles:
- **Zero Friction:** No signup, no phone numbers, no cloud tracking, no paywalls.
- **Narrative NLP Parser:** Simply type or dictate what happened in plain English or Hinglish (e.g., *"Plaban paid 1200 for lunch for all of us except Priyasi. Priyasi ate veg for 250 paid by Anuj."*).
- **Exact Integer-Paise Math:** Guaranteed $0.00\text{p}$ floating-point drift with deterministic remainder allocation.
- **Greedy Cashflow Minimization:** Compresses complex webs of debt into at most $N - 1$ peer-to-peer transfers.
- **Strictly Outgoing "Pay To" Cards:** Every debtor sees exactly who to pay and how much, with 1-click UPI deep links and scannable QR codes for desktop users.
- **Native Serverless Outing Sharing:** Share entire outing ledgers via scannable QR codes or URL hash fragments (`#data=...`) without needing a backend database.

---

## Key Features

### 🎙️ Natural Language Story Parser & Speech Dictation
- Write or speak casually using browser-native Speech Recognition (`Web Speech API`).
- Extracts **Payer** by matching squad names alongside trigger verbs (`paid`, `spent`, `bought`, `chipped in`, `handled`, `covered`).
- Extracts **Amount** by prioritizing currency patterns (`for 40`, `worth 250`, `₹1200`, `rs 500`) while explicitly penalizing count/quantity tokens (`2 water bottles`, `4 plates`) so item counts are never mistaken for money.
- Understands **Exclusions** (`except Priyasi`, `without Anuj`, `excluding Rohan`) and automatic inclusion subsets (`for Priyasi`, `split between Plaban and Anuj`).

### 👥 Tactile Squad Tag Chips
- Type any name and press `Enter`, `comma (,)`, or `Space` to create an animated avatar chip.
- **Auto-Sanitizes & Title-Cases** input names (`anuj` or `  anuj  ` $\rightarrow$ `Anuj`) to prevent duplicate casing bugs.
- Press `Backspace` when the input is empty to delete the last chip.
- Click any chip to configure an optional custom UPI ID (`name@upi`).

### ⚖️ Exact Integer Paise Math (0.00p Drift Guaranteed)
- In standard floating-point arithmetic, splits like ₹100 / 3 cause $0.01$ paisa to vanish due to IEEE 754 rounding.
- HisabMate converts all rupee amounts into integer **paise** (`Math.round(rupees * 100)`).
- Leftover remainder paise ($r = \text{totalPaise} \pmod k$) are deterministically distributed in 1-paise increments to the first $r$ members.
- Guarantees absolute mathematical conservation:
  $$\sum \text{Paid} \equiv \sum \text{Consumed} \quad \text{and} \quad \sum \text{Net} \equiv 0$$

### 💸 Greedy Minimum Cash-Flow Algorithm
- Calculates each member's net position: $\text{Net} = \text{Total Paid} - \text{Total Consumed}$.
- Separates creditors ($\text{Net} > 0$) and debtors ($\text{Net} < 0$).
- Iteratively pairs the largest debtor with the largest creditor to resolve the group in at most $N - 1$ total transactions.

### 💳 Strictly Outgoing "Pay To" Personal Cards
- Eliminates confusing "Receive from" rows.
- Each person has a dedicated settlement card:
  - **Debtors:** Prominently display their total balance (`Owes ₹...`) followed by itemized outgoing payments: `➔ Pay to <Recipient>: ₹<Amount>` with direct `[📲 Pay via UPI]` buttons.
  - **Creditors & Square Members:** Display `Owes ₹0.00` and an explicit `✓ No payment dues • All clear` notice.

### 📲 UPI Deep-Linking & Desktop QR Fallback
- **Mobile Devices:** Tapping `📲 Pay via UPI` launches standard NPCI intent URIs (`upi://pay?pa=...&am=...&tn=...`) directly opening Google Pay, PhonePe, Paytm, or BHIM.
- **Desktop Users:** Automatically generates a scannable payment QR code via `QRCode.js`, prompts to set recipient UPI handles on the fly, and allows 1-click URI copying.

### 🔗 Native Serverless Outing State Sharing
- Tap **Share** to serialize the active outing into a compressed, UTF-8 base64 URL hash (`#data=...`).
- Generates a scannable group QR code or shareable WhatsApp link.
- When friends scan the QR code or open the link on their phones, HisabMate automatically decodes the ledger into their browser's `localStorage` and computes settlements instantly—with **zero cloud servers or backend databases**.

### 📱 100% Offline Progressive Web App (PWA)
- Full W3C `manifest.json` configured for a native standalone app experience.
- Companion Service Worker (`sw.js`) caches all assets, styles, fonts, and scripts for 100% offline calculations anywhere (e.g. mountain trips, flights, remote restaurants).

---

## The Mathematical Engine

### Remainder Allocation Invariant
Given an expense of $P$ paise split evenly among $k$ squad members:

$$\text{baseShare} = \left\lfloor \frac{P}{k} \right\rfloor, \quad r = P \pmod k$$

Each member $i \in \{1, 2, \dots, k\}$ is allocated share $S_i$:

$$S_i = \begin{cases} 
\text{baseShare} + 1 & \text{if } i \le r \\ 
\text{baseShare} & \text{if } i > r 
\end{cases}$$

$$\sum_{i=1}^k S_i = r \cdot (\text{baseShare} + 1) + (k - r) \cdot \text{baseShare} = k \cdot \text{baseShare} + r \equiv P$$

Every single paisa is accounted for, eliminating dispute and rounding errors.

---

## File Structure

```text
HisabMate/
├── index.html         # Complete single-page application (UI, NLP parser, math engine)
├── manifest.json      # W3C Web App Manifest (PWA standalone configuration)
├── sw.js              # Cache-first service worker for full offline support
├── icon.svg           # High-resolution vector brand icon (currency glyph)
├── icon-192.png       # 192x192 raster icon for Android / PWA installs
├── icon-512.png       # 512x512 raster icon for splash screens
├── .gitignore         # Clean repository ignore file
├── LICENSE            # MIT open-source license
└── README.md          # Comprehensive documentation
```

---

## Quick Start & Deployment

HisabMate has **zero build steps** and **zero server dependencies**. You can deploy it in seconds on any static hosting platform.

### Option 1: Netlify (Recommended)

#### A. Instant 10-Second Drag & Drop (No Terminal Needed)
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag and drop the `HisabMate` folder directly into your browser.
3. Your app is live instantly with an SSL-secured URL (e.g. `hisabmate.netlify.app`).

#### B. Via Netlify CLI
```bash
npx netlify-cli deploy --prod --dir=.
```

---

### Option 2: Vercel

```bash
npx vercel deploy --prod
```

---

### Option 3: GitHub Pages

```bash
git init
git add .
git commit -m "feat: complete HisabMate PWA"
git branch -M main
git remote add origin https://github.com/<your-username>/hisabmate.git
git push -u origin main
```
1. Go to your GitHub repository **Settings** > **Pages**.
2. Under **Source**, select `Deploy from a branch` > branch: `main` > folder: `/ (root)`.
3. Click **Save**.

---

## Local Development & Testing

Since HisabMate is completely static, you can run it with any local server:

```bash
# Using Node's npx serve
npx serve .

# Or using Python 3
python -m http.server 8000

# Or simply open index.html directly in any browser
```

---

## Privacy & Local Storage Invariants

HisabMate stores all information locally in browser `localStorage`:
- `HISABMATE_ACTIVE_OUTING_V1`: Currently open outing session.
- `HISABMATE_OUTINGS_HISTORY_V1`: Past outings saved in the history drawer.

No user data, narrative text, or financial figures are ever sent across a network.

---

## License

Released under the [MIT License](LICENSE). Built with clean HTML5, Tailwind CSS, JetBrains Mono, Plus Jakarta Sans, and QRCode.js.

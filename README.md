# HisabMate

> *“HisabMate hai, toh sab sorted hai.”*

🌐 **Live Application:** [https://codecrusaders-png.github.io/HisabMate/](https://codecrusaders-png.github.io/HisabMate/)  

---

## 1. Product Overview & Problem Statement

Splitting bills after a trip, party, or flat dinner in India is notoriously tedious:
1. **Ambiguous narrative notes:** People jot down notes like *"Anuj paid 1200 for lunch, Priyasi had veg for 250 paid by Anuj, Arka paid for cab except Ritesh"*. Translating this manually into traditional bill-splitting forms takes minutes of repetitive tapping.
2. **Floating-point drift:** Standard web apps divide floating-point rupees (e.g. `₹100 / 3 = 33.333333...`), causing fractional paise to vanish into thin air or create mathematical imbalances.
3. **Overcomplicated debt webs:** Without mathematical optimization, 4 people end up making 6 different circular micro-transfers to one another.
4. **Privacy & signup fatigue:** Users do not want to download heavy native apps or create accounts just to settle a one-off weekend trip.

**HisabMate** solves this with a **zero-dependency, client-side progressive web application (PWA)** that accepts casual narrative text or voice dictation, normalizes names and quantities, computes exact integer-paise shares with guaranteed zero drift, optimizes settlement transfers using **Subset-Partition Dynamic Programming**, and facilitates immediate settlement via **1-click NPCI UPI deep links** and desktop QR codes.

---

## 2. Target Users

- **College Students & Friends:** Splitting dinner bills, hostel chai runs, Swiggy orders, and weekend getaways.
- **Flatmates & Roommates:** Tracking monthly WiFi, groceries, maid payments, and electricity without cloud databases.
- **Travel Groups:** Managing road trips, tolls, resort bookings, and cab fares with multi-payer tracking and exclusions.

---

## 3. Four-Step Primary Workflow

```
[ Step 1: The Squad ] ──> [ Step 2: Expense Story ] ──> [ Step 3: Review & Edit ] ──> [ Step 4: Settle Up ]
  • Add participants        • Casual text / voice        • Inspect payer & shares    • Provably min transfers
  • Auto-sanitized title    • Disambiguates quantities   • Correct warnings          • 1-click UPI / Desktop QR
  • Configure UPI handles   • Add manual expenses        • Zero-drift validation     • Self-reported tracking
```

1. **Step 1: The Squad** — Enter participant names (auto-capitalized, duplicate-checked). Optionally configure custom UPI handles for 1-click repayments.
2. **Step 2: Tell Us The Story** — Casually type or dictate expenses (e.g. *"Plaban paid 1200 for lunch for all of us except Priyasi. Priyasi ate veg for 250 paid by Anuj."*) or tap `+ Add Expense Manually` to open the accessible modal.
3. **Step 3: Review Interpreted Expenses** — Inspect interpreted payers, rupee and paise amounts, and beneficiary subsets before committing to the ledger. Warnings flag unresolved items so data is never guessed.
4. **Step 4: Optimal Settlement Plan** — View person-by-person outgoing dues (`➔ Pay to <Recipient>: ₹<Amount>`). Pure creditors and square members show clean `✓ All Clear` badges. Track payments with `✓ Mark Paid` and progress bars.

---

## 4. Key Features

- **Client-Side NLP Narrative Parser:** Disambiguates item quantities (e.g. `2 water bottles`) from currency tokens (`for 40 rs`), handles explicit exclusions (`except Priyasi`, `without Ritesh`), reflexive pronouns (`for himself and Plaban`), proportional shares (`David consumed half while Rahul and Aisha shared the remainder`), and specific portions (`including a specific ₹250 meal for Aisha, with the remaining ₹600 shared...`).
- **Strict Participant Isolation & Phantom Protection:** Participant creation is completely decoupled from narrative parsing. Ordinary nouns, locations, transitional words, and merchants (`Airbnb`, `Finally`, `Dinner`, `Cab`, `Uber`, `Swiggy`) can never accidentally become squad members or payers.
- **Mandatory Interpretation Review:** Step 3 displays an audit review of every interpreted expense, showing payer, amount, merchant/description, included/excluded members, split method, and individual allocation breakdowns with full editing capabilities before ledger commit.
- **Exact Integer-Paise Arithmetic:** Converts all rupee amounts to integer paise (`Math.round(rupees * 100)`). Eliminates binary floating-point errors.
- **Deterministic Remainder Allocation:** When splitting $P$ paise among $k$ participants, the remainder $r = P \pmod k$ is allocated deterministically (+1 paisa to the first $r$ members in list order). Total distributed paise identically equals total expenditure.
- **Dual Settlement Solvers:**
  - **Exact Subset-Partition DP ($N \le 14$):** Partitions participants into the maximum number of disjoint zero-sum subsets $k$, proving a global minimum of $N - k$ transfers.
  - **Greedy Cash-Flow Heuristic ($N > 14$):** Guaranteed upper bound of at most $N - 1$ transfers for large squads.
- **Self-Reported Settlement Tracking:** Debts can be marked as paid with an automatic timestamp (`✓ Self-reported paid at 11:32 AM`), an instant `Undo` option, and an animated settlement progress bar (% settled).
- **UPI Deep-Linking & Desktop QR:** Generates standard NPCI intent URIs (`upi://pay?pa=...&am=...&tn=...`) for mobile devices and dynamically renders scannable QR codes for desktop browsers using `qrcodejs`.
- **Zero-Cloud Local Storage:** Persisted locally in `localStorage` under versioned schemas with backward compatibility.
- **Formula-Injection Safe CSV Export:** Exports sanitized spreadsheets with formula guard prefixes (`'`, `'=`, `'+`, `'-`, `'@`).
- **Serverless URL Sync:** Encodes outings into compact base64 hash fragments (`#data=...`) or group QR codes to share trips without a server runtime.
- **Offline PWA:** Registered service worker (`sw.js`) caches all assets, fonts, and scripts for 100% offline calculations.

---

## 5. Mathematical Architecture & Guarantees

### 5.1 Conservation Invariants
For any valid ledger with $M$ expenses and $N$ squad members:
1. **Total Conservation:**
   $$\sum_{i=1}^N \text{Paid}_i \equiv \sum_{i=1}^N \text{Consumed}_i \equiv \text{TotalSpend}$$
2. **Zero-Drift Equilibrium:**
   $$\sum_{i=1}^N \text{Net}_i \equiv 0 \quad \text{where } \text{Net}_i = \text{Paid}_i - \text{Consumed}_i$$
3. **Transfer Positivity & Clearing:**
   $$\forall T \in \text{Transactions}, \quad \text{Amount}_T > 0 \quad \text{and} \quad \text{From}_T \neq \text{To}_T$$
   Applying all generated transfers clears every individual's balance to exactly $0\text{ paise}$.

### 5.2 Settlement Optimization: Exact Subset DP vs. Greedy
Debt simplification is equivalent to the **Subset Sum / Partition Problem** (NP-complete).
- If a subset $S \subseteq \text{Squad}$ satisfies $\sum_{i \in S} \text{Net}_i = 0$, that subset can be completely settled internally in $|S| - 1$ transfers without external payments.
- If the non-zero participants are partitioned into the maximum number of disjoint zero-sum subsets $k$, the **globally minimal number of transfers is proven to be $N - k$**.
- **Counterexample showing Greedy is suboptimal:**
  - Given balances: $A: +30, B: +20, C: +10, D: -40, E: -20$.
  - Greedy cash-flow matches largest balances: requires **4 transfers**.
  - Exact subset partition finds $\{B: +20, E: -20\}$ and $\{A: +30, C: +10, D: -40\}$, requiring **3 transfers** ($5 - 2 = 3$).
- **HisabMate's Strategy:**
  - For $N \le 14$: Executes exact subset-partition bitmask DP (`O(2^N)` states) to guarantee the **provable global minimum**.
  - For $N > 14$: Seamlessly executes greedy cash-flow with a guaranteed upper bound of $\le N - 1$ transfers.

---

## 6. Project Structure

```
HisabMate/
├── index.html          # Production single-page application (UI, Stepper, Tailwind, Modals)
├── engine.js           # Isomorphic core engine (Money, Parser, Ledger, Solvers, Storage)
├── sw.js               # Service Worker for cache-first offline PWA execution
├── manifest.json       # Web App Manifest for standalone mobile installation
├── package.json        # Test runner scripts (zero runtime dependencies)
├── tests/
│   ├── critical_parsing_settlement.test.js # Critical regression suite (Scenarios A-I: Phantom participants, allocations, isolation)
│   ├── digha_regression.test.js # Prompt master test (Scenarios A-L: Digha balances & transfers)
│   ├── engine.test.js          # Unit tests (Math, Invariants, Parser, Solvers, Property-based)
│   └── integration.test.js     # End-to-end integration flows and edge cases
│   └── integration.test.js     # End-to-end user workflow & edge-case integration tests
├── icon.svg            # Scalable vector application logo
├── icon-192.png        # 192x192 PWA maskable icon
├── icon-512.png        # 512x512 PWA splash icon
├── robots.txt          # Search engine crawler permissions
├── sitemap.xml         # XML sitemap for search discovery
└── .nojekyll           # Bypasses Jekyll build on GitHub Pages
```

---

## 7. Technology Stack

- **Runtime & UI:** Vanilla HTML5, JavaScript (ES2022), Tailwind CSS CDN.
- **Typography:** Plus Jakarta Sans & JetBrains Mono (Google Fonts).
- **QR Generation:** QRCode.js (1.0.0 CDN).
- **Core Engine:** Isomorphic UMD module (`engine.js`) compatible with both browser `window.HisabMateEngine` and Node.js `require('./engine.js')`.
- **Testing:** Node.js native test runner (`node --test`, `node:assert/strict`). Zero external testing dependencies.
- **Hosting:** GitHub Pages static delivery (`https://codecrusaders-png.github.io/HisabMate/`).

---

## 8. Local Setup & Testing

### Prerequisites
- Any modern web browser (Chrome, Edge, Firefox, Safari).
- Node.js v18+ (only needed to run the automated test suite).

### Run Locally
Simply open `index.html` in your browser, or spin up a local static server:
```bash
# Using Python
python -m http.server 8000

# Using Node.js
npx serve .
```
Navigate to `http://localhost:8000/`.

### Run Automated Tests
HisabMate features a comprehensive automated test suite covering paise math, deterministic remainder distribution, financial invariants, subset-partition DP, greedy cash-flow, NLP disambiguation, settlement tracking, schema migrations, CSV formula-injection defense, and randomized property-based ledgers:

```bash
npm test
```

Expected output:
```
✔ Scenario A: Digha regression test produces exact expected ledger & 4 transfers
✔ Scenario B: ₹100 split among 3 members allocates exactly 10,000 paise
✔ Scenario C: Member excluded from ₹600 expense receives 0 consumption
✔ Scenario D: ₹350 dessert shared between two named members allocates ₹175 each
✔ Scenario E: Multiple payers receive exact net credits
✔ Scenario F: Single-participant expense produces 0 self-transfers
✔ Scenario G: Rejects invalid, empty, or negative inputs safely
✔ Scenario H: One-paisa amounts and repeated allocations conserve 100% money
✔ Scenario I: Editing or deleting an expense updates all derived balances
✔ Scenario J: Outing survives JSON serialization and restoration without alteration
✔ Scenario K: 25 randomized ledgers satisfy all 10 financial invariants
✔ Scenario L: Exact same canonical ledger is used by balance calculations, summary text, and CSV export
✔ Money.toPaise converts rupees accurately to integer paise
✔ Money.formatINR formats standard Indian currency with commas
✔ Ledger.calculateEqualShares distributes remainder paise deterministically without drift
✔ Ledger.calculateEqualShares allocates exact 1 paise remainders across 4 people
✔ Ledger.computeBalances enforces Sum(Paid) === Sum(Consumed) and Sum(Net) === 0
✔ SettlementSolver.solve finds provably optimal 3 transactions where Greedy gives 4
✔ SettlementSolver.solve generates exact settlements for Prompt Master Story
✔ Parser.parseStory parses realistic multi-payer narrative with exclusions
✔ Parser.parseClause disambiguates item quantity counts from currency amounts
✔ Parser.parseClause flags ambiguous sentences with warnings instead of inventing data
✔ SettlementTracker correctly computes progress and records payment timestamps
✔ Storage.migrate upgrades V1 schema to V2 seamlessly
✔ Storage.exportCSV neutralizes formula injection attempts
✔ Property-based testing: 50 random ledgers preserve zero-drift and perfect settlement
✔ E2E Flow: Group -> Story -> Review & Correct -> Calculate -> Settlement Tracking
✔ Edge Case: Zero expenses results in 0 balance and 0 transactions
✔ Edge Case: All participants have net balance 0 (fully square)
✔ Edge Case: Single participant handles own expense
✔ Edge Case: Corrupt or invalid JSON import is safely rejected
ℹ tests 31 | pass 31 | fail 0
```

---

## 9. Privacy, Security & Disclaimers

1. **Client-Side Privacy:** No expense data, participant names, or notes are ever uploaded to a server. Everything remains in browser local storage (`localStorage`).
2. **Self-Reported Payment Status:** Marking a debt as paid is a self-reported user action, not bank-verified transaction confirmation.
3. **No Banking Credentials:** HisabMate never requests, stores, or handles bank passwords, UPI PINs, OTPs, or debit card numbers. UPI links trigger the operating system's native NPCI intent handler.
4. **CSV Formula Injection Defense:** All exported cells are sanitized to neutralize formula triggers (`=`, `+`, `-`, `@`) when opened in Microsoft Excel or Google Sheets.

---

## 10. Known Limitations & Roadmap

- **Known Limitations:**
  - **Participant Registration:** Only explicitly registered squad members can be assigned as payers or beneficiaries. Unregistered names or ambiguous nouns are flagged as unresolved for user assignment in Step 3.
  - **Complex Non-Standard Splits:** Natural language parsing supports equal splits, exclusions (`except X`), proportional consumption (`half / quarter / X%`), and itemized portions (`specific ₹X meal for Y, with remaining shared...`). Highly complex multi-tier equations should be confirmed or customized in the Step 3 review modal.
  - **Local Storage Scope:** Browser storage is device-specific. To share an outing with friends on another device, use the 1-click **Share Karo** button to copy the encoded URL payload.
- **Future Roadmap:**
  - Client-side OCR receipt scanner via WebAssembly.
  - Optional peer-to-peer WebRTC state sync between nearby phones.
  - Multi-currency support for international trips.

---

## 11. License

MIT License. Designed and crafted with ❤️ by **Code Crusaders**.

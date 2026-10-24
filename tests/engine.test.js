const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

const { Money, Parser, Ledger, SettlementSolver, SettlementTracker, Storage } = Engine;

// =========================================================================
// 1. CURRENCY & INTEGER-PAISE MATH
// =========================================================================
test('Money.toPaise converts rupees accurately to integer paise', () => {
  assert.equal(Money.toPaise(0), 0);
  assert.equal(Money.toPaise(1), 100);
  assert.equal(Money.toPaise(19.99), 1999);
  assert.equal(Money.toPaise('1200.50'), 120050);
  assert.equal(Money.toPaise('1,25,000'), 12500000);
  assert.equal(Money.toPaise(null), 0);
  assert.equal(Money.toPaise(undefined), 0);
  assert.equal(Money.toPaise(NaN), 0);
});

test('Money.formatINR formats standard Indian currency with commas', () => {
  assert.equal(Money.formatINR(0), '₹0.00');
  assert.equal(Money.formatINR(120000), '₹1,200.00');
  assert.equal(Money.formatINR(45050), '₹450.50');
  assert.equal(Money.formatINR(10000000), '₹1,00,000.00');
});

// =========================================================================
// 2. EQUAL SPLIT & DETERMINISTIC REMAINDER DISTRIBUTION
// =========================================================================
test('Ledger.calculateEqualShares distributes remainder paise deterministically without drift', () => {
  // ₹100 (10,000 paise) split among 3 people: 3334, 3333, 3333
  const participants = ['Anuj', 'Arka', 'Ritesh'];
  const shares = Ledger.calculateEqualShares(10000, participants);

  assert.equal(shares['Anuj'].sharePaise, 3334);
  assert.equal(shares['Anuj'].hasRemainderPaisa, true);
  assert.equal(shares['Arka'].sharePaise, 3333);
  assert.equal(shares['Arka'].hasRemainderPaisa, false);
  assert.equal(shares['Ritesh'].sharePaise, 3333);
  assert.equal(shares['Ritesh'].hasRemainderPaisa, false);

  const total = shares['Anuj'].sharePaise + shares['Arka'].sharePaise + shares['Ritesh'].sharePaise;
  assert.equal(total, 10000);
});

test('Ledger.calculateEqualShares allocates exact 1 paise remainders across 4 people', () => {
  // 101 paise split among 4 people: 26, 25, 25, 25
  const participants = ['A', 'B', 'C', 'D'];
  const shares = Ledger.calculateEqualShares(101, participants);

  assert.equal(shares['A'].sharePaise, 26);
  assert.equal(shares['B'].sharePaise, 25);
  assert.equal(shares['C'].sharePaise, 25);
  assert.equal(shares['D'].sharePaise, 25);

  const sum = Object.values(shares).reduce((acc, s) => acc + s.sharePaise, 0);
  assert.equal(sum, 101);
});

// =========================================================================
// 3. FINANCIAL INVARIANTS IN LEDGER
// =========================================================================
test('Ledger.computeBalances enforces Sum(Paid) === Sum(Consumed) and Sum(Net) === 0', () => {
  const squad = [{ name: 'Anuj' }, { name: 'Arka' }, { name: 'Ritesh' }];
  const expenses = [
    {
      id: 'e1',
      payer: 'Anuj',
      amountPaise: 120000,
      included: ['Anuj', 'Arka', 'Ritesh']
    },
    {
      id: 'e2',
      payer: 'Arka',
      amountPaise: 45000,
      included: ['Anuj', 'Arka']
    },
    {
      id: 'e3',
      payer: 'Ritesh',
      amountPaise: 30000,
      included: ['Anuj', 'Arka', 'Ritesh']
    }
  ];

  const result = Ledger.computeBalances(squad, expenses);

  assert.equal(result.totalSpendPaise, 195000); // 1200 + 450 + 300 = 1950.00
  assert.equal(result.sumPaid, 195000);
  assert.equal(result.sumConsumed, 195000);
  assert.equal(result.driftPaise, 0);

  // Anuj: Paid 120000, Consumed = 40000 (dinner) + 22500 (cab) + 10000 (snacks) = 72500. Net = +47500
  assert.equal(result.memberTotals['Anuj'].netPaise, 47500);

  // Arka: Paid 45000, Consumed = 40000 (dinner) + 22500 (cab) + 10000 (snacks) = 72500. Net = -27500
  assert.equal(result.memberTotals['Arka'].netPaise, -27500);

  // Ritesh: Paid 30000, Consumed = 40000 (dinner) + 0 (cab) + 10000 (snacks) = 50000. Net = -20000
  assert.equal(result.memberTotals['Ritesh'].netPaise, -20000);

  // Invariant verification: +47500 - 27500 - 20000 = 0
  const netSum = Object.values(result.memberTotals).reduce((sum, m) => sum + m.netPaise, 0);
  assert.equal(netSum, 0);
});

// =========================================================================
// 4. SETTLEMENT SOLVER (EXACT SUBSET DP vs GREEDY)
// =========================================================================
test('SettlementSolver.solve finds provably optimal 3 transactions where Greedy gives 4', () => {
  // Classic counterexample:
  // A: +30, B: +20, C: +10, D: -40, E: -20
  // Greedy sorts creditors [30, 20, 10] and debtors [40, 20] and requires 4 transactions.
  // Exact Subset Partition finds {B: 20, E: -20} and {A: 30, C: 10, D: -40}, requiring 1 + 2 = 3 transactions!
  const memberTotals = {
    A: { name: 'A', upi: 'a@upi', netPaise: 3000 },
    B: { name: 'B', upi: 'b@upi', netPaise: 2000 },
    C: { name: 'C', upi: 'c@upi', netPaise: 1000 },
    D: { name: 'D', upi: 'd@upi', netPaise: -4000 },
    E: { name: 'E', upi: 'e@upi', netPaise: -2000 }
  };

  const plan = SettlementSolver.solve(memberTotals);

  assert.equal(plan.algorithm, 'exact_subset_partition');
  assert.equal(plan.optimal, true);
  assert.equal(plan.transactions.length, 3); // PROVEN GLOBAL MINIMUM

  // Verify all transactions resolve debts exactly
  assert.doesNotThrow(() => {
    SettlementSolver.validateSettlementPlan(memberTotals, plan.transactions);
  });
});

test('SettlementSolver.solve generates exact settlements for Prompt Master Story', () => {
  const memberTotals = {
    Anuj: { name: 'Anuj', upi: 'anuj@upi', netPaise: 47500 },
    Arka: { name: 'Arka', upi: 'arka@upi', netPaise: -27500 },
    Ritesh: { name: 'Ritesh', upi: 'ritesh@upi', netPaise: -20000 }
  };

  const plan = SettlementSolver.solve(memberTotals);
  assert.equal(plan.optimal, true);
  assert.equal(plan.transactions.length, 2);

  // Arka pays Anuj ₹275.00
  // Ritesh pays Anuj ₹200.00
  const arkaTx = plan.transactions.find(t => t.from === 'Arka');
  assert.equal(arkaTx.to, 'Anuj');
  assert.equal(arkaTx.amountPaise, 27500);

  const riteshTx = plan.transactions.find(t => t.from === 'Ritesh');
  assert.equal(riteshTx.to, 'Anuj');
  assert.equal(riteshTx.amountPaise, 20000);
});

// =========================================================================
// 5. NATURAL LANGUAGE STORY PARSER
// =========================================================================
test('Parser.parseStory parses realistic multi-payer narrative with exclusions', () => {
  const story = 'Anuj paid ₹1,200 for dinner shared equally by Anuj, Arka, and Ritesh. Arka paid ₹450 for a cab shared by everyone except Ritesh. Ritesh paid ₹300 for snacks for all three.';
  const squad = ['Anuj', 'Arka', 'Ritesh'];

  const expenses = Parser.parseStory(story, squad);

  assert.equal(expenses.length, 3);

  // Item 1
  assert.equal(expenses[0].payer, 'Anuj');
  assert.equal(expenses[0].amountPaise, 120000);
  assert.deepEqual(expenses[0].included.sort(), ['Anuj', 'Arka', 'Ritesh'].sort());

  // Item 2
  assert.equal(expenses[1].payer, 'Arka');
  assert.equal(expenses[1].amountPaise, 45000);
  assert.deepEqual(expenses[1].included.sort(), ['Anuj', 'Arka'].sort());
  assert.deepEqual(expenses[1].excluded, ['Ritesh']);

  // Item 3
  assert.equal(expenses[2].payer, 'Ritesh');
  assert.equal(expenses[2].amountPaise, 30000);
  assert.deepEqual(expenses[2].included.sort(), ['Anuj', 'Arka', 'Ritesh'].sort());
});

test('Parser.parseClause disambiguates item quantity counts from currency amounts', () => {
  const squad = ['Anuj', 'Ritesh'];

  // "2 water bottles" vs "40 rs"
  const clause1 = 'Ritesh paid for 2 water bottles for 40 rs';
  const parsed1 = Parser.parseClause(clause1, squad);
  assert.equal(parsed1.payer, 'Ritesh');
  assert.equal(parsed1.amountPaise, 4000); // Must be 40, NOT 2

  // "4 plates of biryani" vs "500"
  const clause2 = 'Anuj spent 500 for 4 plates of biryani';
  const parsed2 = Parser.parseClause(clause2, squad);
  assert.equal(parsed2.payer, 'Anuj');
  assert.equal(parsed2.amountPaise, 50000); // Must be 500, NOT 4
});

test('Parser.parseClause flags ambiguous sentences with warnings instead of inventing data', () => {
  const squad = ['Anuj', 'Arka'];
  const clause = 'Spent some cash on petrol';
  const parsed = Parser.parseClause(clause, squad);

  assert.equal(parsed.payer, 'Unresolved');
  assert.equal(parsed.amountPaise, 0);
  assert.equal(parsed.confidence, 'low');
  assert.ok(parsed.warnings.length > 0);
});

// =========================================================================
// 6. SETTLEMENT TRACKER (SELF-REPORTED LOG & PROGRESS)
// =========================================================================
test('SettlementTracker correctly computes progress and records payment timestamps', () => {
  const transactions = [
    { id: 'tx_1', from: 'Arka', to: 'Anuj', amountPaise: 27500 },
    { id: 'tx_2', from: 'Ritesh', to: 'Anuj', amountPaise: 20000 }
  ];

  // Initial state: 0% settled
  let progress = SettlementTracker.getProgress(transactions, {});
  assert.equal(progress.percentSettled, 0);
  assert.equal(progress.isFullySettled, false);
  assert.equal(progress.remainingDebtPaise, 47500);

  // Arka marks transaction paid
  const records = {};
  records['tx_1'] = SettlementTracker.createRecord('tx_1', 'Paid via Google Pay');
  assert.equal(records['tx_1'].status, 'marked_paid');
  assert.ok(records['tx_1'].timestamp);
  assert.equal(records['tx_1'].selfReported, true);

  progress = SettlementTracker.getProgress(transactions, records);
  assert.equal(progress.settledCount, 1);
  assert.equal(progress.settledDebtPaise, 27500);
  assert.equal(progress.remainingDebtPaise, 20000);
  assert.equal(progress.percentSettled, 58); // 27500 / 47500 = 57.89% -> 58%

  // Ritesh marks transaction paid
  records['tx_2'] = SettlementTracker.createRecord('tx_2', 'Paid via PhonePe');
  progress = SettlementTracker.getProgress(transactions, records);
  assert.equal(progress.percentSettled, 100);
  assert.equal(progress.isFullySettled, true);
  assert.equal(progress.remainingDebtPaise, 0);
});

// =========================================================================
// 7. SCHEMA MIGRATION & EXPORT SAFETY
// =========================================================================
test('Storage.migrate upgrades V1 schema to V2 seamlessly', () => {
  const v1 = {
    title: 'Manali Trip',
    squad: ['Anuj', 'Arka'],
    expenses: [
      { raw: 'Anuj paid 500 for dinner', amountRupees: 500, payer: 'Anuj', included: ['Anuj', 'Arka'] }
    ]
  };

  const v2 = Storage.migrate(v1);
  assert.equal(v2.version, 2);
  assert.equal(v2.title, 'Manali Trip');
  assert.equal(v2.squad[0].name, 'Anuj');
  assert.equal(v2.expenses[0].amountPaise, 50000);
});

test('Storage.exportCSV neutralizes formula injection attempts', () => {
  const outing = {
    title: '=cmd|’ /C calc’!A0',
    date: '2026-10-24',
    squad: [{ name: 'Anuj' }],
    expenses: [
      { payer: '+@admin', description: '-10% discount', amountPaise: 5000, included: ['Anuj'] }
    ]
  };

  const csv = Storage.exportCSV(outing, { transactions: [] });
  // Ensure sensitive formula characters are quoted with leading apostrophe
  assert.ok(csv.includes("\"'=cmd"));
  assert.ok(csv.includes("\"'+@admin"));
  assert.ok(csv.includes("\"'-10% discount"));
});

// =========================================================================
// 8. PROPERTY-BASED / RANDOMIZED LEDGER INVARIANT TESTING
// =========================================================================
test('Property-based testing: 50 random ledgers preserve zero-drift and perfect settlement', () => {
  const memberPool = ['Aarav', 'Bhavna', 'Chetan', 'Diya', 'Eshan', 'Farhan', 'Gauri', 'Hardik'];

  for (let seed = 0; seed < 50; seed++) {
    // Random squad size between 3 and 6
    const squadSize = 3 + (seed % 4);
    const squadNames = memberPool.slice(0, squadSize);
    const squad = squadNames.map(name => ({ name, upi: `${name.toLowerCase()}@upi` }));

    // Generate between 2 and 8 random expenses
    const numExpenses = 2 + ((seed * 7) % 7);
    const expenses = [];

    for (let e = 0; e < numExpenses; e++) {
      const payer = squadNames[(seed + e) % squadSize];
      // Random amount in paise between ₹1.00 (100p) and ₹5,000.00 (500,000p)
      const amountPaise = 100 + ((seed * 997 + e * 313) % 499900);
      
      // Random subset of participants
      const included = squadNames.filter((_, idx) => (idx + e + seed) % 2 === 0);
      if (included.length === 0) included.push(payer);

      expenses.push({
        id: `exp_rand_${seed}_${e}`,
        payer,
        amountPaise,
        included,
        description: `Random Item #${e + 1}`
      });
    }

    // 1. Compute Balances
    const result = Ledger.computeBalances(squad, expenses);
    
    // Invariant A: Total Paid === Total Consumed
    assert.equal(result.sumPaid, result.sumConsumed);
    // Invariant B: Net Balances sum to 0
    const netSum = Object.values(result.memberTotals).reduce((acc, m) => acc + m.netPaise, 0);
    assert.equal(netSum, 0, `Net balance did not sum to 0 on seed ${seed}`);

    // 2. Solve Settlement
    const plan = SettlementSolver.solve(result.memberTotals);

    // Invariant C: All transfer amounts > 0
    plan.transactions.forEach(t => {
      assert.ok(t.amountPaise > 0, `Non-positive transfer generated on seed ${seed}`);
      assert.notEqual(t.from, t.to, `Self-transfer generated on seed ${seed}`);
    });

    // Invariant D: Applying all transfers clears debts to exactly zero
    assert.doesNotThrow(() => {
      SettlementSolver.validateSettlementPlan(result.memberTotals, plan.transactions);
    }, `Settlement failed validation on seed ${seed}`);
  }
});

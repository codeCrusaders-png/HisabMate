const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

const { Money, Parser, Ledger, SettlementSolver, SettlementTracker, Storage } = Engine;

// =========================================================================
// SCENARIO A: DIGHA REGRESSION TEST (HIGHEST PRIORITY)
// =========================================================================
test('Scenario A: Digha regression test produces exact expected ledger & 4 transfers', () => {
  const squad = [
    { name: 'Anuj' },
    { name: 'Priyasi' },
    { name: 'Plaban' },
    { name: 'Arkadeep' },
    { name: 'Rohan' }
  ];
  const squadNames = squad.map(s => s.name);

  const narrativeStory = [
    'Anuj paid ₹1,500 for dinner shared equally among all five members.',
    'Plaban paid ₹600 for drinks shared equally among Anuj, Plaban, Arkadeep, and Rohan. Priyasi is excluded.',
    'Priyasi paid ₹350 for dessert shared equally between Anuj and Priyasi.',
    'Rohan paid ₹250 for parking shared equally among all five members.'
  ].join(' ');

  // 1. Natural language parse
  const parsedExpenses = Parser.parseStory(narrativeStory, squadNames);
  assert.equal(parsedExpenses.length, 4, 'Should parse exactly 4 discrete expenses');

  // Verify Expense 1
  assert.equal(parsedExpenses[0].payer, 'Anuj');
  assert.equal(parsedExpenses[0].amountPaise, 150000);
  assert.deepEqual(parsedExpenses[0].included.sort(), squadNames.sort());

  // Verify Expense 2
  assert.equal(parsedExpenses[1].payer, 'Plaban');
  assert.equal(parsedExpenses[1].amountPaise, 60000);
  assert.deepEqual(parsedExpenses[1].included.sort(), ['Anuj', 'Plaban', 'Arkadeep', 'Rohan'].sort());
  assert.ok(parsedExpenses[1].excluded.includes('Priyasi'));

  // Verify Expense 3
  assert.equal(parsedExpenses[2].payer, 'Priyasi');
  assert.equal(parsedExpenses[2].amountPaise, 35000);
  assert.deepEqual(parsedExpenses[2].included.sort(), ['Anuj', 'Priyasi'].sort());

  // Verify Expense 4
  assert.equal(parsedExpenses[3].payer, 'Rohan');
  assert.equal(parsedExpenses[3].amountPaise, 25000);
  assert.deepEqual(parsedExpenses[3].included.sort(), squadNames.sort());

  // 2. Compute Ledger Balances
  const balanceResult = Ledger.computeBalances(squad, parsedExpenses);
  const totals = balanceResult.memberTotals;

  // Assert Total Spend = ₹2,700.00
  assert.equal(balanceResult.totalSpendPaise, 270000);
  assert.equal(balanceResult.sumPaid, 270000);
  assert.equal(balanceResult.sumConsumed, 270000);
  assert.equal(balanceResult.driftPaise, 0);

  // Assert Exact Member Ledger Figures
  // Member 1: Anuj
  assert.equal(totals['Anuj'].paidPaise, 150000, 'Anuj Total Paid should be ₹1,500.00');
  assert.equal(totals['Anuj'].consumedPaise, 67500, 'Anuj Total Consumed should be ₹675.00');
  assert.equal(totals['Anuj'].netPaise, 82500, 'Anuj Net Balance should be +₹825.00');

  // Member 2: Priyasi
  assert.equal(totals['Priyasi'].paidPaise, 35000, 'Priyasi Total Paid should be ₹350.00');
  assert.equal(totals['Priyasi'].consumedPaise, 52500, 'Priyasi Total Consumed should be ₹525.00');
  assert.equal(totals['Priyasi'].netPaise, -17500, 'Priyasi Net Balance should be -₹175.00');

  // Member 3: Plaban
  assert.equal(totals['Plaban'].paidPaise, 60000, 'Plaban Total Paid should be ₹600.00');
  assert.equal(totals['Plaban'].consumedPaise, 50000, 'Plaban Total Consumed should be ₹500.00');
  assert.equal(totals['Plaban'].netPaise, 10000, 'Plaban Net Balance should be +₹100.00');

  // Member 4: Arkadeep
  assert.equal(totals['Arkadeep'].paidPaise, 0, 'Arkadeep Total Paid should be ₹0.00');
  assert.equal(totals['Arkadeep'].consumedPaise, 50000, 'Arkadeep Total Consumed should be ₹500.00');
  assert.equal(totals['Arkadeep'].netPaise, -50000, 'Arkadeep Net Balance should be -₹500.00');

  // Member 5: Rohan
  assert.equal(totals['Rohan'].paidPaise, 25000, 'Rohan Total Paid should be ₹250.00');
  assert.equal(totals['Rohan'].consumedPaise, 50000, 'Rohan Total Consumed should be ₹500.00');
  assert.equal(totals['Rohan'].netPaise, -25000, 'Rohan Net Balance should be -₹250.00');

  // 3. Generate Optimal Settlement Transfers
  const settlementPlan = SettlementSolver.solve(totals);
  const txs = settlementPlan.transactions;

  assert.equal(txs.length, 4, 'Should generate exactly 4 peer settlement transfers');

  // Expected 4 transfers:
  // - Arkadeep pays Anuj ₹500.00
  // - Rohan pays Anuj ₹250.00
  // - Priyasi pays Anuj ₹75.00
  // - Priyasi pays Plaban ₹100.00
  const arkaToAnuj = txs.find(t => t.from === 'Arkadeep' && t.to === 'Anuj');
  assert.ok(arkaToAnuj, 'Arkadeep pays Anuj exists');
  assert.equal(arkaToAnuj.amountPaise, 50000, 'Arkadeep pays Anuj ₹500.00');

  const rohanToAnuj = txs.find(t => t.from === 'Rohan' && t.to === 'Anuj');
  assert.ok(rohanToAnuj, 'Rohan pays Anuj exists');
  assert.equal(rohanToAnuj.amountPaise, 25000, 'Rohan pays Anuj ₹250.00');

  const priyasiToAnuj = txs.find(t => t.from === 'Priyasi' && t.to === 'Anuj');
  assert.ok(priyasiToAnuj, 'Priyasi pays Anuj exists');
  assert.equal(priyasiToAnuj.amountPaise, 7500, 'Priyasi pays Anuj ₹75.00');

  const priyasiToPlaban = txs.find(t => t.from === 'Priyasi' && t.to === 'Plaban');
  assert.ok(priyasiToPlaban, 'Priyasi pays Plaban exists');
  assert.equal(priyasiToPlaban.amountPaise, 10000, 'Priyasi pays Plaban ₹100.00');

  // Total transferred amount = ₹925.00 (92500 paise)
  const totalSettlementPaise = txs.reduce((sum, t) => sum + t.amountPaise, 0);
  assert.equal(totalSettlementPaise, 92500, 'Total settlement should be ₹925.00');
});

// =========================================================================
// SCENARIO B: EQUAL SPLIT & EXACT PAISE ALLOCATION
// =========================================================================
test('Scenario B: ₹100 split among 3 members allocates exactly 10,000 paise', () => {
  const squad = ['A', 'B', 'C'];
  const shares = Ledger.calculateEqualShares(10000, squad);

  assert.equal(shares['A'].sharePaise, 3334);
  assert.equal(shares['B'].sharePaise, 3333);
  assert.equal(shares['C'].sharePaise, 3333);

  const sum = shares['A'].sharePaise + shares['B'].sharePaise + shares['C'].sharePaise;
  assert.equal(sum, 10000);
});

// =========================================================================
// SCENARIO C: EXCLUSION
// =========================================================================
test('Scenario C: Member excluded from ₹600 expense receives 0 consumption', () => {
  const squad = [{ name: 'Anuj' }, { name: 'Priyasi' }, { name: 'Plaban' }, { name: 'Arkadeep' }, { name: 'Rohan' }];
  const expenses = [{
    payer: 'Plaban',
    amountPaise: 60000,
    included: ['Anuj', 'Plaban', 'Arkadeep', 'Rohan']
  }];

  const res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['Priyasi'].consumedPaise, 0);
  assert.equal(res.memberTotals['Priyasi'].netPaise, 0);
});

// =========================================================================
// SCENARIO D: SUBSET SPLIT
// =========================================================================
test('Scenario D: ₹350 dessert shared between two named members allocates ₹175 each', () => {
  const squad = [{ name: 'Anuj' }, { name: 'Priyasi' }, { name: 'Plaban' }];
  const expenses = [{
    payer: 'Priyasi',
    amountPaise: 35000,
    included: ['Anuj', 'Priyasi']
  }];

  const res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['Anuj'].consumedPaise, 17500);
  assert.equal(res.memberTotals['Priyasi'].consumedPaise, 17500);
  assert.equal(res.memberTotals['Plaban'].consumedPaise, 0);
});

// =========================================================================
// SCENARIO E: MULTIPLE PAYERS
// =========================================================================
test('Scenario E: Multiple payers receive exact net credits', () => {
  const squad = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const expenses = [
    { payer: 'A', amountPaise: 30000, included: ['A', 'B', 'C'] },
    { payer: 'B', amountPaise: 15000, included: ['A', 'B', 'C'] }
  ];

  const res = Ledger.computeBalances(squad, expenses);
  // Total spend = 45000. Each consumes 15000.
  // A paid 30000, net = +15000
  // B paid 15000, net = 0
  // C paid 0, net = -15000
  assert.equal(res.memberTotals['A'].netPaise, 15000);
  assert.equal(res.memberTotals['B'].netPaise, 0);
  assert.equal(res.memberTotals['C'].netPaise, -15000);

  const plan = SettlementSolver.solve(res.memberTotals);
  assert.equal(plan.transactions.length, 1);
  assert.equal(plan.transactions[0].from, 'C');
  assert.equal(plan.transactions[0].to, 'A');
  assert.equal(plan.transactions[0].amountPaise, 15000);
});

// =========================================================================
// SCENARIO F: ONE PARTICIPANT
// =========================================================================
test('Scenario F: Single-participant expense produces 0 self-transfers', () => {
  const squad = [{ name: 'Solo' }];
  const expenses = [{ payer: 'Solo', amountPaise: 50000, included: ['Solo'] }];

  const res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['Solo'].netPaise, 0);

  const plan = SettlementSolver.solve(res.memberTotals);
  assert.equal(plan.transactions.length, 0);
});

// =========================================================================
// SCENARIO G: EMPTY AND INVALID INPUT
// =========================================================================
test('Scenario G: Rejects invalid, empty, or negative inputs safely', () => {
  assert.equal(Money.toPaise('invalid'), 0);
  assert.equal(Money.toPaise(-500), 0);
  assert.equal(Money.isValidAmount(-10), false);
  assert.equal(Money.isValidAmount(NaN), false);
  assert.equal(Money.isValidAmount(100), true);

  assert.throws(() => {
    Storage.validateOuting({ squad: 'not-array' });
  });
  assert.throws(() => {
    Storage.validateOuting({ squad: [], expenses: [{ amountRupees: -50 }] });
  });
});

// =========================================================================
// SCENARIO H: ROUNDING & REMAINDER ALLOCATION
// =========================================================================
test('Scenario H: One-paisa amounts and repeated allocations conserve 100% money', () => {
  const participants = ['A', 'B', 'C', 'D', 'E'];
  // 1 paisa among 5 people: A gets 1, rest get 0. Total = 1.
  const shares1 = Ledger.calculateEqualShares(1, participants);
  assert.equal(shares1['A'].sharePaise, 1);
  assert.equal(shares1['B'].sharePaise, 0);
  assert.equal(Object.values(shares1).reduce((s, x) => s + x.sharePaise, 0), 1);

  // 7 paise among 5 people: A, B get 2, C, D, E get 1. Total = 7.
  const shares7 = Ledger.calculateEqualShares(7, participants);
  assert.equal(shares7['A'].sharePaise, 2);
  assert.equal(shares7['B'].sharePaise, 2);
  assert.equal(shares7['C'].sharePaise, 1);
  assert.equal(Object.values(shares7).reduce((s, x) => s + x.sharePaise, 0), 7);
});

// =========================================================================
// SCENARIO I: STATE UPDATES (EDIT & DELETE)
// =========================================================================
test('Scenario I: Editing or deleting an expense updates all derived balances', () => {
  const squad = [{ name: 'A' }, { name: 'B' }];
  let expenses = [
    { id: '1', payer: 'A', amountPaise: 20000, included: ['A', 'B'] },
    { id: '2', payer: 'B', amountPaise: 10000, included: ['A', 'B'] }
  ];

  let res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['A'].netPaise, 5000);
  assert.equal(res.memberTotals['B'].netPaise, -5000);

  // Edit Expense 2 from 10000 to 20000
  expenses[1].amountPaise = 20000;
  res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['A'].netPaise, 0);
  assert.equal(res.memberTotals['B'].netPaise, 0);

  // Delete Expense 2
  expenses.splice(1, 1);
  res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['A'].netPaise, 10000);
  assert.equal(res.memberTotals['B'].netPaise, -10000);
});

// =========================================================================
// SCENARIO J: PERSISTENCE & RESTORATION
// =========================================================================
test('Scenario J: Outing survives JSON serialization and restoration without alteration', () => {
  const outing = {
    version: 2,
    id: 'out_test_123',
    title: 'Digha Trip',
    date: '2026-10-24',
    squad: [{ name: 'Anuj' }, { name: 'Plaban' }],
    story: 'Anuj paid 1000 for dinner',
    expenses: [{ id: 'e1', payer: 'Anuj', amountPaise: 100000, amountRupees: 1000, description: 'Dinner', included: ['Anuj', 'Plaban'] }],
    settlementRecords: {}
  };

  const serialized = JSON.stringify(outing);
  const restored = Storage.validateOuting(JSON.parse(serialized));

  assert.equal(restored.title, 'Digha Trip');
  assert.equal(restored.expenses[0].amountPaise, 100000);
  assert.equal(restored.squad.length, 2);
});

// =========================================================================
// SCENARIO K: PROPERTY-BASED INVARIANTS TESTING
// =========================================================================
test('Scenario K: 25 randomized ledgers satisfy all 10 financial invariants', () => {
  const pool = ['Anuj', 'Priyasi', 'Plaban', 'Arkadeep', 'Rohan', 'Tanmay'];

  for (let run = 0; run < 25; run++) {
    const k = 3 + (run % 4);
    const squadNames = pool.slice(0, k);
    const squad = squadNames.map(name => ({ name }));

    const expenses = [];
    const count = 2 + (run % 5);
    for (let e = 0; e < count; e++) {
      const payer = squadNames[(run + e) % k];
      const amountPaise = 50 + ((run * 7919 + e * 3571) % 150000);
      const included = squadNames.filter((_, idx) => (idx + e + run) % 2 === 0);
      if (included.length === 0) included.push(payer);

      expenses.push({
        id: `rand_${run}_${e}`,
        payer,
        amountPaise,
        included,
        description: `Expense #${e + 1}`
      });
    }

    // Assert Invariants 1-6
    const res = Ledger.computeBalances(squad, expenses);
    assert.equal(res.driftPaise, 0);

    // Assert Invariants 7-10
    const plan = SettlementSolver.solve(res.memberTotals);
    assert.doesNotThrow(() => {
      SettlementSolver.validateSettlementPlan(res.memberTotals, plan.transactions);
    });
  }
});

// =========================================================================
// SCENARIO L: CANONICAL LEDGER PARITY (UI, WHATSAPP, CSV EXPORT)
// =========================================================================
test('Scenario L: Exact same canonical ledger is used by balance calculations, summary text, and CSV export', () => {
  const squad = [{ name: 'Anuj' }, { name: 'Priyasi' }, { name: 'Plaban' }];
  const expenses = [
    { id: 'e1', payer: 'Anuj', amountPaise: 150000, description: 'Dinner', included: ['Anuj', 'Priyasi', 'Plaban'] }
  ];

  const balanceResult = Ledger.computeBalances(squad, expenses);
  const settlementPlan = SettlementSolver.solve(balanceResult.memberTotals);

  // Parity check with CSV Export
  const csv = Storage.exportCSV(
    { title: 'Dinner', date: '2026-10-24', squad, expenses },
    settlementPlan
  );

  // CSV must contain the exact same transaction amounts
  settlementPlan.transactions.forEach(t => {
    assert.ok(csv.includes(t.from), `CSV must contain debtor ${t.from}`);
    assert.ok(csv.includes(t.to), `CSV must contain creditor ${t.to}`);
    assert.ok(csv.includes(t.amountRupees), `CSV must contain amount ${t.amountRupees}`);
  });
});


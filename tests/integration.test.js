const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

const { Money, Parser, Ledger, SettlementSolver, SettlementTracker, Storage } = Engine;

// =========================================================================
// INTEGRATION & END-TO-END FLOW TESTS
// =========================================================================

test('E2E Flow: Group -> Story -> Review & Correct -> Calculate -> Settlement Tracking', () => {
  // Step 1: Create an outing and add participants
  const outing = {
    version: 2,
    id: 'outing_goa_2026',
    title: 'Goa Weekend 2026',
    date: '2026-10-24',
    squad: [
      { name: 'Anuj', upi: 'anuj@oksbi' },
      { name: 'Arka', upi: 'arka@okaxis' },
      { name: 'Ritesh', upi: 'ritesh@paytm' }
    ],
    story: 'Anuj paid 1200 for lunch. Arka spent 600 for drinks without Ritesh.',
    expenses: [],
    settlementRecords: {}
  };

  // Step 2: Parse narrative story into candidate parsed expenses
  const squadNames = outing.squad.map(s => s.name);
  const candidates = Parser.parseStory(outing.story, squadNames);

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].payer, 'Anuj');
  assert.equal(candidates[0].amountPaise, 120000);
  assert.equal(candidates[1].payer, 'Arka');
  assert.equal(candidates[1].amountPaise, 60000);
  assert.deepEqual(candidates[1].excluded, ['Ritesh']);

  // Step 3: Review and correct the parsed expenses before commit
  // User corrects candidate 0 description from generic to "Seafood Lunch"
  // User adds Ritesh back or adjusts amount to ₹1,500.00
  candidates[0].description = 'Seafood Lunch at Brittos';
  candidates[0].amountPaise = 150000;
  candidates[0].amountRupees = 1500.00;

  // Step 4: Commit reviewed expenses to ledger
  outing.expenses = candidates.map(c => ({
    id: c.id,
    raw: c.raw,
    description: c.description,
    payer: c.payer,
    amountRupees: c.amountRupees,
    amountPaise: c.amountPaise,
    included: c.included,
    excluded: c.excluded
  }));

  // Step 5: Calculate balances
  const balanceResult = Ledger.computeBalances(outing.squad, outing.expenses);
  assert.equal(balanceResult.totalSpendPaise, 210000); // 1500 + 600 = 2100.00
  assert.equal(balanceResult.driftPaise, 0);

  // Anuj paid 1500; consumed: 500 (lunch) + 300 (drinks) = 800. Net = +700 (70000 paise)
  assert.equal(balanceResult.memberTotals['Anuj'].netPaise, 70000);
  // Arka paid 600; consumed: 500 (lunch) + 300 (drinks) = 800. Net = -200 (-20000 paise)
  assert.equal(balanceResult.memberTotals['Arka'].netPaise, -20000);
  // Ritesh paid 0; consumed: 500 (lunch) + 0 (drinks) = 500. Net = -500 (-50000 paise)
  assert.equal(balanceResult.memberTotals['Ritesh'].netPaise, -50000);

  // Step 6: Generate settlements
  const settlementPlan = SettlementSolver.solve(balanceResult.memberTotals);
  assert.equal(settlementPlan.optimal, true);
  assert.equal(settlementPlan.transactions.length, 2);

  // Transactions:
  // Ritesh pays Anuj ₹500
  // Arka pays Anuj ₹200
  const riteshTx = settlementPlan.transactions.find(t => t.from === 'Ritesh' && t.to === 'Anuj');
  const arkaTx = settlementPlan.transactions.find(t => t.from === 'Arka' && t.to === 'Anuj');
  assert.ok(riteshTx);
  assert.equal(riteshTx.amountPaise, 50000);
  assert.equal(riteshTx.creditorUpi, 'anuj@oksbi');
  assert.ok(arkaTx);
  assert.equal(arkaTx.amountPaise, 20000);

  // Step 7: Verify UPI Payment Intent String Generation
  const upiUri = `upi://pay?pa=${encodeURIComponent(riteshTx.creditorUpi)}&pn=${encodeURIComponent(riteshTx.to)}&am=${riteshTx.amountRupees}&cu=INR&tn=${encodeURIComponent('HisabMate: ' + outing.title)}`;
  assert.ok(upiUri.includes('pa=anuj%40oksbi'));
  assert.ok(upiUri.includes('am=500.00'));
  assert.ok(upiUri.includes('cu=INR'));

  // Step 8: Settlement Tracking (Mark as Settled with timestamp & undo)
  let progress = SettlementTracker.getProgress(settlementPlan.transactions, outing.settlementRecords);
  assert.equal(progress.percentSettled, 0);

  // Ritesh marks transaction settled
  outing.settlementRecords[riteshTx.id] = SettlementTracker.createRecord(riteshTx.id, 'UPI ref: 981247');
  progress = SettlementTracker.getProgress(settlementPlan.transactions, outing.settlementRecords);
  assert.equal(progress.settledCount, 1);
  assert.equal(progress.percentSettled, 71); // 500 / 700 = 71.4% -> 71%

  // Undo Ritesh's settlement
  delete outing.settlementRecords[riteshTx.id];
  progress = SettlementTracker.getProgress(settlementPlan.transactions, outing.settlementRecords);
  assert.equal(progress.settledCount, 0);
  assert.equal(progress.percentSettled, 0);

  // Step 9: Export & Import verification
  const exportedJson = JSON.stringify(outing);
  const validatedImport = Storage.validateOuting(JSON.parse(exportedJson));
  assert.equal(validatedImport.title, 'Goa Weekend 2026');
  assert.equal(validatedImport.expenses.length, 2);

  // Step 10: URL Hash serialization and deserialization
  const hash = Storage.encodeSharePayload(outing);
  const decoded = Storage.decodeSharePayload(hash);
  assert.equal(decoded.title, 'Goa Weekend 2026');
  assert.equal(decoded.squad.length, 3);
  assert.equal(decoded.expenses.length, 2);
  assert.equal(decoded.expenses[0].amountPaise, 150000);
});

// =========================================================================
// EDGE CASES TESTING
// =========================================================================
test('Edge Case: Zero expenses results in 0 balance and 0 transactions', () => {
  const squad = [{ name: 'Anuj' }, { name: 'Arka' }];
  const balanceResult = Ledger.computeBalances(squad, []);
  assert.equal(balanceResult.totalSpendPaise, 0);
  assert.equal(balanceResult.driftPaise, 0);

  const plan = SettlementSolver.solve(balanceResult.memberTotals);
  assert.equal(plan.transactions.length, 0);
});

test('Edge Case: All participants have net balance 0 (fully square)', () => {
  // Anuj paid 500 for Arka, Arka paid 500 for Anuj
  const squad = [{ name: 'Anuj' }, { name: 'Arka' }];
  const expenses = [
    { payer: 'Anuj', amountPaise: 50000, included: ['Arka'] },
    { payer: 'Arka', amountPaise: 50000, included: ['Anuj'] }
  ];
  const balanceResult = Ledger.computeBalances(squad, expenses);
  assert.equal(balanceResult.memberTotals['Anuj'].netPaise, 0);
  assert.equal(balanceResult.memberTotals['Arka'].netPaise, 0);

  const plan = SettlementSolver.solve(balanceResult.memberTotals);
  assert.equal(plan.transactions.length, 0);
});

test('Edge Case: Single participant handles own expense', () => {
  const squad = [{ name: 'Solo' }];
  const expenses = [{ payer: 'Solo', amountPaise: 10000, included: ['Solo'] }];
  const balanceResult = Ledger.computeBalances(squad, expenses);
  assert.equal(balanceResult.memberTotals['Solo'].netPaise, 0);

  const plan = SettlementSolver.solve(balanceResult.memberTotals);
  assert.equal(plan.transactions.length, 0);
});

test('Edge Case: Corrupt or invalid JSON import is safely rejected', () => {
  assert.throws(() => {
    Storage.validateOuting(null);
  }, /Invalid outing data/);

  assert.throws(() => {
    Storage.validateOuting({ squad: 'not-an-array' });
  }, /Squad must be an array/);

  assert.throws(() => {
    Storage.validateOuting({
      squad: [{ name: '' }],
      expenses: []
    });
  }, /Squad member must have a non-empty name/);
});


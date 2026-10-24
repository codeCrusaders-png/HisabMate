const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

const { Money, Parser, Ledger, SettlementSolver, SettlementTracker, Storage } = Engine;

// =========================================================================
// REGRESSION TEST SUITE: CRITICAL PARSING, FINANCIAL ACCURACY & SETTLEMENT
// =========================================================================

// --- SCENARIO A: PHANTOM PARTICIPANTS PREVENTION ---
test('Scenario A: Merchant names and ordinary sentence fragments never become participants', () => {
  const squad = ['Vikram', 'Sarah', 'Rahul', 'Aisha', 'David'];

  // 1. "Airbnb" mentioned in expense description
  const clause1 = 'Vikram paid ₹2,000 for Airbnb shared by everyone except David.';
  const p1 = Parser.parseClause(clause1, squad);
  assert.equal(p1.payer, 'Vikram');
  assert.equal(p1.description, 'Airbnb');
  assert.equal(p1.included.includes('Airbnb'), false, 'Airbnb must never become an included participant');
  assert.equal(p1.excluded.includes('Airbnb'), false, 'Airbnb must never become an excluded participant');

  // 2. Clause beginning with "Finally"
  const clause2 = 'Finally, Rahul paid ₹850 for dinner for everyone.';
  const p2 = Parser.parseClause(clause2, squad);
  assert.equal(p2.payer, 'Rahul', 'Transitional adverb "Finally" must not be parsed as payer');
  assert.equal(p2.description, 'Dinner');
  assert.equal(p2.included.includes('Finally'), false, 'Finally must never become a participant');

  // 3. Various ordinary items/vendors: Cab, Uber, Dinner, Swiggy, Zomato, Drinks
  const story = 'Vikram paid 500 for Cab for all. Sarah paid 400 for Swiggy for everyone. David paid 300 for Uber for all.';
  const expenses = Parser.parseStory(story, squad);
  expenses.forEach(e => {
    assert.ok(squad.includes(e.payer), `Payer ${e.payer} must be a registered squad member`);
    e.included.forEach(inc => {
      assert.ok(squad.includes(inc), `Included participant ${inc} must be a registered squad member`);
    });
  });

  // 4. Ledger computeBalances must strictly reject unregistered payer
  assert.throws(() => {
    Ledger.computeBalances(squad, [{
      payer: 'Airbnb',
      amountPaise: 200000,
      included: ['Vikram', 'Sarah']
    }]);
  }, /Only registered squad members can pay expenses/);

  // 5. Ledger computeBalances must strictly reject unregistered beneficiary
  assert.throws(() => {
    Ledger.computeBalances(squad, [{
      payer: 'Vikram',
      amountPaise: 200000,
      allocations: { 'Finally': 100000, 'Vikram': 100000 }
    }]);
  }, /Unknown or unregistered beneficiary "Finally"/);
});

// --- SCENARIO B: PARTICIPANT ISOLATION ---
test('Scenario B: Starting a new outing isolates participants from past groups', () => {
  const savedGroup = [{ name: 'Anuj' }, { name: 'Priyasi' }, { name: 'Plaban' }, { name: 'Arkadeep' }];
  const newOutingSquad = [
    { name: 'Vikram' },
    { name: 'Sarah' },
    { name: 'Rahul' },
    { name: 'Aisha' },
    { name: 'David' }
  ];

  const outing = Storage.validateOuting({
    id: 'outing_new_1',
    title: 'Goa Trip',
    date: '2026-10-24',
    squad: newOutingSquad,
    story: '',
    expenses: []
  });

  assert.equal(outing.squad.length, 5);
  const names = outing.squad.map(s => s.name);
  assert.deepEqual(names.sort(), ['Aisha', 'David', 'Rahul', 'Sarah', 'Vikram']);

  // Verify none of the previous saved group members leak in
  savedGroup.forEach(g => {
    assert.equal(names.includes(g.name), false, `Previous member ${g.name} must not leak into new outing`);
  });
});

// --- SCENARIO C: SCOPED EXCLUSIONS ---
test('Scenario C: Exclusions are scoped strictly per expense and do not leak across expenses', () => {
  const squad = ['Vikram', 'Sarah', 'Rahul', 'Aisha', 'David'];

  const exp1Clause = 'Vikram paid ₹2,000 for Airbnb shared by everyone except David.';
  const exp2Clause = 'David paid ₹1,200 for tickets shared by everyone except Rahul.';

  const p1 = Parser.parseClause(exp1Clause, squad);
  const p2 = Parser.parseClause(exp2Clause, squad);

  // Exp 1 excludes David, includes Vikram, Sarah, Rahul, Aisha
  assert.deepEqual(p1.excluded, ['David']);
  assert.equal(p1.included.includes('David'), false);
  assert.equal(p1.included.includes('Rahul'), true);

  // Exp 2 excludes Rahul, includes David!
  assert.deepEqual(p2.excluded, ['Rahul']);
  assert.equal(p2.included.includes('David'), true, 'David must be included in expense 2');
  assert.equal(p2.included.includes('Rahul'), false, 'Rahul must be excluded from expense 2');
});

// --- SCENARIO D: PARTIAL / SPECIFIC ITEM ALLOCATIONS ---
test('Scenario D: Partial specific allocations preserve individual share and split the remainder', () => {
  const squad = ['Vikram', 'Sarah', 'Rahul', 'Aisha', 'David'];

  const clause = 'Rahul paid ₹850 for dinner, including a specific ₹250 meal for Aisha, with the remaining ₹600 shared according to the stated rule.';
  const p = Parser.parseClause(clause, squad);

  assert.equal(p.payer, 'Rahul');
  assert.equal(p.amountPaise, 85000);
  assert.equal(p.splitType, 'itemized');
  assert.ok(p.allocations, 'Should produce an allocations map');

  // Remainder ₹600 split among 5 squad members = ₹120 each (12,000 paise)
  // Aisha gets ₹250 + ₹120 = ₹370 (37,000 paise)
  assert.equal(p.allocations['Aisha'], 37000);
  assert.equal(p.allocations['Vikram'], 12000);
  assert.equal(p.allocations['Sarah'], 12000);
  assert.equal(p.allocations['Rahul'], 12000);
  assert.equal(p.allocations['David'], 12000);

  const totalAlloc = Object.values(p.allocations).reduce((a, b) => a + b, 0);
  assert.equal(totalAlloc, 85000, 'Sum of allocations must equal 85,000 paise exactly');
});

// --- SCENARIO E: PROPORTIONAL CONSUMPTION ---
test('Scenario E: Proportional consumption allocates exact fraction and remainder without drift', () => {
  const squad = ['Vikram', 'Sarah', 'Rahul', 'Aisha', 'David'];

  const clause = 'Aisha paid ₹500 for drinks, and David consumed half while Rahul and Aisha shared the remainder.';
  const p = Parser.parseClause(clause, squad);

  assert.equal(p.payer, 'Aisha');
  assert.equal(p.amountPaise, 50000);
  assert.equal(p.splitType, 'proportional');
  assert.ok(p.allocations);

  // David half = ₹250 (25,000 paise)
  // Remainder ₹250 split between Rahul and Aisha = ₹125 each (12,500 paise)
  assert.equal(p.allocations['David'], 25000);
  assert.equal(p.allocations['Rahul'], 12500);
  assert.equal(p.allocations['Aisha'], 12500);
  assert.equal(p.allocations['Vikram'] || 0, 0);
  assert.equal(p.allocations['Sarah'] || 0, 0);

  const sumAlloc = Object.values(p.allocations).reduce((a, b) => a + b, 0);
  assert.equal(sumAlloc, 50000, 'Sum of allocations must equal ₹500 (50,000 paise) exactly');
});

// --- SCENARIO F & G: MULTIPLE INDEPENDENT PAYMENTS & BALANCE RECONCILIATION ---
test('Scenario F & G: Illustrative Master Narrative splits 5 distinct expenses and reconciles zero-drift balances', () => {
  const squad = [
    { name: 'Vikram' },
    { name: 'Sarah' },
    { name: 'Rahul' },
    { name: 'Aisha' },
    { name: 'David' }
  ];
  const squadNames = squad.map(s => s.name);

  const fullNarrative = [
    'Vikram paid ₹2,000 for Airbnb shared by everyone except David.',
    'Sarah paid ₹1,000 for dinner for everyone except Aisha.',
    'Rahul paid ₹850 for dinner, including a specific ₹250 meal for Aisha, with the remaining ₹600 shared according to the stated rule.',
    'Aisha paid ₹500 for drinks, and David consumed half while Rahul and Aisha shared the remainder.',
    'David paid ₹1,200 for tickets shared by everyone except Rahul.'
  ].join(' ');

  const expenses = Parser.parseStory(fullNarrative, squadNames);
  assert.equal(expenses.length, 5, 'Must parse exactly 5 independent expense events');

  // Verify payers
  assert.equal(expenses[0].payer, 'Vikram');
  assert.equal(expenses[1].payer, 'Sarah');
  assert.equal(expenses[2].payer, 'Rahul');
  assert.equal(expenses[3].payer, 'Aisha');
  assert.equal(expenses[4].payer, 'David');

  // Compute canonical ledger
  const result = Ledger.computeBalances(squad, expenses);
  const totals = result.memberTotals;

  // Total Spend = 2000 + 1000 + 850 + 500 + 1200 = ₹5,550.00 (555,000 paise)
  assert.equal(result.totalSpendPaise, 555000);
  assert.equal(result.sumPaid, 555000);
  assert.equal(result.sumConsumed, 555000);
  assert.equal(result.driftPaise, 0);

  // 1. Vikram: Paid 2000, Consumed 500 + 250 + 120 + 0 + 300 = 1170, Net = +830
  assert.equal(totals['Vikram'].paidPaise, 200000);
  assert.equal(totals['Vikram'].consumedPaise, 117000);
  assert.equal(totals['Vikram'].netPaise, 83000);

  // 2. Sarah: Paid 1000, Consumed 500 + 250 + 120 + 0 + 300 = 1170, Net = -170
  assert.equal(totals['Sarah'].paidPaise, 100000);
  assert.equal(totals['Sarah'].consumedPaise, 117000);
  assert.equal(totals['Sarah'].netPaise, -17000);

  // 3. Rahul: Paid 850, Consumed 500 + 250 + 120 + 125 + 0 = 995, Net = -145
  assert.equal(totals['Rahul'].paidPaise, 85000);
  assert.equal(totals['Rahul'].consumedPaise, 99500);
  assert.equal(totals['Rahul'].netPaise, -14500);

  // 4. Aisha: Paid 500, Consumed 500 + 0 + 370 + 125 + 300 = 1295, Net = -795
  assert.equal(totals['Aisha'].paidPaise, 50000);
  assert.equal(totals['Aisha'].consumedPaise, 129500);
  assert.equal(totals['Aisha'].netPaise, -79500);

  // 5. David: Paid 1200, Consumed 0 + 250 + 120 + 250 + 300 = 920, Net = +280
  assert.equal(totals['David'].paidPaise, 120000);
  assert.equal(totals['David'].consumedPaise, 92000);
  assert.equal(totals['David'].netPaise, 28000);

  // Check sum of net balances is zero
  const netSum = Object.values(totals).reduce((sum, m) => sum + m.netPaise, 0);
  assert.equal(netSum, 0, 'Sum of all net balances must equal zero exactly');

  // Verify Settlement Plan
  const plan = SettlementSolver.solve(totals);
  assert.equal(plan.transactions.length, 4, 'Optimal minimal transactions must be exactly 4');
  assert.equal(plan.optimal, true);

  // Ensure all transfers resolve balances exactly
  const settledBalances = {};
  squadNames.forEach(n => settledBalances[n] = totals[n].netPaise);
  plan.transactions.forEach(t => {
    settledBalances[t.from] += t.amountPaise;
    settledBalances[t.to] -= t.amountPaise;
  });
  Object.keys(settledBalances).forEach(n => {
    assert.equal(settledBalances[n], 0, `Participant ${n} balance must be fully zeroed`);
  });
});

// --- SCENARIO H: REGRESSION AFTER EDITING ---
test('Scenario H: Editing an expense amount or allocation recomputes all dependent balances and settlements', () => {
  const squad = [{ name: 'A' }, { name: 'B' }];
  const expenses = [
    { payer: 'A', amountPaise: 10000, description: 'Lunch', included: ['A', 'B'] }
  ];

  let res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['A'].netPaise, 5000);
  assert.equal(res.memberTotals['B'].netPaise, -5000);

  // Edit expense: amount changed to ₹200
  expenses[0].amountPaise = 20000;
  res = Ledger.computeBalances(squad, expenses);
  assert.equal(res.memberTotals['A'].netPaise, 10000);
  assert.equal(res.memberTotals['B'].netPaise, -10000);

  const plan = SettlementSolver.solve(res.memberTotals);
  assert.equal(plan.transactions[0].amountPaise, 10000);
});

// --- SCENARIO I: INVALID INPUT HANDLING ---
test('Scenario I: Rejects invalid, malformed, or contradictory inputs safely without corrupting ledger', () => {
  const squad = ['Anuj', 'Plaban'];

  // Missing or negative amount
  assert.throws(() => {
    Ledger.computeBalances(squad, [{ payer: 'Anuj', amountPaise: -500 }]);
  }, /non-positive amount/);

  // Unknown participant in equal split
  assert.throws(() => {
    Ledger.computeBalances(squad, [{ payer: 'UnknownPerson', amountPaise: 1000 }]);
  }, /Only registered squad members can pay expenses/);

  // Contradictory custom allocation sum
  assert.throws(() => {
    Ledger.computeBalances(squad, [{
      payer: 'Anuj',
      amountPaise: 10000,
      allocations: { Anuj: 4000, Plaban: 4000 } // Sum = 8000 != 10000
    }]);
  }, /Allocation Invariant Violation/);
});


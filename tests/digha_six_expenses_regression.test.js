const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

const { Money, Parser, Ledger, SettlementSolver } = Engine;

// =========================================================================
// REGRESSION TEST SUITE: DIGHA 6-EXPENSE SCENARIO & GENERAL PARSER INTEGRITY
// =========================================================================

const SQUAD_NAMES = ['Anuj', 'Priyasi', 'Plaban', 'Arkadeep', 'Rohan', 'Sneha'];
const SQUAD_OBJECTS = SQUAD_NAMES.map(name => ({ name, upi: '' }));

// --- TEST 1: UNFORMATTED SENTENCES NARRATIVE ---
test('Test 1: Unformatted Digha narrative produces exactly 6 expense events and ₹9,000 spend', () => {
  const story = `
    Use only the six registered squad members.
    Calculate every expense independently.
    Anuj paid ₹3,600 for hotel, excluding Sneha.
    Priyasi paid ₹1,200 for dinner, shared by Anuj, Priyasi, Plaban, and Arkadeep.
    Plaban paid ₹900 for cab, shared by all six registered members.
    Arkadeep paid ₹1,500 for seafood. Allocated Anuj ₹300, Priyasi ₹450, and Plaban ₹750. The other three excluded.
    Rohan paid ₹600 for snacks. Rohan and Sneha share half equally. Anuj and Priyasi share the remaining half equally.
    Sneha paid ₹1,200 for boat ride, shared by Anuj, Priyasi, Rohan, and Sneha.
  `;

  const expenses = Parser.parseStory(story, SQUAD_NAMES);

  assert.equal(expenses.length, 6, 'Must parse exactly six expenses, ignoring instructions');

  // Verify Total Spend = ₹9,000.00 (900,000 paise)
  const totalPaise = expenses.reduce((sum, e) => sum + e.amountPaise, 0);
  assert.equal(totalPaise, 900000, 'Total spend must be exactly ₹9,000.00');

  // 1. Hotel: Anuj ₹3,600, Sneha excluded
  assert.equal(expenses[0].payer, 'Anuj');
  assert.equal(expenses[0].amountPaise, 360000);
  assert.deepEqual(expenses[0].excluded, ['Sneha']);
  assert.deepEqual(expenses[0].included.sort(), ['Anuj', 'Arkadeep', 'Plaban', 'Priyasi', 'Rohan'].sort());

  // 2. Dinner: Priyasi ₹1,200, shared by Anuj, Priyasi, Plaban, Arkadeep
  assert.equal(expenses[1].payer, 'Priyasi');
  assert.equal(expenses[1].amountPaise, 120000);
  assert.deepEqual(expenses[1].included.sort(), ['Anuj', 'Arkadeep', 'Plaban', 'Priyasi'].sort());

  // 3. Cab: Plaban ₹900, shared by all six registered members
  assert.equal(expenses[2].payer, 'Plaban');
  assert.equal(expenses[2].amountPaise, 90000);
  assert.equal(expenses[2].included.length, 6);

  // 4. Seafood: Arkadeep ₹1,500, Custom allocations: Anuj ₹300, Priyasi ₹450, Plaban ₹750
  assert.equal(expenses[3].payer, 'Arkadeep');
  assert.equal(expenses[3].amountPaise, 150000);
  assert.equal(expenses[3].splitType, 'custom');
  assert.ok(expenses[3].allocations, 'Seafood must have explicit custom allocations');
  assert.equal(expenses[3].allocations['Anuj'], 30000);
  assert.equal(expenses[3].allocations['Priyasi'], 45000);
  assert.equal(expenses[3].allocations['Plaban'], 75000);
  assert.equal(expenses[3].allocations['Arkadeep'] || 0, 0);
  assert.equal(expenses[3].allocations['Rohan'] || 0, 0);
  assert.equal(expenses[3].allocations['Sneha'] || 0, 0);

  // 5. Snacks: Rohan ₹600, Rohan & Sneha share half, Anuj & Priyasi share remaining half (₹150 each)
  assert.equal(expenses[4].payer, 'Rohan');
  assert.equal(expenses[4].amountPaise, 60000);
  assert.ok(expenses[4].allocations, 'Snacks must have explicit allocations');
  assert.equal(expenses[4].allocations['Rohan'], 15000);
  assert.equal(expenses[4].allocations['Sneha'], 15000);
  assert.equal(expenses[4].allocations['Anuj'], 15000);
  assert.equal(expenses[4].allocations['Priyasi'], 15000);
  assert.equal(expenses[4].allocations['Plaban'] || 0, 0);
  assert.equal(expenses[4].allocations['Arkadeep'] || 0, 0);

  // 6. Boat ride: Sneha ₹1,200, shared by Anuj, Priyasi, Rohan, Sneha
  assert.equal(expenses[5].payer, 'Sneha');
  assert.equal(expenses[5].amountPaise, 120000);
  assert.deepEqual(expenses[5].included.sort(), ['Anuj', 'Priyasi', 'Rohan', 'Sneha'].sort());
});

// --- TEST 2: NUMBERED LIST FORMAT ---
test('Test 2: Numbered Digha list format parses exactly 6 expenses with per-person snacks syntax', () => {
  const numberedStory = `
    1. Anuj — ₹3,600 hotel, excluding Sneha.
    2. Priyasi — ₹1,200 dinner, shared by Anuj, Priyasi, Plaban, and Arkadeep.
    3. Plaban — ₹900 cab, shared by all six registered members.
    4. Arkadeep — ₹1,500 seafood, allocated Anuj ₹300, Priyasi ₹450, and Plaban ₹750, with the other three excluded.
    5. Rohan — ₹600 snacks, split ₹150 each among Rohan, Sneha, Anuj, and Priyasi.
    6. Sneha — ₹1,200 boat ride, shared by Anuj, Priyasi, Rohan, and Sneha.
  `;

  const expenses = Parser.parseStory(numberedStory, SQUAD_NAMES);
  assert.equal(expenses.length, 6, 'Must parse exactly six expenses from numbered list');

  // Verify Seafood
  assert.equal(expenses[3].payer, 'Arkadeep');
  assert.equal(expenses[3].amountPaise, 150000);
  assert.equal(expenses[3].allocations['Anuj'], 30000);
  assert.equal(expenses[3].allocations['Priyasi'], 45000);
  assert.equal(expenses[3].allocations['Plaban'], 75000);

  // Verify Snacks via "split ₹150 each among..."
  assert.equal(expenses[4].payer, 'Rohan');
  assert.equal(expenses[4].amountPaise, 60000);
  assert.equal(expenses[4].allocations['Anuj'], 15000);
  assert.equal(expenses[4].allocations['Priyasi'], 15000);
  assert.equal(expenses[4].allocations['Rohan'], 15000);
  assert.equal(expenses[4].allocations['Sneha'], 15000);
});

// --- TEST 3: CONTINUOUS PARAGRAPH WITHOUT LINE BREAKS ---
test('Test 3: Continuous single-paragraph narrative correctly extracts 6 events', () => {
  const paragraph = 'Use only the six registered squad members. Calculate every expense independently. Anuj paid ₹3,600 for hotel, excluding Sneha. Priyasi paid ₹1,200 for dinner, shared by Anuj, Priyasi, Plaban, and Arkadeep. Plaban paid ₹900 for cab, shared by all six registered members. Arkadeep paid ₹1,500 for seafood. Allocated Anuj ₹300, Priyasi ₹450, and Plaban ₹750. The other three excluded. Rohan paid ₹600 for snacks. Rohan and Sneha share half equally. Anuj and Priyasi share the remaining half equally. Sneha paid ₹1,200 for boat ride, shared by Anuj, Priyasi, Rohan, and Sneha.';

  const expenses = Parser.parseStory(paragraph, SQUAD_NAMES);
  assert.equal(expenses.length, 6, 'Must parse exactly 6 events from continuous paragraph');
});

// --- TEST 4: LEDGER BALANCES & MATHEMATICAL INVARIANTS ---
test('Test 4: Ledger computes exact individual balances with zero drift', () => {
  const story = `
    Anuj paid ₹3,600 for hotel, excluding Sneha.
    Priyasi paid ₹1,200 for dinner, shared by Anuj, Priyasi, Plaban, and Arkadeep.
    Plaban paid ₹900 for cab, shared by all six registered members.
    Arkadeep paid ₹1,500 for seafood. Allocated Anuj ₹300, Priyasi ₹450, and Plaban ₹750. The other three excluded.
    Rohan paid ₹600 for snacks. Rohan and Sneha share half equally. Anuj and Priyasi share the remaining half equally.
    Sneha paid ₹1,200 for boat ride, shared by Anuj, Priyasi, Rohan, and Sneha.
  `;

  const expenses = Parser.parseStory(story, SQUAD_NAMES);
  const balances = Ledger.computeBalances(SQUAD_OBJECTS, expenses);

  // Invariant 1: Total Spend = 900,000 paise
  assert.equal(balances.totalSpendPaise, 900000);
  // Invariant 2: Sum(Paid) === Sum(Consumed) === TotalSpend
  assert.equal(balances.sumPaid, 900000);
  assert.equal(balances.sumConsumed, 900000);
  // Invariant 3: Zero drift
  assert.equal(balances.driftPaise, 0);

  const t = balances.memberTotals;

  // Anuj: Paid 3600. Consumed: 720 (hotel) + 300 (dinner) + 150 (cab) + 300 (seafood) + 150 (snacks) + 300 (boat) = 1920. Net = +1680.
  assert.equal(t['Anuj'].paidPaise, 360000);
  assert.equal(t['Anuj'].consumedPaise, 192000);
  assert.equal(t['Anuj'].netPaise, 168000);

  // Priyasi: Paid 1200. Consumed: 720 + 300 + 150 + 450 + 150 + 300 = 2070. Net = -870.
  assert.equal(t['Priyasi'].paidPaise, 120000);
  assert.equal(t['Priyasi'].consumedPaise, 207000);
  assert.equal(t['Priyasi'].netPaise, -87000);

  // Plaban: Paid 900. Consumed: 720 + 300 + 150 + 750 + 0 + 0 = 1920. Net = -1020.
  assert.equal(t['Plaban'].paidPaise, 90000);
  assert.equal(t['Plaban'].consumedPaise, 192000);
  assert.equal(t['Plaban'].netPaise, -102000);

  // Arkadeep: Paid 1500. Consumed: 720 + 300 + 150 + 0 + 0 + 0 = 1170. Net = +330.
  assert.equal(t['Arkadeep'].paidPaise, 150000);
  assert.equal(t['Arkadeep'].consumedPaise, 117000);
  assert.equal(t['Arkadeep'].netPaise, 33000);

  // Rohan: Paid 600. Consumed: 720 + 0 + 150 + 0 + 150 + 300 = 1320. Net = -720.
  assert.equal(t['Rohan'].paidPaise, 60000);
  assert.equal(t['Rohan'].consumedPaise, 132000);
  assert.equal(t['Rohan'].netPaise, -72000);

  // Sneha: Paid 1200. Consumed: 0 + 0 + 150 + 0 + 150 + 300 = 600. Net = +600.
  assert.equal(t['Sneha'].paidPaise, 120000);
  assert.equal(t['Sneha'].consumedPaise, 60000);
  assert.equal(t['Sneha'].netPaise, 60000);

  // Invariant 4: Sum(Net) === 0
  const sumNet = Object.values(t).reduce((acc, m) => acc + m.netPaise, 0);
  assert.equal(sumNet, 0, 'Sum of all net balances must be exactly 0 paise');
});

// --- TEST 5: SETTLEMENT TRANSFERS ---
test('Test 5: Settlement solver produces exact optimal 5 transfers resolving all dues', () => {
  const memberTotals = {
    Anuj: { netPaise: 168000 },
    Priyasi: { netPaise: -87000 },
    Plaban: { netPaise: -102000 },
    Arkadeep: { netPaise: 33000 },
    Rohan: { netPaise: -72000 },
    Sneha: { netPaise: 60000 }
  };

  const solution = SettlementSolver.solve(memberTotals, SQUAD_OBJECTS);

  assert.equal(solution.optimal, true);
  assert.equal(solution.transactions.length, 5, 'Must resolve with exactly 5 transfers');

  // Verify all debts are paid and all creditors receive their exact dues
  const netCheck = { Anuj: 0, Priyasi: 0, Plaban: 0, Arkadeep: 0, Rohan: 0, Sneha: 0 };
  solution.transactions.forEach(tx => {
    netCheck[tx.from] -= tx.amountPaise;
    netCheck[tx.to] += tx.amountPaise;
  });

  assert.equal(netCheck['Anuj'], 168000);
  assert.equal(netCheck['Arkadeep'], 33000);
  assert.equal(netCheck['Sneha'], 60000);
  assert.equal(netCheck['Priyasi'], -87000);
  assert.equal(netCheck['Plaban'], -102000);
  assert.equal(netCheck['Rohan'], -72000);
});

// --- TEST 6: REJECTION OF INSTRUCTIONAL & META TEXT ---
test('Test 6: Instructional and non-financial text never produces expense events', () => {
  const instructions = `
    Use only the six registered squad members.
    Calculate every expense independently.
    Ensure all payments are recorded in rupees.
    Note that all members are registered.
    Instructions: do not add unregistered members.
    Summary of the trip expenses follows.
  `;

  const expenses = Parser.parseStory(instructions, SQUAD_NAMES);
  assert.equal(expenses.length, 0, 'Instructional text must produce 0 expenses');
});

// --- TEST 7: INVALID ALLOCATIONS FAIL SAFELY ---
test('Test 7: Contradictory allocations retain explicit shares with warning instead of silent equal split', () => {
  // Arkadeep paid ₹1,500, but explicit shares sum to ₹1,450 (contradictory)
  const clause = 'Arkadeep paid ₹1,500 for seafood. Allocated Anuj ₹300, Priyasi ₹450, and Plaban ₹700.';
  const p = Parser.parseClause(clause, SQUAD_NAMES);

  assert.equal(p.splitType, 'custom', 'Must not silently replace custom allocations with equal split');
  assert.ok(p.allocations);
  assert.equal(p.allocations['Anuj'], 30000);
  assert.equal(p.allocations['Priyasi'], 45000);
  assert.equal(p.allocations['Plaban'], 70000);
  assert.ok(p.warnings.length > 0, 'Must have a visible validation warning');
  assert.equal(p.confidence, 'low', 'Confidence must be low');

  // Attempting to compute balances with mismatched allocations must fail safely
  assert.throws(() => {
    Ledger.computeBalances(SQUAD_OBJECTS, [{
      payer: 'Arkadeep',
      amountPaise: 150000,
      splitType: 'custom',
      allocations: p.allocations
    }]);
  }, /Allocation Invariant Violation/);
});

// --- TEST 8: UNREGISTERED PARTICIPANT SAFETY ---
test('Test 8: Unregistered participants are flagged and rejected by Ledger', () => {
  const clause = 'UnknownPerson paid ₹500 for dinner for everyone.';
  const p = Parser.parseClause(clause, SQUAD_NAMES);

  assert.equal(p.payer, 'Unresolved');
  assert.ok(p.warnings.length > 0);

  // Ledger computeBalances must throw when payer is unregistered
  assert.throws(() => {
    Ledger.computeBalances(SQUAD_OBJECTS, [{
      payer: 'UnknownPerson',
      amountPaise: 50000,
      included: SQUAD_NAMES
    }]);
  }, /Only registered squad members can pay expenses/);
});

// --- TEST 9: CURRENCY FORMATTING & WORD ORDER VARIATIONS ---
test('Test 9: Handles currency variations and diverse phrasing without failure', () => {
  const variations = [
    'Anuj paid Rs. 3600 for hotel excluding Sneha.',
    'Anuj paid 3600 INR for hotel excluding Sneha.',
    'Anuj paid ₹3,600 for hotel, excluding Sneha.',
    'Hotel of ₹3,600 paid by Anuj, excluding Sneha.',
    'Anuj — ₹3600 hotel, excluding Sneha.'
  ];

  variations.forEach(v => {
    const p = Parser.parseClause(v, SQUAD_NAMES);
    assert.equal(p.payer, 'Anuj');
    assert.equal(p.amountPaise, 360000);
    assert.deepEqual(p.excluded, ['Sneha']);
    assert.equal(p.included.includes('Sneha'), false);
  });
});


// --- TEST 10: USER REQUIRED EXAMPLE (PASSIVE MULTI-GROUP ALLOCATION) ---
test('Test 10: User required example: passive half/remaining-half splits ₹600 into ₹150 each for 4 members', () => {
  const story = 'Rohan paid ₹600 for snacks. Half the snacks cost was consumed by Rohan and Sneha equally, and the remaining half was consumed by Anuj and Priyasi equally.';

  const expenses = Parser.parseStory(story, SQUAD_NAMES);
  assert.equal(expenses.length, 1, 'Must parse exactly 1 expense');

  const exp = expenses[0];
  assert.equal(exp.payer, 'Rohan');
  assert.equal(exp.amountPaise, 60000);
  assert.equal(exp.description, 'Snacks');
  assert.equal(exp.splitType, 'proportional');
  assert.ok(exp.allocations);

  // Exact ₹150 shares
  assert.equal(exp.allocations['Rohan'], 15000);
  assert.equal(exp.allocations['Sneha'], 15000);
  assert.equal(exp.allocations['Anuj'], 15000);
  assert.equal(exp.allocations['Priyasi'], 15000);

  // Excluded members consume ₹0
  assert.equal(exp.allocations['Plaban'] || 0, 0);
  assert.equal(exp.allocations['Arkadeep'] || 0, 0);

  // Sum of allocations must equal 60,000 paise exactly
  const sumAlloc = Object.values(exp.allocations).reduce((a, b) => a + b, 0);
  assert.equal(sumAlloc, 60000);

  // Verify Ledger calculations: Rohan is payer (+450), other 3 pay -150 each, Plaban & Arka 0
  const balances = Ledger.computeBalances(SQUAD_OBJECTS, expenses);
  const totals = balances.memberTotals;

  assert.equal(totals['Rohan'].paidPaise, 60000);
  assert.equal(totals['Rohan'].consumedPaise, 15000);
  assert.equal(totals['Rohan'].netPaise, 45000);

  assert.equal(totals['Sneha'].paidPaise, 0);
  assert.equal(totals['Sneha'].consumedPaise, 15000);
  assert.equal(totals['Sneha'].netPaise, -15000);

  assert.equal(totals['Anuj'].paidPaise, 0);
  assert.equal(totals['Anuj'].consumedPaise, 15000);
  assert.equal(totals['Anuj'].netPaise, -15000);

  assert.equal(totals['Priyasi'].paidPaise, 0);
  assert.equal(totals['Priyasi'].consumedPaise, 15000);
  assert.equal(totals['Priyasi'].netPaise, -15000);

  assert.equal(totals['Plaban'].paidPaise, 0);
  assert.equal(totals['Plaban'].consumedPaise, 0);
  assert.equal(totals['Plaban'].netPaise, 0);

  assert.equal(totals['Arkadeep'].paidPaise, 0);
  assert.equal(totals['Arkadeep'].consumedPaise, 0);
  assert.equal(totals['Arkadeep'].netPaise, 0);

  // Net sum zero
  const netSum = Object.values(totals).reduce((acc, m) => acc + m.netPaise, 0);
  assert.equal(netSum, 0);
});

// --- TEST 11: MISSING AMOUNTS AND PAYERS ARE FLAGGED SAFELY ---
test('Test 11: Missing amounts and unresolved payers are safely flagged without crashing', () => {
  // Missing amount
  const p1 = Parser.parseClause('Anuj paid for snacks for everyone', SQUAD_NAMES);
  assert.equal(p1.payer, 'Anuj');
  assert.equal(p1.amountPaise, 0);
  assert.ok(p1.warnings.some(w => w.includes('Expense amount could not be determined')));
  assert.equal(p1.confidence, 'low');

  // Missing payer
  const p2 = Parser.parseClause('Paid ₹450 for lunch for all', SQUAD_NAMES);
  assert.equal(p2.payer, 'Unresolved');
  assert.equal(p2.amountPaise, 45000);
  assert.ok(p2.warnings.some(w => w.includes('Payer could not be determined')));
  assert.equal(p2.confidence, 'low');
});

// --- TEST 12: EDITING AN EXPENSE AND DERIVED RECALCULATION ---
test('Test 12: Editing an expense amount updates all derived balances deterministically', () => {
  const expenses = [
    {
      id: 'e1',
      payer: 'Anuj',
      amountPaise: 360000,
      description: 'Hotel',
      included: ['Anuj', 'Priyasi', 'Plaban', 'Arkadeep', 'Rohan'],
      excluded: ['Sneha']
    }
  ];

  let b1 = Ledger.computeBalances(SQUAD_OBJECTS, expenses);
  assert.equal(b1.totalSpendPaise, 360000);
  assert.equal(b1.memberTotals['Anuj'].netPaise, 288000); // 3600 - 720 = 2880

  // Edit amount from ₹3600 to ₹4000 (800 each)
  expenses[0].amountPaise = 400000;
  let b2 = Ledger.computeBalances(SQUAD_OBJECTS, expenses);
  assert.equal(b2.totalSpendPaise, 400000);
  assert.equal(b2.memberTotals['Anuj'].netPaise, 320000); // 4000 - 800 = 3200
  assert.equal(b2.memberTotals['Priyasi'].netPaise, -80000);
});

// --- TEST 13: OUTING SERIALIZATION & RESTORATION OF CUSTOM ALLOCATIONS ---
test('Test 13: Outing with custom allocations serializes and deserializes accurately', () => {
  const originalOuting = {
    id: 'outing_digha_test',
    title: 'Digha Trip',
    date: '2026-10-24',
    squad: SQUAD_OBJECTS,
    expenses: [
      {
        id: 'exp_seafood',
        payer: 'Arkadeep',
        amountPaise: 150000,
        description: 'Seafood',
        splitType: 'custom',
        allocations: { Anuj: 30000, Priyasi: 45000, Plaban: 75000 }
      }
    ]
  };

  const jsonStr = JSON.stringify(originalOuting);
  const restored = JSON.parse(jsonStr);

  const balances = Ledger.computeBalances(restored.squad, restored.expenses);
  assert.equal(balances.totalSpendPaise, 150000);
  assert.equal(balances.memberTotals['Anuj'].consumedPaise, 30000);
  assert.equal(balances.memberTotals['Priyasi'].consumedPaise, 45000);
  assert.equal(balances.memberTotals['Plaban'].consumedPaise, 75000);
  assert.equal(balances.memberTotals['Arkadeep'].paidPaise, 150000);
  assert.equal(balances.memberTotals['Arkadeep'].consumedPaise, 0);
  assert.equal(balances.memberTotals['Arkadeep'].netPaise, 150000);
});

// --- TEST 14: COMPLETE USER NARRATIVE WITH EXTENDED NATURAL PHRASING ---
test('Test 14: User narrative with "Anuj consumed ₹300 worth...", passive snacks, and relative clauses', () => {
  const narrative = `Six friends — Anuj, Priyasi, Plaban, Arkadeep, Rohan, and Sneha — went on a weekend trip to Digha.

Anuj paid ₹3,600 for the hotel, shared equally among all six friends except Sneha, who stayed with a relative and did not use the hotel.

Priyasi paid ₹1,200 for dinner, shared equally among Anuj, Priyasi, Plaban, and Arkadeep only. Rohan and Sneha did not participate in this dinner.

Plaban paid ₹900 for a cab shared equally by all six friends.

Arkadeep paid ₹1,500 for seafood. Anuj consumed ₹300 worth, Priyasi consumed ₹450 worth, and Plaban consumed ₹750 worth. The other three friends did not eat the seafood.

Rohan paid ₹600 for snacks. Half the snacks cost was consumed by Rohan and Sneha equally, and the remaining half was consumed by Anuj and Priyasi equally.

Sneha paid ₹1,200 for a boat ride shared equally by Anuj, Priyasi, Rohan, and Sneha. Plaban and Arkadeep did not take the boat ride.`;

  const expenses = Parser.parseStory(narrative, SQUAD_NAMES);
  assert.equal(expenses.length, 6, 'Must parse exactly 6 expenses');

  // Verify Seafood
  assert.equal(expenses[3].payer, 'Arkadeep');
  assert.equal(expenses[3].amountPaise, 150000);
  assert.equal(expenses[3].splitType, 'custom');
  assert.equal(expenses[3].allocations['Anuj'], 30000);
  assert.equal(expenses[3].allocations['Priyasi'], 45000);
  assert.equal(expenses[3].allocations['Plaban'], 75000);
  assert.deepEqual(expenses[3].excluded.sort(), ['Arkadeep', 'Rohan', 'Sneha'].sort());

  // Verify Snacks
  assert.equal(expenses[4].payer, 'Rohan');
  assert.equal(expenses[4].amountPaise, 60000);
  assert.equal(expenses[4].splitType, 'proportional');
  assert.equal(expenses[4].allocations['Rohan'], 15000);
  assert.equal(expenses[4].allocations['Sneha'], 15000);
  assert.equal(expenses[4].allocations['Anuj'], 15000);
  assert.equal(expenses[4].allocations['Priyasi'], 15000);
  assert.deepEqual(expenses[4].excluded.sort(), ['Arkadeep', 'Plaban'].sort());

  // Verify Balances
  const balances = Ledger.computeBalances(SQUAD_OBJECTS, expenses);
  assert.equal(balances.totalSpendPaise, 900000);
  assert.equal(balances.driftPaise, 0);

  const t = balances.memberTotals;
  assert.equal(t['Anuj'].netPaise, 168000);
  assert.equal(t['Priyasi'].netPaise, -87000);
  assert.equal(t['Plaban'].netPaise, -102000);
  assert.equal(t['Arkadeep'].netPaise, 33000);
  assert.equal(t['Rohan'].netPaise, -72000);
  assert.equal(t['Sneha'].netPaise, 60000);

  // Verify Transfers
  const solver = SettlementSolver.solve(t, SQUAD_OBJECTS);
  assert.equal(solver.transactions.length, 5);
  assert.equal(solver.optimal, true);
});

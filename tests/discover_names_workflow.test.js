const test = require('node:test');
const assert = require('node:assert/strict');
const { Parser, Ledger, SettlementSolver } = require('../engine.js');

test('discoverNames: Introductory pattern extracts all friends and ignores location/stopwords', () => {
  const story = 'Six friends — Anuj, Priyasi, Plaban, Arkadeep, Rohan, and Sneha — went on a weekend trip to Digha.';
  const names = Parser.discoverNames(story);

  assert.deepEqual(names, ['Anuj', 'Priyasi', 'Plaban', 'Arkadeep', 'Rohan', 'Sneha']);
  assert.ok(!names.includes('Digha'), 'Digha should not be treated as a participant');
  assert.ok(!names.includes('Six'), 'Six should not be treated as a participant');
  assert.ok(!names.includes('Friends'), 'Friends should not be treated as a participant');
});

test('discoverNames: Multi-clause dinner extracts distinct participants and filters foods/stopwords', () => {
  const story = "Plaban paid 1200 for lunch for all of us except Priyasi. Priyasi ate veg for 250 paid by Anuj. Arkadeep bought 2 water bottles for 40 for everyone. Later Plaban paid 300 for dessert for Arkadeep and Priyasi.";
  const names = Parser.discoverNames(story);

  assert.deepEqual([...names].sort(), ['Anuj', 'Arkadeep', 'Plaban', 'Priyasi'].sort());
  assert.ok(!names.includes('Of'), 'Of must not be detected as a person');
  assert.ok(!names.includes('Veg'), 'Veg must not be detected as a person');
  assert.ok(!names.includes('Bottles'), 'Bottles must not be detected as a person');
  assert.ok(!names.includes('Dessert'), 'Dessert must not be detected as a person');
  assert.ok(!names.includes('Lunch'), 'Lunch must not be detected as a person');
  assert.ok(!names.includes('Everyone'), 'Everyone must not be detected as a person');
});

test('discoverNames: Flatmates monthly expenses extracts roommates cleanly', () => {
  const story = 'Rohan paid 999 for Airtel broadband wifi for all three. Aman paid 450 for 20 litre water cans for the month. Vikram paid 650 for groceries.';
  const names = Parser.discoverNames(story);

  assert.deepEqual(names, ['Rohan', 'Aman', 'Vikram']);
  assert.ok(!names.includes('Airtel'), 'Airtel must not be detected as a person');
  assert.ok(!names.includes('Broadband'), 'Broadband must not be detected as a person');
  assert.ok(!names.includes('Wifi'), 'Wifi must not be detected as a person');
  assert.ok(!names.includes('Cans'), 'Cans must not be detected as a person');
  assert.ok(!names.includes('Groceries'), 'Groceries must not be detected as a person');
});

test('discoverNames: Repeated name mentions are properly deduplicated and title-cased', () => {
  const story = 'anuj paid 500 for lunch. Later Anuj paid 300 for cab. Priyasi and ANUJ shared 200.';
  const names = Parser.discoverNames(story);

  assert.deepEqual([...names].sort(), ['Anuj', 'Priyasi'].sort());
  assert.equal(names.filter(n => n.toLowerCase() === 'anuj').length, 1, 'Anuj must only appear once');
});

test('discoverNames: Safe edge cases return empty array without crashing', () => {
  assert.deepEqual(Parser.discoverNames(''), []);
  assert.deepEqual(Parser.discoverNames(null), []);
  assert.deepEqual(Parser.discoverNames(undefined), []);
  assert.deepEqual(Parser.discoverNames('Total bill was 500 paid in cash on Sunday.'), []);
});

test('Section 3 Spec: Pasting complete 6-person Digha story detects all 6 participants automatically', () => {
  const story = "Six of us went to Digha. Anuj paid ₹3,600 for the hotel, shared among Anuj, Priyasi, Plaban, Arkadeep and Rohan. Sneha paid ₹1,200 for the boat ride, shared among Anuj, Priyasi, Rohan and Sneha.";
  const names = Parser.discoverNames(story);

  assert.deepEqual([...names].sort(), ['Anuj', 'Arkadeep', 'Plaban', 'Priyasi', 'Rohan', 'Sneha'].sort());
  assert.ok(!names.includes('Digha'), 'Digha must not be a participant');
  assert.ok(!names.includes('Six'), 'Six must not be a participant');
  assert.ok(!names.includes('Hotel'), 'Hotel must not be a participant');
  assert.ok(!names.includes('Boat'), 'Boat must not be a participant');
  assert.ok(!names.includes('Ride'), 'Ride must not be a participant');
  assert.ok(!names.includes('Us'), 'Us must not be a participant');
});

test('Section 6 Spec: Ordinary nouns, places, and foods are never mistaken for people', () => {
  const story = "We went to Digha and ate seafood near the beach.";
  const names = Parser.discoverNames(story);
  assert.deepEqual(names, []);
});

test('Section 4 & 5 Spec: Manually added squad members are preserved across parsing cycles', () => {
  // Simulating squad state
  const squad = [
    { name: 'Kabir', upi: 'kabir@upi', source: 'manual' } // Manually added member not in story
  ];
  const story = "Anuj paid 500 for lunch with Priyasi.";
  const detected = Parser.discoverNames(story, squad.map(s => s.name));

  // Reconcile
  detected.forEach(name => {
    if (!squad.some(m => m.name.toLowerCase() === name.toLowerCase())) {
      squad.push({ name, upi: '', source: 'auto' });
    }
  });

  const names = squad.map(m => m.name);
  assert.ok(names.includes('Kabir'), 'Manually added Kabir must be preserved');
  assert.ok(names.includes('Anuj'), 'Auto-detected Anuj must be added');
  assert.ok(names.includes('Priyasi'), 'Auto-detected Priyasi must be added');
});

test('Section 5 Spec: Intentionally removed participant is not re-added on subsequent typing cycle', () => {
  const removedMembers = new Set(['rohan']);
  const squad = [
    { name: 'Anuj', upi: '' }
  ];
  const story = "Anuj paid 1000 for dinner. Rohan paid 200 for ice cream.";
  const detected = Parser.discoverNames(story);

  detected.forEach(name => {
    const lower = name.toLowerCase();
    if (removedMembers.has(lower)) return; // Skipped intentionally
    if (!squad.some(m => m.name.toLowerCase() === lower)) {
      squad.push({ name, upi: '' });
    }
  });

  const names = squad.map(m => m.name);
  assert.ok(names.includes('Anuj'));
  assert.ok(!names.includes('Rohan'), 'Rohan was intentionally removed and must not be re-added');
});

test('Section 2 Spec: Monotonic sequence prevents older asynchronous results from overwriting newer text', () => {
  let storySeq = 0;
  let activeSquad = ['Initial'];

  const triggerAsyncParsing = (text, seq) => {
    return new Promise(resolve => {
      // Simulate random network/computation latency
      const delay = seq === 1 ? 50 : 10;
      setTimeout(() => {
        if (seq < storySeq) {
          resolve({ ignored: true, seq });
          return;
        }
        activeSquad = Parser.discoverNames(text);
        resolve({ ignored: false, seq, squad: activeSquad });
      }, delay);
    });
  };

  // Launch Request 1 (seq 1 - takes longer)
  storySeq = 1;
  const p1 = triggerAsyncParsing('Anuj paid 500', 1);

  // User immediately types more, launching Request 2 (seq 2 - faster)
  storySeq = 2;
  const p2 = triggerAsyncParsing('Anuj paid 500. Priyasi paid 300', 2);

  return Promise.all([p1, p2]).then(([r1, r2]) => {
    assert.equal(r1.ignored, true, 'Older request 1 must be discarded');
    assert.equal(r2.ignored, false, 'Newer request 2 must be accepted');
    assert.deepEqual([...activeSquad].sort(), ['Anuj', 'Priyasi'].sort());
  });
});

test('Workflow Invariant: Auto-detected squad members separate membership from expense allocations', () => {
  const story = 'Anuj paid 1000 for dinner for all of us except Rohan. Rohan paid 200 for ice cream.';
  const detectedSquad = Parser.discoverNames(story);
  assert.deepEqual([...detectedSquad].sort(), ['Anuj', 'Rohan'].sort());

  // Squad registered
  const squad = detectedSquad.map(name => ({ name, upi: '' }));

  // Parse narrative into expenses
  const parsedExpenses = Parser.parseStory(story, detectedSquad);
  assert.equal(parsedExpenses.length, 2);

  // First expense excludes Rohan
  assert.equal(parsedExpenses[0].payer, 'Anuj');
  assert.ok(parsedExpenses[0].excluded.includes('Rohan'));

  // Ledger computes exact balances
  const balances = Ledger.computeBalances(squad, parsedExpenses);
  assert.equal(balances.driftPaise, 0);

  // Settlement resolves accurately:
  // Anuj paid 1000, consumed 1000 (dinner) + 100 (ice cream) = 1100 => Net: -100 (debtor)
  // Rohan paid 200, consumed 100 (ice cream) = 100 => Net: +100 (creditor)
  // Anuj owes Rohan 100 (10000 paise)
  const solution = SettlementSolver.solve(balances.memberTotals);
  assert.equal(solution.transactions.length, 1);
  assert.equal(solution.transactions[0].from, 'Anuj');
  assert.equal(solution.transactions[0].to, 'Rohan');
  assert.equal(solution.transactions[0].amountPaise, 10000); // ₹100
});

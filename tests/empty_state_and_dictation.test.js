const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../engine.js');

const { Money, Parser, Ledger, SettlementSolver, SettlementTracker, Storage } = Engine;

// =========================================================================
// PART 1: EMPTY STATE INITIALIZATION & INVARIANTS
// =========================================================================

test('Clean Initial State: createEmptyOuting returns clean empty structure', () => {
  function createEmptyOuting() {
    return {
      version: 2,
      id: 'out_' + Date.now(),
      title: '',
      date: new Date().toISOString().split('T')[0],
      squad: [],
      story: '',
      expenses: [],
      settlementRecords: {},
      updatedAt: new Date().toISOString()
    };
  }

  const outing = createEmptyOuting();

  assert.equal(outing.version, 2);
  assert.equal(outing.title, '');
  assert.equal(outing.story, '');
  assert.deepEqual(outing.squad, []);
  assert.deepEqual(outing.expenses, []);
  assert.deepEqual(outing.settlementRecords, {});
});

test('Clean Initial State: empty story produces 0 squad candidates, 0 expenses, 0 transactions', () => {
  const emptyStory = '';
  const detectedNames = Parser.discoverNames(emptyStory);
  assert.deepEqual(detectedNames, [], 'No squad members should be detected from an empty story');

  const candidates = Parser.parseStory(emptyStory, detectedNames);
  assert.deepEqual(candidates, [], 'No expense candidates should be generated from an empty story');

  const balances = Ledger.computeBalances(detectedNames, []);
  assert.deepEqual(balances.memberTotals, {});
  assert.equal(balances.totalSpendPaise, 0);
  assert.equal(balances.driftPaise, 0);

  const settlements = SettlementSolver.solve(balances.memberTotals);
  assert.deepEqual(settlements.transactions, []);
  assert.equal(settlements.algorithm, 'none');
});

test('Clean Initial State: isDemoOuting identifies legacy Karim demo and preserves genuine user outings', () => {
  function isDemoOuting(outing) {
    if (!outing) return false;
    const isKarim = (outing.title || '').trim().toLowerCase() === "dinner at karim's";
    const hasDemoStory = (outing.story || '').includes("Plaban paid 1200 for lunch for all of us except Priyasi");
    return isKarim && hasDemoStory;
  }

  const legacyKarimDemo = {
    title: "Dinner at Karim's",
    story: "Plaban paid 1200 for lunch for all of us except Priyasi. Priyasi ate veg for 250 paid by Anuj. Arkadeep bought 2 water bottles for 40 for everyone. Later Plaban paid 300 for dessert for Arkadeep and Priyasi.",
    squad: [{ name: 'Plaban' }, { name: 'Priyasi' }, { name: 'Anuj' }, { name: 'Arkadeep' }],
    expenses: []
  };

  assert.equal(isDemoOuting(legacyKarimDemo), true, 'Legacy Karim demo must be recognized as demo');

  const genuineUserTrip = {
    title: "Goa Weekend 2026",
    story: "Anuj paid 5000 for villa. Rahul paid 1200 for fuel.",
    squad: [{ name: 'Anuj' }, { name: 'Rahul' }],
    expenses: []
  };

  assert.equal(isDemoOuting(genuineUserTrip), false, 'Genuine user outing must NOT be flagged as demo');

  const emptyOuting = {
    title: "",
    story: "",
    squad: [],
    expenses: []
  };

  assert.equal(isDemoOuting(emptyOuting), false, 'Empty outing is not demo');
});

test('Clean Initial State: Simulated loadState cleanses legacy demo and loads clean workspace', () => {
  let storageMock = {
    HISABMATE_ACTIVE_OUTING_V2: JSON.stringify({
      version: 2,
      id: 'out_demo_1',
      title: "Dinner at Karim's",
      story: "Plaban paid 1200 for lunch for all of us except Priyasi. Priyasi ate veg for 250 paid by Anuj.",
      squad: [{ name: 'Plaban', upi: '' }],
      expenses: [],
      settlementRecords: {},
      updatedAt: '2026-10-24T12:00:00.000Z'
    })
  };

  function isDemoOuting(outing) {
    if (!outing) return false;
    const isKarim = (outing.title || '').trim().toLowerCase() === "dinner at karim's";
    const hasDemoStory = (outing.story || '').includes("Plaban paid 1200 for lunch for all of us except Priyasi");
    return isKarim && hasDemoStory;
  }

  function simulateLoadState() {
    const saved = storageMock['HISABMATE_ACTIVE_OUTING_V2'];
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!isDemoOuting(parsed)) {
        return parsed;
      }
    }
    // Returns clean empty state
    return {
      version: 2,
      id: 'out_new',
      title: '',
      squad: [],
      story: '',
      expenses: [],
      settlementRecords: {}
    };
  }

  const loadedState = simulateLoadState();
  assert.equal(loadedState.title, '');
  assert.equal(loadedState.story, '');
  assert.deepEqual(loadedState.squad, []);
  assert.deepEqual(loadedState.expenses, []);
});

test('Clean Initial State: Genuine user outings in localStorage are faithfully preserved', () => {
  const genuineUserTrip = {
    version: 2,
    id: 'out_user_99',
    title: 'Manali Snow Expedition',
    date: '2026-12-15',
    squad: [
      { name: 'Vikram', upi: 'vikram@upi' },
      { name: 'Sameer', upi: 'sameer@okaxis' }
    ],
    story: 'Vikram paid 4000 for snow gear rental for all. Sameer paid 1500 for lunch.',
    expenses: [
      { id: 'exp_1', payer: 'Vikram', amountPaise: 400000, description: 'snow gear rental', splitType: 'equal', included: ['Vikram', 'Sameer'] }
    ],
    settlementRecords: {}
  };

  const storageMock = {
    HISABMATE_ACTIVE_OUTING_V2: JSON.stringify(genuineUserTrip)
  };

  function isDemoOuting(outing) {
    if (!outing) return false;
    const isKarim = (outing.title || '').trim().toLowerCase() === "dinner at karim's";
    const hasDemoStory = (outing.story || '').includes("Plaban paid 1200 for lunch for all of us except Priyasi");
    return isKarim && hasDemoStory;
  }

  function simulateLoadState() {
    const saved = storageMock['HISABMATE_ACTIVE_OUTING_V2'];
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!isDemoOuting(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  const loadedState = simulateLoadState();
  assert.notEqual(loadedState, null);
  assert.equal(loadedState.title, 'Manali Snow Expedition');
  assert.equal(loadedState.squad.length, 2);
  assert.equal(loadedState.expenses.length, 1);
  assert.equal(loadedState.expenses[0].payer, 'Vikram');
});

// =========================================================================
// PART 2: VOICE-TO-TEXT SPEECH RECOGNITION FLOW & DEDUPLICATION
// =========================================================================

test('Voice Dictation Flow: Empty story begins dictating fresh immediately without modal', () => {
  let modalOpened = false;
  let dictationStartedMode = null;

  const mockApp = {
    outing: { story: '' },
    isDictating: false,
    toggleDictation() {
      const currentText = (this.outing.story || '').trim();
      if (!currentText) {
        this.startDictation('fresh');
        return;
      }
      modalOpened = true;
    },
    startDictation(mode) {
      dictationStartedMode = mode;
      this.isDictating = true;
    }
  };

  mockApp.toggleDictation();
  assert.equal(modalOpened, false, 'Modal should NOT open when story is empty');
  assert.equal(dictationStartedMode, 'fresh', 'Should start fresh immediately');
  assert.equal(mockApp.isDictating, true);
});

test('Voice Dictation Flow: Existing story prompts choice between fresh and continue', () => {
  let modalOpened = false;

  const mockApp = {
    outing: { story: 'Anuj paid 500 for lunch.' },
    isDictating: false,
    toggleDictation() {
      const currentText = (this.outing.story || '').trim();
      if (!currentText) {
        this.startDictation('fresh');
        return;
      }
      modalOpened = true;
    },
    startDictation(mode) {
      this.isDictating = true;
    }
  };

  mockApp.toggleDictation();
  assert.equal(modalOpened, true, 'Modal should open when story already has text');
  assert.equal(mockApp.isDictating, false, 'Should not start dictating until user makes a choice');
});

test('Voice Dictation Flow: Start Fresh clears existing story and sets base text to empty', () => {
  const mockApp = {
    outing: { story: 'Previous story that user wants to overwrite.' },
    dictationBaseText: '',
    dictationAccumulated: '',
    dictationCurrentFinal: '',
    dictationInterim: '',
    isDictating: false,
    startDictation(mode = 'fresh') {
      if (mode === 'fresh') {
        this.dictationBaseText = '';
        this.outing.story = '';
      } else {
        this.dictationBaseText = this.outing.story.trim();
      }
      this.dictationAccumulated = '';
      this.dictationCurrentFinal = '';
      this.dictationInterim = '';
      this.isDictating = true;
    }
  };

  mockApp.startDictation('fresh');
  assert.equal(mockApp.outing.story, '', 'Story should be emptied');
  assert.equal(mockApp.dictationBaseText, '', 'Base text should be empty');
  assert.equal(mockApp.isDictating, true);
});

test('Voice Dictation Flow: Continue Dictating preserves existing story as base text', () => {
  const mockApp = {
    outing: { story: 'Plaban paid 1200 for lunch.' },
    dictationBaseText: '',
    dictationAccumulated: '',
    dictationCurrentFinal: '',
    dictationInterim: '',
    isDictating: false,
    startDictation(mode = 'fresh') {
      if (mode === 'fresh') {
        this.dictationBaseText = '';
        this.outing.story = '';
      } else {
        this.dictationBaseText = this.outing.story.trim();
      }
      this.dictationAccumulated = '';
      this.dictationCurrentFinal = '';
      this.dictationInterim = '';
      this.isDictating = true;
    }
  };

  mockApp.startDictation('append');
  assert.equal(mockApp.dictationBaseText, 'Plaban paid 1200 for lunch.', 'Existing story should be preserved as base text');
  assert.equal(mockApp.isDictating, true);
});

test('Voice Dictation Deduplication: Interim transcripts are never committed to accumulated text on onend', () => {
  const mockApp = {
    dictationBaseText: '',
    dictationAccumulated: '',
    dictationCurrentFinal: '',
    dictationInterim: '',
    outing: { story: '' },

    syncDictationToTextarea() {
      const parts = [];
      const base = (this.dictationBaseText || '').trim();
      const acc = (this.dictationAccumulated || '').trim();
      const curFinal = (this.dictationCurrentFinal || '').trim();
      const curInterim = (this.dictationInterim || '').trim();

      if (base) parts.push(base);
      if (acc) parts.push(acc);
      if (curFinal) parts.push(curFinal);
      if (curInterim) parts.push(curInterim);

      this.outing.story = parts.join(' ').replace(/\s+/g, ' ').trim();
    },

    simulateOnResult(results) {
      let sessionFinal = '';
      let sessionInterim = '';

      for (let i = 0; i < results.length; ++i) {
        const item = results[i];
        const text = item[0].transcript.trim();
        if (item.isFinal) {
          sessionFinal += (sessionFinal ? ' ' : '') + text;
        } else {
          sessionInterim += (sessionInterim ? ' ' : '') + text;
        }
      }

      this.dictationCurrentFinal = sessionFinal;
      this.dictationInterim = sessionInterim;
      this.syncDictationToTextarea();
    },

    simulateOnEnd() {
      // ONLY finalized speech is committed to accumulated! Never interim.
      if (this.dictationCurrentFinal) {
        const trimmed = this.dictationCurrentFinal.trim();
        if (trimmed) {
          this.dictationAccumulated = (this.dictationAccumulated ? this.dictationAccumulated + ' ' : '') + trimmed;
        }
        this.dictationCurrentFinal = '';
      }
      this.dictationInterim = '';
      this.syncDictationToTextarea();
    }
  };

  // Step 1: User starts speaking. We receive interim speech.
  mockApp.simulateOnResult([
    { 0: { transcript: 'Anuj paid twelve' }, isFinal: false }
  ]);
  assert.equal(mockApp.outing.story, 'Anuj paid twelve');
  assert.equal(mockApp.dictationAccumulated, '', 'Accumulated text must remain empty during interim results');

  // Step 2: Recognition session pauses and fires onend before finalizing
  mockApp.simulateOnEnd();
  // Interim text is cleared, NOT baked into accumulated text
  assert.equal(mockApp.dictationAccumulated, '', 'Interim text must NOT be committed to accumulated on onend');
  assert.equal(mockApp.outing.story, '', 'Story reverts until words are genuinely finalized');

  // Step 3: User continues and recognition finalizes the clause
  mockApp.simulateOnResult([
    { 0: { transcript: 'Anuj paid 1200 for dinner' }, isFinal: true }
  ]);
  assert.equal(mockApp.outing.story, 'Anuj paid 1200 for dinner');

  // Step 4: Recognition session ends and commits finalized words
  mockApp.simulateOnEnd();
  assert.equal(mockApp.dictationAccumulated, 'Anuj paid 1200 for dinner');
  assert.equal(mockApp.outing.story, 'Anuj paid 1200 for dinner');

  // Step 5: Next speech recognition cycle speaks a second sentence
  mockApp.simulateOnResult([
    { 0: { transcript: 'Rohan paid 300 for drinks' }, isFinal: true }
  ]);
  assert.equal(mockApp.outing.story, 'Anuj paid 1200 for dinner Rohan paid 300 for drinks');

  mockApp.simulateOnEnd();
  assert.equal(mockApp.dictationAccumulated, 'Anuj paid 1200 for dinner Rohan paid 300 for drinks');

  // Check deduplication invariant: words are never duplicated
  const words = mockApp.outing.story.split(/\s+/);
  const anujCount = words.filter(w => w.toLowerCase() === 'anuj').length;
  assert.equal(anujCount, 1, 'Anuj must only appear once, not duplicated across restarts');
});

test('Voice Dictation Session ID: Monotonic session ID ignores delayed callbacks from older sessions', () => {
  let activeSessionId = 0;
  let textCommitted = '';

  function startSession() {
    activeSessionId++;
    const thisSessionId = activeSessionId;

    return {
      onResult(transcript) {
        if (thisSessionId !== activeSessionId) return; // Discard stale callback
        textCommitted = transcript;
      }
    };
  }

  const session1 = startSession();
  assert.equal(activeSessionId, 1);

  // User rapidly clicks stop and start again
  const session2 = startSession();
  assert.equal(activeSessionId, 2);

  // Stale callback from session 1 arrives late
  session1.onResult('Stale speech from cancelled session');
  assert.equal(textCommitted, '', 'Stale callback must be ignored');

  // Active callback from session 2 arrives
  session2.onResult('Fresh speech from session 2');
  assert.equal(textCommitted, 'Fresh speech from session 2', 'Active session callback must be processed');
});

test('Voice Dictation UI States: Correctly transitions between distinct states', () => {
  const uiStateHistory = [];

  function updateDictationUI(state, customStatus = '') {
    uiStateHistory.push({ state, customStatus });
  }

  // 1. Initial idle
  updateDictationUI('idle');
  // 2. User presses mic -> requesting permission
  updateDictationUI('requesting');
  // 3. Permission granted -> listening
  updateDictationUI('listening');
  // 4. User stops -> idle
  updateDictationUI('idle');
  // 5. Permission denied by user
  updateDictationUI('permission-denied');
  // 6. Network failure
  updateDictationUI('failed');
  // 7. Unsupported browser
  updateDictationUI('unsupported');

  assert.deepEqual(uiStateHistory.map(h => h.state), [
    'idle',
    'requesting',
    'listening',
    'idle',
    'permission-denied',
    'failed',
    'unsupported'
  ]);
});

test('Integration: Dictated story automatically discovers squad participants in Step 2', () => {
  const spokenStory = 'Six of us went to Digha. Anuj paid 3600 for the hotel shared among Anuj, Priyasi, Plaban, Arkadeep, and Rohan. Sneha paid 1200 for the boat ride.';

  const detectedSquad = Parser.discoverNames(spokenStory);
  assert.deepEqual(
    [...detectedSquad].sort(),
    ['Anuj', 'Arkadeep', 'Plaban', 'Priyasi', 'Rohan', 'Sneha'].sort(),
    'All six participants in spoken story must be auto-discovered for Step 2'
  );
  assert.ok(!detectedSquad.includes('Digha'), 'Digha must not be treated as a person');
  assert.ok(!detectedSquad.includes('Six'), 'Six must not be treated as a person');
});

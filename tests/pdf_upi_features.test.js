const test = require('node:test');
const assert = require('node:assert/strict');
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default;

const Engine = require('../engine.js');
const { Money, Ledger, SettlementSolver, UPI, PdfGenerator } = Engine;

// =========================================================================
// PART 1: UPI DEEP LINK & PAYMENT INTENT TESTS
// =========================================================================

test('UPI.validateUpiId accepts valid VPAs and rejects invalid formats', () => {
  // Valid VPAs
  assert.equal(UPI.validateUpiId('anuj@okaxis').valid, true);
  assert.equal(UPI.validateUpiId('priyasi.98@okhdfcbank').valid, true);
  assert.equal(UPI.validateUpiId('9876543210@paytm').valid, true);
  assert.equal(UPI.validateUpiId('user_name-1@ybl').valid, true);

  // Invalid VPAs
  assert.equal(UPI.validateUpiId('').valid, false);
  assert.equal(UPI.validateUpiId('   ').valid, false);
  assert.equal(UPI.validateUpiId(null).valid, false);
  assert.equal(UPI.validateUpiId(undefined).valid, false);
  assert.equal(UPI.validateUpiId('no-at-symbol').valid, false);
  assert.equal(UPI.validateUpiId('@onlybank').valid, false);
  assert.equal(UPI.validateUpiId('user@').valid, false);
  assert.equal(UPI.validateUpiId('user@bank@extra').valid, false);
});

test('UPI.formatAmount validates positive amounts and formats to 2 decimal places', () => {
  assert.equal(UPI.formatAmount(450), '450.00');
  assert.equal(UPI.formatAmount('1200.5'), '1200.50');
  assert.equal(UPI.formatAmount(0.99), '0.99');
  assert.equal(UPI.formatAmount('1500.00'), '1500.00');

  // Rejects zero, negative, NaN
  assert.throws(() => UPI.formatAmount(0), /positive number greater than 0/);
  assert.throws(() => UPI.formatAmount(-150), /positive number greater than 0/);
  assert.throws(() => UPI.formatAmount(NaN), /positive number greater than 0/);
  assert.throws(() => UPI.formatAmount('invalid'), /positive number greater than 0/);
});

test('UPI.buildPaymentUri builds valid upi://pay URI with standard parameters and URL-encoding', () => {
  const uri = UPI.buildPaymentUri({
    payeeVpa: 'priyasi@oksbi',
    payeeName: 'Priyasi Roy',
    amountRupees: '450.00',
    outingTitle: 'Digha Weekend Trip'
  });

  assert.ok(uri.startsWith('upi://pay?'), 'Must start with upi://pay?');
  assert.ok(uri.includes('pa=priyasi%40oksbi'), 'VPA must be URL-encoded');
  assert.ok(uri.includes('pn=Priyasi%20Roy'), 'Payee Name must be URL-encoded');
  assert.ok(uri.includes('am=450.00'), 'Amount must be formatted as 450.00');
  assert.ok(uri.includes('cu=INR'), 'Currency must be INR');
  assert.ok(uri.includes('tn=HisabMate%3A%20Digha%20Weekend%20Trip'), 'Note must be URL-encoded');
});

test('UPI.getTransferPaymentInfo respects authoritative settlement direction (debtor pays creditor)', () => {
  const squad = [
    { name: 'Anuj', upi: 'anuj@okaxis' },
    { name: 'Sneha', upi: 'sneha@okhdfcbank' }
  ];

  // Anuj owes Sneha ₹600 (Anuj is debtor, Sneha is creditor)
  const transfer = {
    id: 'tx_Anuj_Sneha_60000',
    from: 'Anuj',
    to: 'Sneha',
    amountRupees: '600.00',
    amountPaise: 60000,
    creditorUpi: 'sneha@okhdfcbank'
  };

  const paymentInfo = UPI.getTransferPaymentInfo(transfer, squad, 'Digha Trip');

  assert.equal(paymentInfo.canPay, true);
  assert.equal(paymentInfo.payerName, 'Anuj', 'Payer must be debtor');
  assert.equal(paymentInfo.payeeName, 'Sneha', 'Payee must be creditor');
  assert.equal(paymentInfo.payeeVpa, 'sneha@okhdfcbank', 'Must use creditor UPI ID');
  assert.ok(paymentInfo.uri.includes('pa=sneha%40okhdfcbank'), 'URI must point to creditor');
  assert.ok(!paymentInfo.uri.includes('anuj'), 'Debtor UPI ID must NEVER be the payee address');
});

test('UPI.getTransferPaymentInfo handles missing recipient UPI gracefully with actionable warning', () => {
  const squad = [
    { name: 'Anuj', upi: 'anuj@okaxis' },
    { name: 'Rohan' } // Rohan has no UPI ID configured
  ];

  const transfer = {
    from: 'Anuj',
    to: 'Rohan',
    amountRupees: '150.00',
    amountPaise: 15000,
    creditorUpi: ''
  };

  const paymentInfo = UPI.getTransferPaymentInfo(transfer, squad, 'Goa');

  assert.equal(paymentInfo.canPay, false);
  assert.equal(paymentInfo.uri, '');
  assert.ok(paymentInfo.validationError.includes('Rohan does not have a configured UPI ID'));
});

test('Opening or copying a payment URI does not alter balances or mark payments as settled', () => {
  const squad = [
    { name: 'Anuj', upi: 'anuj@okaxis' },
    { name: 'Priyasi', upi: 'priyasi@oksbi' }
  ];
  const expenses = [
    { id: 'e1', payer: 'Priyasi', amountPaise: 100000, description: 'Lunch', included: ['Anuj', 'Priyasi'] }
  ];

  const balanceBefore = Ledger.computeBalances(squad, expenses);
  const planBefore = SettlementSolver.solve(balanceBefore.memberTotals);

  // Generate URI
  const info = UPI.getTransferPaymentInfo(planBefore.transactions[0], squad, 'Lunch');
  assert.ok(info.uri);

  // Invariant check: ledger balances and transactions remain 100% unchanged
  const balanceAfter = Ledger.computeBalances(squad, expenses);
  assert.deepEqual(balanceBefore, balanceAfter, 'Ledger state must be immutable on payment initiation');
  assert.equal(balanceAfter.memberTotals.Anuj.netPaise, -50000);
  assert.equal(balanceAfter.memberTotals.Priyasi.netPaise, 50000);
});

// =========================================================================
// PART 2: PDF BILL DATA & DOCUMENT GENERATION TESTS
// =========================================================================

test('PdfGenerator.formatFilename sanitizes outing title, spaces, and invalid characters', () => {
  assert.equal(
    PdfGenerator.formatFilename('Digha Trip', '2026-10-24'),
    'HisabMate_Digha_Trip_2026-10-24.pdf'
  );
  assert.equal(
    PdfGenerator.formatFilename('Goa: Beach & Fun / 2026!', '2026-10-24'),
    'HisabMate_Goa_Beach_Fun_2026_2026-10-24.pdf'
  );
  assert.equal(
    PdfGenerator.formatFilename('', '2026-10-24'),
    'HisabMate_Outing_2026-10-24.pdf'
  );
});

test('PdfGenerator.preparePdfData preserves custom allocations and exclusions for Digha Master Narrative', () => {
  const squad = [
    { name: 'Anuj', upi: 'anuj@okaxis' },
    { name: 'Priyasi', upi: 'priyasi@oksbi' },
    { name: 'Plaban', upi: 'plaban@icici' },
    { name: 'Arkadeep', upi: 'arkadeep@paytm' },
    { name: 'Rohan', upi: 'rohan@ybl' },
    { name: 'Sneha', upi: 'sneha@oksbi' }
  ];

  const expenses = [
    { id: '1', payer: 'Anuj', amountPaise: 360000, description: 'Hotel stay', included: ['Anuj', 'Priyasi', 'Plaban', 'Arkadeep', 'Rohan'] },
    { id: '2', payer: 'Priyasi', amountPaise: 120000, description: 'Dinner', included: ['Anuj', 'Priyasi', 'Plaban', 'Arkadeep'] },
    { id: '3', payer: 'Plaban', amountPaise: 90000, description: 'Cab ride', included: ['Anuj', 'Priyasi', 'Plaban', 'Arkadeep', 'Rohan', 'Sneha'] },
    { id: '4', payer: 'Arkadeep', amountPaise: 150000, description: 'Seafood lunch', included: ['Anuj', 'Priyasi', 'Plaban'], allocations: { Anuj: 30000, Priyasi: 45000, Plaban: 75000 } },
    { id: '5', payer: 'Rohan', amountPaise: 60000, description: 'Evening snacks', included: ['Rohan', 'Sneha', 'Anuj', 'Priyasi'], allocations: { Rohan: 15000, Sneha: 15000, Anuj: 15000, Priyasi: 15000 } },
    { id: '6', payer: 'Sneha', amountPaise: 120000, description: 'Boat ride', included: ['Anuj', 'Priyasi', 'Rohan', 'Sneha'] }
  ];

  const outing = {
    title: 'Digha Trip',
    date: '2026-10-24',
    squad,
    expenses
  };

  const balanceResult = Ledger.computeBalances(squad, expenses);
  const settlementPlan = SettlementSolver.solve(balanceResult.memberTotals);

  const pdfData = PdfGenerator.preparePdfData(outing, settlementPlan);

  // Header & summary checks
  assert.equal(pdfData.title, 'Digha Trip');
  assert.equal(pdfData.participantCount, 6);
  assert.equal(pdfData.expenseCount, 6);
  assert.equal(pdfData.totalSpendPaise, 900000);
  assert.equal(pdfData.totalSpendRupees, '₹9,000.00');

  // Check Seafood explicit allocations preserved
  const seafoodRow = pdfData.expenseRows.find(e => e.description.includes('Seafood'));
  assert.ok(seafoodRow, 'Seafood row must exist in PDF expense data');
  assert.ok(seafoodRow.splitDetails.includes('Anuj: ₹300.00'), 'Seafood must preserve Anuj ₹300.00');
  assert.ok(seafoodRow.splitDetails.includes('Priyasi: ₹450.00'), 'Seafood must preserve Priyasi ₹450.00');
  assert.ok(seafoodRow.splitDetails.includes('Plaban: ₹750.00'), 'Seafood must preserve Plaban ₹750.00');
  assert.ok(seafoodRow.splitDetails.includes('Excluded: Arkadeep, Rohan, Sneha'), 'Seafood must list excluded members');

  // Check Snacks allocations preserved
  const snacksRow = pdfData.expenseRows.find(e => e.description.includes('snacks'));
  assert.ok(snacksRow, 'Snacks row must exist in PDF expense data');
  assert.ok(snacksRow.splitDetails.includes('₹150.00'), 'Snacks must preserve ₹150.00 share');

  // Check Exclusions preserved on Hotel
  const hotelRow = pdfData.expenseRows.find(e => e.description.includes('Hotel'));
  assert.ok(hotelRow.splitDetails.includes('Excluded: Sneha'), 'Sneha must be excluded from hotel in PDF');

  // Financial Invariants
  assert.equal(pdfData.isConservationValid, true, 'Sum(Paid) === Sum(Consumed) === TotalSpend');
  assert.equal(pdfData.isZeroDriftValid, true, 'Sum(Net) === 0 paise');
  assert.equal(pdfData.isReconciled, true, 'Bill status must be reconciled');
});

test('PdfGenerator.buildPdfDocument generates valid multi-page PDF with exact footer branding', () => {
  const squad = [
    { name: 'Anuj', upi: 'anuj@okaxis' },
    { name: 'Priyasi', upi: 'priyasi@oksbi' }
  ];
  const expenses = [
    { id: '1', payer: 'Anuj', amountPaise: 50000, description: 'Breakfast', included: ['Anuj', 'Priyasi'] }
  ];

  const outing = {
    title: 'Quick Brunch',
    date: '2026-10-24',
    squad,
    expenses
  };

  const balanceResult = Ledger.computeBalances(squad, expenses);
  const settlementPlan = SettlementSolver.solve(balanceResult.memberTotals);

  const doc = PdfGenerator.buildPdfDocument(outing, settlementPlan, jsPDF, autoTable);

  assert.ok(doc, 'PDF doc must be generated');
  const pages = doc.internal.getNumberOfPages();
  assert.ok(pages >= 1, 'Must have at least 1 page');

  // Check text content in generated document
  const pdfOutput = doc.output();
  assert.ok(pdfOutput.length > 1000, 'PDF buffer must contain content');

  // Verify exact footer branding requirements
  assert.ok(
    pdfOutput.includes('HisabMate') && pdfOutput.includes('Hisab sorted, dosti intact'),
    'PDF must contain exact brand signature on left footer'
  );
  assert.ok(
    pdfOutput.includes('Made with love for Indian outings.'),
    'PDF must contain exact text "Made with love for Indian outings." with period on right footer'
  );
});

test('PdfGenerator handles large multi-page outing (60 expenses) with automatic continuation and pagination', () => {
  const squad = [
    { name: 'Anuj', upi: 'anuj@okaxis' },
    { name: 'Priyasi', upi: 'priyasi@oksbi' },
    { name: 'Plaban', upi: 'plaban@icici' }
  ];

  const expenses = [];
  for (let i = 1; i <= 60; i++) {
    expenses.push({
      id: `exp_${i}`,
      payer: squad[(i - 1) % 3].name,
      amountPaise: 10000 * i,
      description: `Travel Expense #${i}`,
      included: ['Anuj', 'Priyasi', 'Plaban']
    });
  }

  const outing = {
    title: 'Epic Cross-Country Tour',
    date: '2026-10-24',
    squad,
    expenses
  };

  const balanceResult = Ledger.computeBalances(squad, expenses);
  const settlementPlan = SettlementSolver.solve(balanceResult.memberTotals);

  const doc = PdfGenerator.buildPdfDocument(outing, settlementPlan, jsPDF, autoTable);
  const pageCount = doc.internal.getNumberOfPages();

  assert.ok(pageCount >= 2, `60 expenses must span across multiple pages (generated ${pageCount} pages)`);
});

test('PdfGenerator handles edge cases: zero expenses, missing date, missing title, single participant', () => {
  // Case 1: Outing with zero expenses
  const emptyOuting = {
    title: '',
    date: '',
    squad: [{ name: 'Anuj' }, { name: 'Priyasi' }],
    expenses: []
  };

  const res1 = Ledger.computeBalances(emptyOuting.squad, emptyOuting.expenses);
  const plan1 = SettlementSolver.solve(res1.memberTotals);
  const doc1 = PdfGenerator.buildPdfDocument(emptyOuting, plan1, jsPDF, autoTable);
  assert.equal(doc1.internal.getNumberOfPages(), 1, 'Empty outing renders 1 page');

  // Case 2: Single participant outing
  const soloOuting = {
    title: 'Solo Coffee',
    date: '2026-10-24',
    squad: [{ name: 'Anuj' }],
    expenses: [{ id: 's1', payer: 'Anuj', amountPaise: 25000, description: 'Coffee', included: ['Anuj'] }]
  };
  const res2 = Ledger.computeBalances(soloOuting.squad, soloOuting.expenses);
  const plan2 = SettlementSolver.solve(res2.memberTotals);
  const doc2 = PdfGenerator.buildPdfDocument(soloOuting, plan2, jsPDF, autoTable);
  assert.equal(doc2.internal.getNumberOfPages(), 1);
  assert.equal(plan2.transactions.length, 0, 'Zero self-transfers required');
});

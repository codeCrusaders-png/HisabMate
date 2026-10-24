/**
 * HisabMate Core Financial & Parsing Engine (v2.0)
 * 
 * Zero-drift paise-accurate ledger, NLP narrative parser,
 * exact subset-partition & greedy cash-flow settlement solvers,
 * self-reported settlement tracking, and robust schema validation.
 * 
 * Works isomorphically in Node.js (for automated test suites)
 * and in modern browsers (via window.HisabMateEngine).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HisabMateEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // =========================================================================
  // 1. CURRENCY & INTEGER-PAISE MATH
  // =========================================================================
  const Money = {
    /**
     * Converts a rupee value (number or string) to integer paise.
     * Guards against floating-point drift (e.g. 19.99 * 100 = 1998.9999999999998).
     */
    toPaise(val) {
      if (val === null || val === undefined || val === '') return 0;
      if (typeof val === 'number') {
        if (!Number.isFinite(val) || Number.isNaN(val) || val <= 0) return 0;
        return Math.round(val * 100);
      }
      if (typeof val === 'string') {
        const cleaned = val.replace(/,/g, '').trim();
        const num = parseFloat(cleaned);
        if (!Number.isFinite(num) || Number.isNaN(num) || num <= 0) return 0;
        return Math.round(num * 100);
      }
      return 0;
    },

    /**
     * Converts integer paise to a float rupee value.
     */
    toRupees(paise) {
      if (!Number.isFinite(paise) || Number.isNaN(paise)) return 0;
      return paise / 100;
    },

    /**
     * Formats integer paise or rupees into standard Indian Rupee notation (en-IN).
     * Example: 120000 paise -> "₹1,200.00"
     */
    formatINR(paise, includeSymbol = true) {
      const p = Math.round(paise || 0);
      const rupees = p / 100;
      const formatted = rupees.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      return includeSymbol ? `₹${formatted}` : formatted;
    },

    /**
     * Strict amount validator: rejects negative numbers, NaN, Infinity.
     */
    isValidAmount(paise) {
      return Number.isSafeInteger(paise) && paise >= 0;
    }
  };

  // =========================================================================
  // 2. NATURAL LANGUAGE EXPENSE PARSER
  // =========================================================================
  const Parser = {
    /**
     * Common Indian item/quantity words that should NOT be mistaken for prices.
     */
    QUANTITY_STOPWORDS: [
      'water bottles?', 'bottles?', 'plates?', 'beers?', 'cups?', 'cabs?', 'ubers?',
      'tickets?', 'people', 'persons?', 'items?', 'litres?', 'ltr', 'cans?',
      'pieces?', 'pcs?', 'naans?', 'rotis?', 'thalis?', 'chai', 'coffees?',
      'rooms?', 'passes?', 'tolls?'
    ],

    /**
     * Splits a multi-sentence narrative story into discrete expense clauses.
     * Handles newlines, periods, semicolons, and compound conjunctions like "and Arka paid...".
     */
    splitStoryIntoClauses(storyText, squadNames = []) {
      if (!storyText || typeof storyText !== 'string') return [];
      let text = storyText.replace(/\r\n/g, '\n').trim();
      if (!text) return [];

      // If squad members are known, split compound conjunctions e.g. "and Arka paid..."
      if (squadNames.length > 0) {
        const escapedNames = squadNames
          .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|');
        const compoundRegex = new RegExp(
          `\\s+(?:and|while|then|plus)\\s+(?=(?:${escapedNames})\\s+(?:paid|spent|bought|covered|gave|chipped|ordered|transferred))`,
          'gi'
        );
        text = text.replace(compoundRegex, '. ');
      }

      return text
        .split(/\n+|\.(?:\s+|$)|;+|!+(?:\s+|$)/g)
        .map(s => s.trim())
        .filter(s => s.length > 2);
    },

    /**
     * Parses a single sentence/clause into a structured expense representation.
     */
    parseClause(clause, squadNames = []) {
      const squadLowerMap = {};
      squadNames.forEach(n => {
        squadLowerMap[n.toLowerCase()] = n;
      });

      const warnings = [];

      // 1. Identify Payer
      let payer = null;

      // Pattern A: "paid by <Name>", "bought by <Name>", "covered by <Name>", etc.
      const paidByMatch = clause.match(/(?:paid|bought|spent|covered|given|handled|chipped\s*in)\s+by\s+([A-Za-z0-9_]+)/i);
      if (paidByMatch && squadLowerMap[paidByMatch[1].toLowerCase()]) {
        payer = squadLowerMap[paidByMatch[1].toLowerCase()];
      }

      // Pattern B: "<Name> paid/spent/bought/covered..."
      if (!payer) {
        for (const name of squadNames) {
          const regex = new RegExp(`\\b${name}\\b\\s+(?:paid|spent|bought|covered|gave|chipped\\s*in|transferred|ordered|handled)`, 'i');
          if (regex.test(clause)) {
            payer = name;
            break;
          }
        }
      }

      // Pattern C: Sentence starts with <Name>
      if (!payer) {
        for (const name of squadNames) {
          const regex = new RegExp(`^${name}\\b`, 'i');
          if (regex.test(clause) && !/(?:paid|bought|spent|covered)\s+by/i.test(clause)) {
            payer = name;
            break;
          }
        }
      }

      if (!payer) {
        warnings.push('Payer could not be determined automatically.');
      }

      // 2. Identify Amount (with quantity disambiguation)
      const amountRegex = /(?:₹|rs\.?|inr)?\s*(\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b)\s*(?:₹|rs\.?|inr|bucks|rupees)?/gi;
      let match;
      const candidates = [];

      while ((match = amountRegex.exec(clause)) !== null) {
        const fullMatch = match[0].trim();
        const numStr = match[1].replace(/,/g, '');
        const numVal = parseFloat(numStr);
        if (isNaN(numVal) || numVal <= 0) continue;

        const matchIndex = match.index;
        const prevContext = clause.slice(Math.max(0, matchIndex - 20), matchIndex).toLowerCase();
        const nextContext = clause.slice(matchIndex + fullMatch.length, matchIndex + fullMatch.length + 24).toLowerCase();

        let score = 0;
        // Strong bonus for currency mark
        if (/[₹]|rs|inr|bucks|rupees/i.test(fullMatch)) score += 55;
        // Bonus for price-indicating context
        if (/(?:for|paid|spent|cost|worth|bill\s+of|bill\s+was|amounting\s+to|amount\s+of|totaling|total\s+of|of)\s*$/i.test(prevContext)) {
          score += 40;
        }

        // Heavy penalty for quantity tokens (e.g., "2 water bottles", "4 plates")
        const quantityPattern = new RegExp(`^\\s*(?:${Parser.QUANTITY_STOPWORDS.join('|')})`, 'i');
        if (quantityPattern.test(nextContext)) {
          score -= 80;
        }

        if (numVal >= 10) score += 5;
        if (numVal >= 100) score += 10;

        candidates.push({ val: numVal, score, numStr, fullMatch });
      }

      candidates.sort((a, b) => b.score - a.score);
      const amountRupees = candidates.length > 0 && candidates[0].score >= 0 ? candidates[0].val : 0;
      const amountPaise = Math.round(amountRupees * 100);

      if (amountPaise <= 0) {
        warnings.push('Expense amount could not be determined.');
      }

      // 3. Identify Exclusions: "except Priyasi", "without Anuj", "excluding Ritesh"
      const excluded = [];
      const exclusionMatch = clause.match(/(?:except|without|excluding|minus|leaving\s+out|not\s+including)\s+([^.,;!]+)/i);
      let exclClause = '';
      if (exclusionMatch) {
        exclClause = exclusionMatch[1];
        squadNames.forEach(name => {
          if (new RegExp(`\\b${name}\\b`, 'i').test(exclClause)) {
            if (!excluded.includes(name)) excluded.push(name);
          }
        });
      }

      // 4. Identify Inclusions / Beneficiaries
      let included = [];
      const clauseWithoutExclusion = exclusionMatch
        ? clause.slice(0, exclusionMatch.index) + ' ' + clause.slice(exclusionMatch.index + exclusionMatch[0].length)
        : clause;

      const isForAll = /(?:for\s+all(?:\s+of\s+us)?|for\s+everyone|for\s+everybody|for\s+the\s+group|shared\s+by\s+everyone|shared\s+by\s+all|split\s+between\s+all|for\s+whole\s+squad|for\s+us\s+all|for\s+all\s+three|for\s+all\s+\d+|among\s+all(?:\s+\w+)?\s+members?|for\s+all(?:\s+\w+)?\s+members?|shared\s+equally\s+among\s+all(?:\s+\w+)?\s+members?)/i.test(clauseWithoutExclusion);

      if (isForAll) {
        included = squadNames.filter(n => !excluded.includes(n));
      } else {
        const forMatch = clauseWithoutExclusion.match(/(?:for|between|split\s+between|split\s+by|shared\s+by|shared\s+equally\s+among|among)\s+([^.]+)/i);
        let foundSpecific = false;

        if (forMatch) {
          const forClause = forMatch[1];
          squadNames.forEach(name => {
            if (new RegExp(`\\b${name}\\b`, 'i').test(forClause)) {
              if (!included.includes(name) && !excluded.includes(name)) {
                included.push(name);
                foundSpecific = true;
              }
            }
          });

          // Reflexive pronouns (e.g. "for himself and Plaban")
          if (payer && /(?:himself|herself|themself|myself)/i.test(forClause)) {
            if (!included.includes(payer) && !excluded.includes(payer)) {
              included.push(payer);
              foundSpecific = true;
            }
          }
        }

        // If no explicit inclusion list was found, default to everyone minus excluded members
        if (!foundSpecific) {
          included = squadNames.filter(n => !excluded.includes(n));
        }
      }

      if (included.length === 0) {
        warnings.push('No participants included for this expense.');
      }

      // 5. Clean Description Extraction
      let desc = clause;
      if (payer) {
        desc = desc.replace(new RegExp(`(?:paid|bought|spent|covered)\\s+by\\s+${payer}`, 'gi'), '');
        desc = desc.replace(new RegExp(`\\b${payer}\\b\\s+(?:paid|spent|bought|covered|gave|chipped\\s*in|transferred|ordered)?`, 'gi'), '');
      }
      desc = desc.replace(/(?:₹|rs\.?|inr)?\s*[0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?\s*(?:₹|rs\.?|inr|bucks|rupees)?/gi, '');
      desc = desc.replace(/(?:except|without|excluding|minus|leaving\s+out|not\s+including)\s+[^.,;!]+/gi, '');
      desc = desc.replace(/(?:for|between|split\s+between|split\s+by|shared\s+by|among)\s+(?:all(?:\s+of\s+us)?|everyone|everybody|the\s+group|all\s+the\s+squad|whole\s+squad|all\s+three|all\s+\d+)/gi, '');
      desc = desc.replace(/^\s*(?:for|and|then|also|on|ate|had|bought|shared\s+equally\s+by)\s+/gi, '')
                 .replace(/\s+(?:for|and|by)\s*$/gi, '')
                 .replace(/\s+/g, ' ')
                 .trim();

      if (!desc || desc.length < 2) desc = 'Expense';
      desc = desc.charAt(0).toUpperCase() + desc.slice(1);

      return {
        raw: clause,
        description: desc,
        payer: payer || 'Unresolved',
        amountRupees,
        amountPaise,
        included,
        excluded,
        warnings,
        confidence: warnings.length === 0 ? 'high' : 'low'
      };
    },

    /**
     * Parses a complete narrative story and returns structured candidate expenses.
     * Binds standalone exclusion clauses (e.g. "Priyasi is excluded.") to the preceding expense.
     */
    parseStory(storyText, squadNames = []) {
      const clauses = this.splitStoryIntoClauses(storyText, squadNames);
      const expenses = [];

      const standaloneExclusionPattern = /^(?:([^.,;!]+)\s+(?:is|was|were|are)\s+(?:excluded|not\s+included|left\s+out|omitted)|(?:excluding|except|without|leaving\s+out|not\s+including)\s+([^.,;!]+)|([^.,;!]+)\s+did\s+not\s+(?:have|eat|drink|join|partake|participate|share|take|come))/i;

      clauses.forEach((clause) => {
        // Check if this clause is a standalone exclusion annotation for the preceding expense
        const exclMatch = clause.match(standaloneExclusionPattern);
        if (exclMatch && expenses.length > 0) {
          const hasAmount = /(?:₹|rs\.?|inr)?\s*(\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b)/i.test(clause);
          if (!hasAmount) {
            const namesStr = exclMatch[1] || exclMatch[2] || exclMatch[3] || '';
            const prev = expenses[expenses.length - 1];
            squadNames.forEach(name => {
              if (new RegExp('\\b' + name + '\\b', 'i').test(namesStr)) {
                if (!prev.excluded.includes(name)) prev.excluded.push(name);
                prev.included = prev.included.filter(n => n.toLowerCase() !== name.toLowerCase());
              }
            });
            prev.raw += '. ' + clause;
            return; // Attached to previous expense; do not emit as standalone expense
          }
        }

        const item = this.parseClause(clause, squadNames);
        // Ignore pure zero-rupee empty clauses if confidence is low and no financial keywords
        if (item.amountPaise <= 0 && item.confidence === 'low' && !item.raw.match(/₹|rs|inr|paid|spent|bought|covered|cost/i)) {
          return;
        }

        expenses.push({
          id: 'exp_' + (expenses.length + 1) + '_' + Date.now(),
          ...item
        });
      });

      return expenses;
    },

    /**
     * Discovers capitalized words in narrative text that might be missing squad members.
     */
    discoverNames(storyText, squadNames = []) {
      if (!storyText || typeof storyText !== 'string') return [];
      const words = storyText.match(/\b[A-Z][a-z]{2,15}\b/g) || [];
      const squadSet = new Set(squadNames.map(n => n.toLowerCase()));
      const stopWords = new Set([
        'Paid', 'Spent', 'Bought', 'Dinner', 'Lunch', 'Breakfast', 'Food', 'Water',
        'Bottles', 'Uber', 'Ola', 'Hotel', 'Room', 'Resort', 'Except', 'Without',
        'Everyone', 'October', 'Friday', 'Saturday', 'Sunday', 'Airtel', 'WiFi',
        'Rupees', 'Bucks', 'Cash', 'Card', 'Between', 'Among', 'Shared', 'Total',
        'Bill', 'Dessert', 'Snacks', 'Drinks', 'Coffee', 'Tea', 'Swiggy', 'Zomato'
      ]);

      const discovered = new Set();
      words.forEach(w => {
        if (!squadSet.has(w.toLowerCase()) && !stopWords.has(w)) {
          discovered.add(w);
        }
      });
      return Array.from(discovered);
    }
  };

  // =========================================================================
  // 3. FINANCIAL LEDGER & EXACT BALANCE CALCULATOR
  // =========================================================================
  const Ledger = {
    /**
     * Distributes total paise among k participants with exact remainder allocation.
     * Order is deterministic: first (paise % k) participants receive Math.floor(paise/k) + 1,
     * remaining receive Math.floor(paise/k).
     * Guaranteed: sum(shares) === totalPaise.
     */
    calculateEqualShares(totalPaise, participants) {
      if (!participants || participants.length === 0) return {};
      const k = participants.length;
      const baseShare = Math.floor(totalPaise / k);
      const remainder = totalPaise % k;

      const shares = {};
      let distributedSum = 0;

      participants.forEach((name, idx) => {
        const hasRemainder = idx < remainder;
        const share = baseShare + (hasRemainder ? 1 : 0);
        shares[name] = {
          sharePaise: share,
          hasRemainderPaisa: hasRemainder
        };
        distributedSum += share;
      });

      // Verification of mathematical invariant
      if (distributedSum !== totalPaise) {
        throw new Error(`Invariant Violation: Distributed ${distributedSum} != Total ${totalPaise}`);
      }

      return shares;
    },

    /**
     * Computes full financial breakdown across squad members.
     * Enforces invariants:
     * - Sum(Paid) === Sum(Consumed) === TotalSpend
     * - Sum(Net) === 0 (Zero Drift)
     */
    computeBalances(squad, expenses) {
      const memberTotals = {};
      squad.forEach(m => {
        const name = typeof m === 'string' ? m : m.name;
        const upi = typeof m === 'object' && m.upi ? m.upi : '';
        memberTotals[name] = {
          name,
          upi,
          paidPaise: 0,
          consumedPaise: 0,
          netPaise: 0,
          paidItems: [],
          consumedItems: []
        };
      });

      let totalSpendPaise = 0;
      const matrix = [];

      expenses.forEach((exp, expIdx) => {
        const paise = exp.amountPaise || 0;
        totalSpendPaise += paise;

        // Ensure payer exists in member totals
        if (!memberTotals[exp.payer]) {
          memberTotals[exp.payer] = {
            name: exp.payer,
            upi: '',
            paidPaise: 0,
            consumedPaise: 0,
            netPaise: 0,
            paidItems: [],
            consumedItems: []
          };
        }

        // Record Payer payment
        memberTotals[exp.payer].paidPaise += paise;
        memberTotals[exp.payer].paidItems.push({
          id: exp.id || ('exp_' + expIdx),
          description: exp.description || exp.raw || `Expense #${expIdx + 1}`,
          amountPaise: paise
        });

        // Determine participants
        const participants = exp.included && exp.included.length > 0
          ? exp.included
          : Object.keys(memberTotals);

        const shares = this.calculateEqualShares(paise, participants);

        // Record consumption per participant
        participants.forEach(name => {
          if (!memberTotals[name]) {
            memberTotals[name] = {
              name,
              upi: '',
              paidPaise: 0,
              consumedPaise: 0,
              netPaise: 0,
              paidItems: [],
              consumedItems: []
            };
          }
          const shareInfo = shares[name];
          memberTotals[name].consumedPaise += shareInfo.sharePaise;
          memberTotals[name].consumedItems.push({
            id: exp.id || ('exp_' + expIdx),
            description: exp.description || exp.raw || `Expense #${expIdx + 1}`,
            raw: exp.raw,
            payer: exp.payer,
            sharePaise: shareInfo.sharePaise,
            totalAmountPaise: paise,
            participantCount: participants.length,
            hasRemainderPaisa: shareInfo.hasRemainderPaisa
          });
        });

        matrix.push({
          id: exp.id || ('exp_' + expIdx),
          description: exp.description || exp.raw || `Expense #${expIdx + 1}`,
          raw: exp.raw,
          payer: exp.payer,
          amountPaise: paise,
          participantCount: participants.length,
          shares
        });
      });

      // Calculate Net Balances: Net = Paid - Consumed
      let sumPaid = 0;
      let sumConsumed = 0;
      let sumNet = 0;

      Object.keys(memberTotals).forEach(name => {
        const m = memberTotals[name];
        m.netPaise = m.paidPaise - m.consumedPaise;
        sumPaid += m.paidPaise;
        sumConsumed += m.consumedPaise;
        sumNet += m.netPaise;
      });

      // Conservation Invariants Verification (Invariants 1-6)
      let sumAllocations = 0;
      matrix.forEach(row => {
        Object.values(row.shares).forEach(s => {
          sumAllocations += s.sharePaise;
        });
      });

      // Invariant 1 & 2: Total expense amounts === Sum of participant allocations === TotalSpend
      if (sumAllocations !== totalSpendPaise) {
        throw new Error(`Financial Invariant Failure: Total allocations (${sumAllocations}) do not equal total spend (${totalSpendPaise}).`);
      }

      // Invariant 3 & 4: Total Paid === Total Consumed === TotalSpend
      if (sumPaid !== totalSpendPaise) {
        throw new Error(`Financial Invariant Failure: Total paid (${sumPaid}) does not equal total spend (${totalSpendPaise}).`);
      }
      if (sumConsumed !== totalSpendPaise) {
        throw new Error(`Financial Invariant Failure: Total consumed (${sumConsumed}) does not equal total spend (${totalSpendPaise}).`);
      }

      // Invariant 5: Each member's net balance equals total paid minus total consumed
      Object.keys(memberTotals).forEach(name => {
        const m = memberTotals[name];
        if (m.netPaise !== (m.paidPaise - m.consumedPaise)) {
          throw new Error(`Financial Invariant Failure: Net balance for ${name} does not match (Paid - Consumed).`);
        }
      });

      // Invariant 6: Sum of all net balances equals exactly zero paise
      const driftPaise = Math.abs(sumNet);
      if (driftPaise !== 0) {
        throw new Error(`Financial Invariant Failure: Net balance sum is non-zero (${sumNet} paise).`);
      }

      return {
        memberTotals,
        totalSpendPaise,
        sumPaid,
        sumConsumed,
        driftPaise: 0,
        matrix
      };
    }
  };

  // =========================================================================
  // 4. SETTLEMENT SOLVER (EXACT SUBSET-PARTITION & GREEDY CASH-FLOW)
  // =========================================================================
  const SettlementSolver = {
    /**
     * Exact Subset-Partition Solver:
     * Minimum Cash-flow is equivalent to partitioning non-zero participants
     * into the MAXIMUM number of disjoint subsets whose net balances sum to zero.
     * If there are N non-zero participants and k disjoint zero-sum subsets,
     * the globally minimal number of transactions is proven to be exactly N - k.
     * 
     * Uses bitmask dynamic programming. Solves instantly for N <= 14.
     */
    solveExactSubsetPartition(participants) {
      const n = participants.length;
      if (n === 0) return [];
      if (n === 1) throw new Error('Unbalanced single participant net balance');

      const maxMask = 1 << n;
      const subsetSum = new Int32Array(maxMask);
      for (let mask = 1; mask < maxMask; mask++) {
        const lsb = mask & -mask;
        const idx = 31 - Math.clz32(lsb);
        subsetSum[mask] = subsetSum[mask ^ lsb] + participants[idx].netPaise;
      }

      // dp[mask] = max number of disjoint zero-sum subsets in mask
      const dp = new Int16Array(maxMask);
      const parent = new Int32Array(maxMask);
      parent.fill(-1);

      for (let mask = 1; mask < maxMask; mask++) {
        if (subsetSum[mask] === 0) {
          dp[mask] = 1;
          parent[mask] = 0;
        }
        const lsb = mask & -mask;
        let sub = (mask - 1) & mask;
        while (sub > 0) {
          if ((sub & lsb) !== 0) {
            const other = mask ^ sub;
            if (dp[sub] > 0 && dp[other] > 0) {
              if (dp[sub] + dp[other] > dp[mask]) {
                dp[mask] = dp[sub] + dp[other];
                parent[mask] = sub;
              }
            }
          }
          sub = (sub - 1) & mask;
        }
      }

      const fullMask = maxMask - 1;
      const subsets = [];

      function extractSubsets(mask) {
        if (dp[mask] <= 1 || parent[mask] === -1 || parent[mask] === 0) {
          subsets.push(mask);
          return;
        }
        const sub = parent[mask];
        extractSubsets(sub);
        extractSubsets(mask ^ sub);
      }
      extractSubsets(fullMask);

      // Within each independent zero-sum subset, settle debts
      const transactions = [];
      subsets.forEach(mask => {
        const subsetMembers = [];
        for (let i = 0; i < n; i++) {
          if ((mask & (1 << i)) !== 0) {
            subsetMembers.push({
              name: participants[i].name,
              upi: participants[i].upi,
              netPaise: participants[i].netPaise
            });
          }
        }

        const creds = subsetMembers.filter(p => p.netPaise > 0).map(p => ({ ...p }));
        const debts = subsetMembers.filter(p => p.netPaise < 0).map(p => ({ ...p, netPaise: -p.netPaise }));
        creds.sort((a, b) => b.netPaise - a.netPaise);
        debts.sort((a, b) => b.netPaise - a.netPaise);

        let c = 0, d = 0;
        while (c < creds.length && d < debts.length) {
          const settle = Math.min(creds[c].netPaise, debts[d].netPaise);
          if (settle > 0) {
            transactions.push({
              id: `tx_${debts[d].name}_${creds[c].name}_${settle}`,
              from: debts[d].name,
              to: creds[c].name,
              amountPaise: settle,
              amountRupees: (settle / 100).toFixed(2),
              creditorUpi: creds[c].upi || ''
            });
            creds[c].netPaise -= settle;
            debts[d].netPaise -= settle;
          }
          if (creds[c].netPaise === 0) c++;
          if (debts[d].netPaise === 0) d++;
        }
      });

      return transactions;
    },

    /**
     * Greedy Cash-flow Solver:
     * Iteratively matches the largest debtor with the largest creditor.
     * Guarantees at most N - 1 peer transfers. Fast O(N log N) for arbitrary group sizes.
     */
    solveGreedyCashFlow(participants) {
      const creditors = participants.filter(p => p.netPaise > 0).map(p => ({ ...p, amount: p.netPaise }));
      const debtors = participants.filter(p => p.netPaise < 0).map(p => ({ ...p, amount: -p.netPaise }));

      creditors.sort((a, b) => b.amount - a.amount);
      debtors.sort((a, b) => b.amount - a.amount);

      const transactions = [];
      let c = 0, d = 0;

      while (c < creditors.length && d < debtors.length) {
        const settle = Math.min(creditors[c].amount, debtors[d].amount);
        if (settle > 0) {
          transactions.push({
            id: `tx_${debtors[d].name}_${creditors[c].name}_${settle}`,
            from: debtors[d].name,
            to: creditors[c].name,
            amountPaise: settle,
            amountRupees: (settle / 100).toFixed(2),
            creditorUpi: creditors[c].upi || ''
          });
          creditors[c].amount -= settle;
          debtors[d].amount -= settle;
        }
        if (creditors[c].amount === 0) c++;
        if (debtors[d].amount === 0) d++;
      }

      return transactions;
    },

    /**
     * Solves settlements with automatic algorithm selection and full invariant verification.
     */
    solve(memberTotals) {
      const nonZeroParticipants = Object.keys(memberTotals)
        .map(name => ({
          name,
          upi: memberTotals[name].upi || '',
          netPaise: memberTotals[name].netPaise
        }))
        .filter(p => p.netPaise !== 0);

      const n = nonZeroParticipants.length;
      if (n === 0) {
        return {
          transactions: [],
          algorithm: 'none',
          optimal: true,
          guaranteeText: 'All squad members are completely square.'
        };
      }

      let transactions;
      let algorithm;
      let optimal;
      let guaranteeText;

      // For <= 14 non-zero participants, solve exactly via subset-partition DP
      if (n <= 14) {
        transactions = this.solveExactSubsetPartition(nonZeroParticipants);
        algorithm = 'exact_subset_partition';
        optimal = true;
        guaranteeText = `Exact Min-Transfers (proven minimal ${transactions.length} transfers via subset-partition DP)`;
      } else {
        transactions = this.solveGreedyCashFlow(nonZeroParticipants);
        algorithm = 'greedy_heuristic';
        optimal = false;
        guaranteeText = `Greedy Cash-Flow (optimized ≤ ${n - 1} transfers for large squad)`;
      }

      // Invariant verification on generated settlement plan
      this.validateSettlementPlan(memberTotals, transactions);

      return {
        transactions,
        algorithm,
        optimal,
        guaranteeText
      };
    },

    /**
     * Validates Settlement Invariants (Invariants 7-10):
     * 7. Settlement transfers conserve every member's net balance.
     * 8. Total incoming settlement equals total outgoing settlement.
     * 9. No member pays themselves.
     * 10. No transfer is negative or exceeds remaining debt/credit.
     */
    validateSettlementPlan(memberTotals, transactions) {
      const remaining = {};
      Object.keys(memberTotals).forEach(name => {
        remaining[name] = memberTotals[name].netPaise;
      });

      let totalTransferredIncoming = 0;
      let totalTransferredOutgoing = 0;

      transactions.forEach(t => {
        // Invariant 10: Amount must be positive
        if (t.amountPaise <= 0) {
          throw new Error(`Invalid transaction: amount must be > 0 (got ${t.amountPaise})`);
        }
        // Invariant 9: No member pays themselves
        if (t.from === t.to) {
          throw new Error(`Invalid transaction: payer and payee cannot be same (${t.from})`);
        }
        // Debtor pays: remaining debt decreases towards 0
        remaining[t.from] += t.amountPaise;
        totalTransferredOutgoing += t.amountPaise;

        // Creditor receives: remaining credit decreases towards 0
        remaining[t.to] -= t.amountPaise;
        totalTransferredIncoming += t.amountPaise;
      });

      // Invariant 8: Total incoming === Total outgoing
      if (totalTransferredIncoming !== totalTransferredOutgoing) {
        throw new Error(`Settlement Validation Failed: Incoming (${totalTransferredIncoming}) does not equal Outgoing (${totalTransferredOutgoing})`);
      }

      // Invariant 7: All balances cleared to exactly 0
      Object.keys(remaining).forEach(name => {
        if (remaining[name] !== 0) {
          throw new Error(`Settlement Validation Failed: Member ${name} has uncleared balance (${remaining[name]} paise)`);
        }
      });

      return true;
    }
  };

  // =========================================================================
  // 5. SETTLEMENT TRACKER (SELF-REPORTED AUDIT LOG & PROGRESS)
  // =========================================================================
  const SettlementTracker = {
    /**
     * Computes overall settlement progress (% paid and remaining debt).
     */
    getProgress(transactions, records = {}) {
      if (!transactions || transactions.length === 0) {
        return {
          totalDebtPaise: 0,
          settledDebtPaise: 0,
          remainingDebtPaise: 0,
          percentSettled: 100,
          isFullySettled: true,
          settledCount: 0,
          totalCount: 0
        };
      }

      let totalDebtPaise = 0;
      let settledDebtPaise = 0;
      let settledCount = 0;

      transactions.forEach(t => {
        totalDebtPaise += t.amountPaise;
        const rec = records[t.id];
        if (rec && rec.status === 'marked_paid') {
          settledDebtPaise += t.amountPaise;
          settledCount++;
        }
      });

      const remainingDebtPaise = totalDebtPaise - settledDebtPaise;
      const percentSettled = totalDebtPaise > 0
        ? Math.round((settledDebtPaise / totalDebtPaise) * 100)
        : 100;

      return {
        totalDebtPaise,
        settledDebtPaise,
        remainingDebtPaise,
        percentSettled,
        isFullySettled: remainingDebtPaise === 0,
        settledCount,
        totalCount: transactions.length
      };
    },

    /**
     * Creates a self-reported payment record with timestamp.
     */
    createRecord(txId, note = '') {
      return {
        txId,
        status: 'marked_paid',
        timestamp: new Date().toISOString(),
        note: note.trim(),
        selfReported: true
      };
    }
  };

  // =========================================================================
  // 6. STORAGE, MIGRATION & SHARING
  // =========================================================================
  const Storage = {
    SCHEMA_VERSION: 2,

    /**
     * Migrates data from V1 schema to V2 schema safely.
     */
    migrate(raw) {
      if (!raw) return null;
      let parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // Already V2?
      if (parsed.version === 2) {
        return parsed;
      }

      // V1 Outing Structure
      return {
        version: 2,
        id: parsed.id || ('out_' + Date.now()),
        title: parsed.title || 'Untitled Outing',
        date: parsed.date || new Date().toISOString().split('T')[0],
        squad: (parsed.squad || []).map(m => ({
          name: typeof m === 'string' ? m : m.name,
          upi: m.upi || ''
        })),
        story: parsed.story || '',
        expenses: (parsed.expenses || []).map((e, idx) => ({
          id: e.id || ('exp_' + (idx + 1)),
          raw: e.raw || '',
          description: e.description || `Expense #${idx + 1}`,
          payer: e.payer || '',
          amountRupees: e.amountRupees || (e.amountPaise ? e.amountPaise / 100 : 0),
          amountPaise: e.amountPaise || Money.toPaise(e.amountRupees),
          included: e.included || [],
          excluded: e.excluded || []
        })),
        settlementRecords: parsed.settlementRecords || {},
        updatedAt: parsed.updatedAt || new Date().toISOString()
      };
    },

    /**
     * Sanitizes strings to prevent XSS.
     */
    sanitize(str) {
      if (typeof str !== 'string') return '';
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    /**
     * Validates an imported outing object against the V2 schema.
     */
    validateOuting(obj) {
      if (!obj || typeof obj !== 'object') {
        throw new Error('Invalid outing data: Expected JSON object.');
      }
      if (!Array.isArray(obj.squad)) {
        throw new Error('Invalid outing data: Squad must be an array.');
      }
      if (!Array.isArray(obj.expenses)) {
        throw new Error('Invalid outing data: Expenses must be an array.');
      }

      const validSquad = obj.squad.map(m => {
        const name = typeof m === 'string' ? m.trim() : (m.name || '').trim();
        if (!name) throw new Error('Squad member must have a non-empty name.');
        return {
          name,
          upi: (m.upi || '').trim()
        };
      });

      const validExpenses = obj.expenses.map((e, idx) => {
        const rawRupees = typeof e.amountRupees === 'number' ? e.amountRupees : parseFloat(e.amountRupees);
        if (e.amountPaise < 0 || rawRupees < 0) {
          throw new Error(`Expense #${idx + 1} has negative amount.`);
        }
        const amountPaise = e.amountPaise ? Math.round(e.amountPaise) : Money.toPaise(e.amountRupees);
        return {
          id: e.id || ('exp_' + idx),
          raw: e.raw || '',
          description: (e.description || `Expense #${idx + 1}`).trim(),
          payer: (e.payer || '').trim(),
          amountRupees: amountPaise / 100,
          amountPaise: amountPaise,
          included: Array.isArray(e.included) ? e.included : [],
          excluded: Array.isArray(e.excluded) ? e.excluded : []
        };
      });

      return {
        version: 2,
        id: obj.id || ('out_' + Date.now()),
        title: (obj.title || 'Untitled Outing').trim(),
        date: obj.date || new Date().toISOString().split('T')[0],
        squad: validSquad,
        story: obj.story || '',
        expenses: validExpenses,
        settlementRecords: obj.settlementRecords || {},
        updatedAt: new Date().toISOString()
      };
    },

    /**
     * Serializes outing into safe URI-compatible base64 hash.
     */
    encodeSharePayload(outing) {
      const minimal = {
        t: outing.title,
        d: outing.date,
        sq: outing.squad.map(s => [s.name, s.upi || '']),
        st: outing.story,
        ex: outing.expenses.map(e => [e.payer, e.amountPaise, e.description, e.included, e.raw])
      };
      const json = JSON.stringify(minimal);
      if (typeof btoa !== 'undefined') {
        return encodeURIComponent(btoa(unescape(encodeURIComponent(json))));
      } else {
        return encodeURIComponent(Buffer.from(json, 'utf8').toString('base64'));
      }
    },

    /**
     * Decodes a base64 payload into an outing object.
     */
    decodeSharePayload(hash) {
      let rawJson = '';
      const cleaned = decodeURIComponent(hash.replace(/^#data=/, '').replace(/^#/, ''));
      if (typeof atob !== 'undefined') {
        rawJson = decodeURIComponent(escape(atob(cleaned)));
      } else {
        rawJson = Buffer.from(cleaned, 'base64').toString('utf8');
      }

      const minimal = JSON.parse(rawJson);
      return {
        version: 2,
        id: 'out_' + Date.now(),
        title: minimal.t || 'Shared Outing',
        date: minimal.d || new Date().toISOString().split('T')[0],
        squad: (minimal.sq || []).map(s => ({ name: s[0], upi: s[1] || '' })),
        story: minimal.st || '',
        expenses: (minimal.ex || []).map((e, idx) => ({
          id: 'exp_' + (idx + 1),
          payer: e[0],
          amountPaise: e[1],
          amountRupees: e[1] / 100,
          description: e[2] || `Expense #${idx + 1}`,
          included: e[3] || [],
          raw: e[4] || ''
        })),
        settlementRecords: {},
        updatedAt: new Date().toISOString()
      };
    },

    /**
     * Exports expenses and settlements to safe CSV format.
     * Prevents formula injection (CSV injection) by prefixing '=', '+', '-', '@' with a single quote.
     */
    exportCSV(outing, settlementResult) {
      function safeCell(val) {
        if (val === null || val === undefined) return '""';
        let str = String(val).replace(/"/g, '""');
        if (/^[=+@-]/.test(str)) {
          str = "'" + str;
        }
        return `"${str}"`;
      }

      const lines = [];
      lines.push([safeCell('HisabMate Ledger Export')]);
      lines.push([safeCell('Outing Title'), safeCell(outing.title)]);
      lines.push([safeCell('Date'), safeCell(outing.date)]);
      lines.push([]);

      // Expenses Table
      lines.push([safeCell('--- EXPENSES ---')]);
      lines.push([
        safeCell('Payer'),
        safeCell('Description'),
        safeCell('Amount (INR)'),
        safeCell('Amount (Paise)'),
        safeCell('Included Members')
      ]);

      outing.expenses.forEach(e => {
        lines.push([
          safeCell(e.payer),
          safeCell(e.description),
          safeCell((e.amountPaise / 100).toFixed(2)),
          safeCell(e.amountPaise),
          safeCell(e.included.join('; '))
        ]);
      });

      lines.push([]);
      // Settlements Table
      lines.push([safeCell('--- SETTLEMENT TRANSFERS ---')]);
      lines.push([
        safeCell('From (Debtor)'),
        safeCell('To (Creditor)'),
        safeCell('Amount (INR)'),
        safeCell('Amount (Paise)'),
        safeCell('Creditor UPI')
      ]);

      (settlementResult.transactions || []).forEach(t => {
        lines.push([
          safeCell(t.from),
          safeCell(t.to),
          safeCell(t.amountRupees),
          safeCell(t.amountPaise),
          safeCell(t.creditorUpi || '')
        ]);
      });

      return lines.map(row => row.join(',')).join('\r\n');
    }
  };

  // Export module public interface
  return {
    Money,
    Parser,
    Ledger,
    SettlementSolver,
    SettlementTracker,
    Storage
  };
});


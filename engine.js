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

    NON_PARTICIPANT_TERMS: new Set([
      'airbnb', 'finally', 'later', 'then', 'dinner', 'lunch', 'breakfast', 'brunch',
      'cab', 'cabs', 'taxi', 'uber', 'ola', 'drinks', 'beers', 'dessert', 'tickets',
      'flight', 'hotel', 'food', 'room', 'rooms', 'resort', 'chai', 'coffee', 'swiggy',
      'zomato', 'blinkit', 'zepto', 'groceries', 'water', 'bottles', 'parking', 'toll',
      'tolls', 'movie', 'petrol', 'diesel', 'fuel', 'snacks', 'party', 'outing', 'trip',
      'seafood', 'boat', 'ride'
    ]),

    

    isTransactionStarter(sentence, squadNames) {
      let s = sentence.trim();
      if (!s) return false;

      // Strip leading list numbers: "1. ", "1) ", "- ", "• "
      s = s.replace(/^\s*(?:\d+[\.\)]\s*|[-*•]\s*)/, '').trim();

      const escapedNames = squadNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

      // "<Name> paid/spent/bought/covered..."
      const payerVerbRegex = new RegExp(`^\\s*(?:${escapedNames})\\b\\s+(?:paid|spent|bought|covered|gave|chipped\\s*in|ordered|transferred|handled)\\b`, 'i');
      if (payerVerbRegex.test(s)) return true;

      // "Paid by <Name>" or "<Item> for ₹X paid by <Name>"
      const paidByRegex = new RegExp(`(?:paid|bought|spent|covered)\\s+by\\s+(?:${escapedNames})\\b`, 'i');
      if (paidByRegex.test(s)) return true;

      // "<Name> : ₹X ..." or "<Name> — ₹X ..." or "<Name> - ₹X ..."
      const colonRegex = new RegExp(`^\\s*(?:${escapedNames})\\s*[:\\—\\–\\-]\\s*(?:₹|rs\\.?|inr)?\\s*\\d+`, 'i');
      if (colonRegex.test(s)) return true;

      return false;
    },

    isInstructionOrMeta(sentence) {
      const s = sentence.trim().toLowerCase();
      // Typical instruction starts
      if (/^(?:use\s+only|calculate\s+every|ensure\s+|assume\s+|note\s+that|please\s+|do\s+not\s+add|instructions?:|summary:|squad:|expenses?:|notes?:|here\s+are)/i.test(s)) {
        return true;
      }
      // Sentences without any monetary amount and without payment verbs
      const hasCurrency = /(?:₹|rs\.?|inr)\s*\d+|\b\d+(?:\.\d{1,2})?\s*(?:rupees|bucks|inr)/i.test(s);
      const hasPayVerb = /\b(?:paid|spent|bought|covered|cost)\b/i.test(s);
      if (!hasCurrency && !hasPayVerb) {
        return true;
      }
      return false;
    },

    splitStoryIntoClauses(storyText, squadNames = []) {
      if (!storyText || typeof storyText !== 'string') return [];
      let text = storyText.replace(/\r\n/g, '\n').trim();
      if (!text) return [];

      // Split compound conjunctions when squad members are known
      if (squadNames.length > 0) {
        const escapedNames = squadNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const compoundRegex = new RegExp(
          `\\s+(?:and|while|then|plus)\\s+(?=(?:${escapedNames})\\s+(?:paid|spent|bought|covered|gave|chipped|ordered|transferred))`,
          'gi'
        );
        text = text.replace(compoundRegex, '. ');
      }

      const rawSentences = text
        .split(/\n+|\.(?:\s+|$)|;+|!+(?:\s+|$)/g)
        .map(s => s.trim())
        .filter(s => s.length > 1);

      const eventBlocks = [];
      let currentBlock = [];

      rawSentences.forEach((sentence) => {
        // If it's a new transaction start
        if (this.isTransactionStarter(sentence, squadNames)) {
          if (currentBlock.length > 0) {
            eventBlocks.push(currentBlock.join('. '));
            currentBlock = [];
          }
          currentBlock.push(sentence);
          return;
        }

        // If we have an active transaction block, check if this is an allocation/exclusion/sharing continuation
        if (currentBlock.length > 0) {
          const isContinuation = /^(?:allocated|split|share|sharing|consumed|portion|each|except|excluding|without|minus|leaving|the\s+other|with\s+the\s+other|half|one[- ]third|two[- ]thirds|quarter|one[- ]fourth|1\/2|1\/3|2\/3|1\/4|3\/4|\d+%|[A-Za-z0-9_]+\s*(?:₹|rs\.?|inr)?\s*\d+)/i.test(sentence)
            || /(?:share\s+half|remaining\s+half|other\s+half|remainder|rest|excluded|not\s+included|consumed\s+by|each\s+among|did\s+not\s+(?:have|eat|drink|join|partake|participate|share|take|come|use)|not\s+participate)/i.test(sentence);

          if (isContinuation) {
            currentBlock.push(sentence);
            return;
          }
        }

        // If it's an instruction or meta sentence, ignore it
        if (this.isInstructionOrMeta(sentence)) {
          return;
        }

        // Otherwise, if it has currency/amount and we have an active block, attach it
        if (currentBlock.length > 0 && /(?:₹|rs\.?|inr)\s*\d+/i.test(sentence)) {
          currentBlock.push(sentence);
        }
      });

      if (currentBlock.length > 0) {
        eventBlocks.push(currentBlock.join('. '));
      }

      return eventBlocks;
    },

    parseClause(clause, squadNames = []) {
      const squadLowerMap = {};
      squadNames.forEach(n => squadLowerMap[n.toLowerCase()] = n);

      const warnings = [];
      const unresolved = [];

      // Strip leading list numbers: "1. ", "1) ", "- ", "• "
      let workingClause = clause.replace(/^\s*(?:\d+[\.\)]\s*|[-*•]\s*)/, '').trim();
      // Clean transitional adverbs
      workingClause = workingClause.replace(/^(?:finally|later|then|after that|afterward|meanwhile|next|also|furthermore|additionally|plus|subsequently|lastly),?\s*/i, '').trim();

      // 1. Identify Payer
      let payer = null;

      // Pattern A: "paid by <Name>", "bought by <Name>", etc.
      const paidByMatch = workingClause.match(/(?:paid|bought|spent|covered|given|handled|chipped\s*in)\s+by\s+([A-Za-z0-9_]+)/i);
      if (paidByMatch) {
        const candidate = paidByMatch[1].toLowerCase();
        if (squadLowerMap[candidate]) {
          payer = squadLowerMap[candidate];
        } else if (!this.NON_PARTICIPANT_TERMS.has(candidate)) {
          unresolved.push(paidByMatch[1]);
        }
      }

      // Pattern B: "<Name> paid/spent/bought/covered..."
      if (!payer) {
        for (const name of squadNames) {
          const regex = new RegExp(`\\b${name}\\b\\s+(?:paid|spent|bought|covered|gave|chipped\\s*in|transferred|ordered|handled)`, 'i');
          if (regex.test(workingClause)) {
            payer = name;
            break;
          }
        }
      }

      // Pattern C: "<Name> — ₹X" or "<Name> : ₹X" or "<Name> - ₹X"
      if (!payer) {
        for (const name of squadNames) {
          const regex = new RegExp(`^\\s*${name}\\b\\s*[:\\—\\–\\-]\\s*(?:₹|rs\\.?|inr)?\\s*\\d+`, 'i');
          if (regex.test(workingClause)) {
            payer = name;
            break;
          }
        }
      }

      // Pattern D: Sentence starts with <Name>
      if (!payer) {
        for (const name of squadNames) {
          const regex = new RegExp(`^${name}\\b`, 'i');
          if (regex.test(workingClause) && !/(?:paid|bought|spent|covered)\s+by/i.test(workingClause)) {
            payer = name;
            break;
          }
        }
      }

      // Check unknown word followed by "paid"
      if (!payer) {
        const unknownPayerMatch = workingClause.match(/^([A-Za-z0-9_]+)\s+(?:paid|spent|bought|covered|gave|chipped\s*in)/i);
        if (unknownPayerMatch) {
          const candidate = unknownPayerMatch[1].toLowerCase();
          if (this.NON_PARTICIPANT_TERMS.has(candidate)) {
            warnings.push(`"${unknownPayerMatch[1]}" is an item/merchant, not a registered participant.`);
          } else if (!squadLowerMap[candidate]) {
            unresolved.push(unknownPayerMatch[1]);
            warnings.push(`Unknown person "${unknownPayerMatch[1]}" mentioned as payer. Only registered squad members can pay.`);
          }
        }
      }

      if (!payer) {
        warnings.push('Payer could not be determined automatically.');
      }

      // 2. Identify Primary Amount
      const amountRegex = /(?:₹|rs\.?|inr)?\s*(\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b)\s*(?:₹|rs\.?|inr|bucks|rupees)?/gi;
      let match;
      const candidates = [];

      while ((match = amountRegex.exec(workingClause)) !== null) {
        const fullMatch = match[0].trim();
        const numStr = match[1].replace(/,/g, '');
        const numVal = parseFloat(numStr);
        if (isNaN(numVal) || numVal <= 0) continue;

        const matchIndex = match.index;
        const prevContext = workingClause.slice(Math.max(0, matchIndex - 25), matchIndex).toLowerCase();
        const nextContext = workingClause.slice(matchIndex + fullMatch.length, matchIndex + fullMatch.length + 24).toLowerCase();

        let score = 0;
        if (/[₹]|rs|inr|bucks|rupees/i.test(fullMatch)) score += 55;
        if (/(?:for|paid|spent|cost|worth|bill\s+of|bill\s+was|amounting\s+to|amount\s+of|totaling|total\s+of|of|[:\—\–\-])\s*$/i.test(prevContext)) {
          score += 45;
        }

        // Penalty if preceded by individual allocation words ("allocated", "Anuj ₹...")
        if (/(?:allocated|share|portion|each)\s*$/i.test(prevContext)) {
          score -= 40;
        }
        for (const sName of squadNames) {
          if (new RegExp(`\\b${sName}\\s*[:=]?\\s*$`, 'i').test(prevContext)) {
            score -= 30;
            break;
          }
        }

        // Quantity penalty
        const quantityPattern = new RegExp(`^\\s*(?:${this.QUANTITY_STOPWORDS.join('|')})`, 'i');
        if (quantityPattern.test(nextContext)) {
          score -= 80;
        }

        if (numVal >= 10) score += 5;
        if (numVal >= 100) score += 10;
        if (numVal >= 500) score += 10;

        candidates.push({ val: numVal, score, numStr, fullMatch });
      }

      candidates.sort((a, b) => b.score - a.score);
      const amountRupees = candidates.length > 0 && candidates[0].score >= 0 ? candidates[0].val : 0;
      const amountPaise = Math.round(amountRupees * 100);

      if (amountPaise <= 0) {
        warnings.push('Expense amount could not be determined.');
      }

      // 3. Identify Exclusions
      const excluded = [];
      const exclusionRegexes = [
        /(?:except|without|excluding|minus|leaving\s+out|not\s+including)\s+([^.!?]+)/gi,
        /([A-Za-z0-9_,\s]+?)\s+(?:is|are|were|was)\s+(?:excluded|not\s+included|left\s+out|omitted)/gi,
        /([A-Za-z0-9_,\s]+?)\s+did\s+not\s+(?:have|eat|drink|join|partake|participate|share|take|come|use)/gi,
        /(?:with\s+)?the\s+other\s+(?:three|two|four|\d+)\s+(?:friends\s+)?(?:excluded|did\s+not)/gi
      ];

      exclusionRegexes.forEach(rgx => {
        let em;
        while ((em = rgx.exec(workingClause)) !== null) {
          const textSection = em[1] || em[0];
          squadNames.forEach(name => {
            if (new RegExp(`\\b${name}\\b`, 'i').test(textSection)) {
              if (!excluded.includes(name)) excluded.push(name);
            }
          });
        }
      });

      // 4. Identify Split Method & Allocations
      let splitType = 'equal';
      let allocations = null;
      let included = [];

      // --- CHECK 1: Custom individual participant amounts (e.g. Seafood) ---
      // "allocated Anuj ₹300, Priyasi ₹450, and Plaban ₹750" or "Anuj ₹300, Priyasi ₹450, Plaban ₹750"
      if (amountPaise > 0) {
        const pairRegex = /\b([A-Za-z0-9_]+)\s*(?:[:=]|allocated|takes?|took|consumes?|consumed|had|ate|portion|got)?\s*(?:for|of)?\s*(?:₹|rs\.?|inr)?\s*(\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b)\s*(?:₹|rs\.?|inr|worth)?/gi;
        let pm;
        const foundPairs = [];
        while ((pm = pairRegex.exec(workingClause)) !== null) {
          const nameCandidate = pm[1].toLowerCase();
          const amtStr = pm[2].replace(/,/g, '');
          const amtP = Math.round(parseFloat(amtStr) * 100);
          if (squadLowerMap[nameCandidate] && amtP > 0) {
            foundPairs.push({ name: squadLowerMap[nameCandidate], paise: amtP });
          }
        }

        if (foundPairs.length >= 2) {
          const sumAlloc = foundPairs.reduce((acc, p) => acc + p.paise, 0);
          allocations = {};
          foundPairs.forEach(p => allocations[p.name] = (allocations[p.name] || 0) + p.paise);
          splitType = 'custom';
          included = Object.keys(allocations);
          // Auto-exclude remaining squad members not in allocations
          squadNames.forEach(name => {
            if (!included.includes(name) && !excluded.includes(name)) {
              excluded.push(name);
            }
          });

          if (sumAlloc !== amountPaise) {
            warnings.push(`Allocation shares (₹${(sumAlloc / 100).toFixed(2)}) do not match total amount (₹${(amountPaise / 100).toFixed(2)}). Please adjust manually.`);
          }
        }
      }

      // --- CHECK 2: Fixed equal share ("₹X each among A, B, C...") ---
      // "split ₹150 each among Rohan, Sneha, Anuj, and Priyasi"
      if (!allocations && amountPaise > 0) {
        const eachRegex = /(?:split|at|for|share)?\s*(?:₹|rs\.?|inr)?\s*(\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b)\s*(?:₹|rs\.?|inr)?\s*(?:each|per\s+(?:person|head|member))\s*(?:among|between|for|to|shared\s+by)?\s*([^.]+)/i;
        const eachMatch = workingClause.match(eachRegex);
        if (eachMatch) {
          const eachPaise = Math.round(parseFloat(eachMatch[1].replace(/,/g, '')) * 100);
          const namesSection = eachMatch[2];
          const members = [];
          squadNames.forEach(n => {
            if (new RegExp(`\\b${n}\\b`, 'i').test(namesSection) && !excluded.includes(n)) {
              members.push(n);
            }
          });

          if (members.length > 0) {
            allocations = {};
            members.forEach(m => allocations[m] = eachPaise);
            splitType = 'custom';
            included = members;
            squadNames.forEach(name => {
              if (!included.includes(name) && !excluded.includes(name)) {
                excluded.push(name);
              }
            });

            const totalEachPaise = members.length * eachPaise;
            if (totalEachPaise !== amountPaise) {
              warnings.push(`Calculated per-person total (₹${(totalEachPaise / 100).toFixed(2)}) does not match total amount (₹${(amountPaise / 100).toFixed(2)}).`);
            }
          }
        }
      }

      // --- CHECK 3: Multi-group proportional sharing (Active and Passive phrasing) ---
      // e.g. Active: "Rohan and Sneha share half equally. Anuj and Priyasi share the remaining half equally"
      // e.g. Passive: "Half the snacks cost was consumed by Rohan and Sneha equally, and the remaining half was consumed by Anuj and Priyasi equally"
      if (!allocations && amountPaise > 0) {
        const activeRegex = /([A-Za-z0-9_,\s]+?)\s+(?:share|sharing|split|splitting|consumed?|took)\s+(half|one[- ]third|two[- ]thirds|1\/2|1\/3|2\/3|quarter|one[- ]fourth|1\/4|3\/4|\d+%)\s*(?:equally)?\s*[.,;]?\s*(?:and|while|with)?\s*([A-Za-z0-9_,\s]+?)\s+(?:share|sharing|split|splitting|consumed?|took)?\s*(?:the\s+)?(?:remaining\s+half|other\s+half|remainder|rest|remaining)\s*(?:equally)?/i;

        const passiveRegex = /(half|one[- ]third|two[- ]thirds|1\/2|1\/3|2\/3|quarter|one[- ]fourth|1\/4|3\/4|\d+%)(?:\s+(?:of\s+)?(?:the\s+)?(?:[A-Za-z0-9_]+\s+)*(?:cost|bill|amount|expense|total|price)?)?\s+(?:was|were|is|are)?\s*(?:consumed|split|shared|divided|for|by)\s+(?:by\s+)?([A-Za-z0-9_,\s]+?)\s*(?:equally)?\s*[.,;]?\s*(?:and|while|with)?\s*(?:the\s+)?(?:remaining\s+half|other\s+half|remainder|rest|remaining)\s+(?:was|were|is|are)?\s*(?:consumed|split|shared|divided|for|by)\s+(?:by\s+)?([^.!?]+?)(?:\s+equally)?(?:[.!?,;]|$)/i;

        const mActive = workingClause.match(activeRegex);
        const mPassive = !mActive ? workingClause.match(passiveRegex) : null;

        if (mActive || mPassive) {
          const g1NamesRaw = mActive ? mActive[1] : mPassive[2];
          const fracStr = (mActive ? mActive[2] : mPassive[1]).toLowerCase();
          const g2NamesRaw = mActive ? mActive[3] : mPassive[3];

          let fraction = 0.5;
          if (fracStr === 'one-third' || fracStr === '1/3') fraction = 1 / 3;
          else if (fracStr === 'two-thirds' || fracStr === '2/3') fraction = 2 / 3;
          else if (fracStr === 'quarter' || fracStr === 'one-fourth' || fracStr === '1/4' || fracStr === '25%') fraction = 0.25;
          else if (fracStr === 'three-fourths' || fracStr === '3/4' || fracStr === '75%') fraction = 0.75;
          else if (fracStr.endsWith('%')) fraction = parseFloat(fracStr) / 100;

          const g1 = [];
          const g2 = [];
          squadNames.forEach(n => {
            if (new RegExp(`\\b${n}\\b`, 'i').test(g1NamesRaw) && !excluded.includes(n)) g1.push(n);
            if (new RegExp(`\\b${n}\\b`, 'i').test(g2NamesRaw) && !excluded.includes(n)) g2.push(n);
          });

          if (g1.length > 0 && g2.length > 0) {
            const g1TotalPaise = Math.round(amountPaise * fraction);
            const g2TotalPaise = amountPaise - g1TotalPaise;

            const g1Shares = Ledger.calculateEqualShares(g1TotalPaise, g1);
            const g2Shares = Ledger.calculateEqualShares(g2TotalPaise, g2);

            allocations = {};
            g1.forEach(m => {
              allocations[m] = g1Shares[m].sharePaise;
            });
            g2.forEach(m => {
              allocations[m] = g2Shares[m].sharePaise;
            });

            splitType = 'proportional';
            included = Object.keys(allocations);
            squadNames.forEach(name => {
              if (!included.includes(name) && !excluded.includes(name)) {
                excluded.push(name);
              }
            });
          }
        }
      }

      // --- CHECK 4: Single consumer proportional pattern ---
      // "David consumed half while Rahul and Aisha shared the remainder"
      if (!allocations && amountPaise > 0) {
        const propRegexA = /\b([A-Za-z0-9_]+)\s+consumed\s+(half|one[- ]third|one[- ]fourth|quarter|1\/2|1\/3|1\/4|\d+%)\s*(?:,\s*|\s+)?while\s+([A-Za-z0-9_,\s]+?)\s+shared\s+(?:the\s+)?remainder/i;
        const propRegexB = /\b(half|one[- ]third|one[- ]fourth|quarter|1\/2|1\/3|1\/4|\d+%)\s+consumed\s+by\s+([A-Za-z0-9_]+)\s*(?:,\s*|\s+)?while\s+([A-Za-z0-9_,\s]+?)\s+shared\s+(?:the\s+)?remainder/i;

        const propMatchA = workingClause.match(propRegexA);
        const propMatchB = !propMatchA ? workingClause.match(propRegexB) : null;

        if (propMatchA || propMatchB) {
          const consumerNameRaw = propMatchA ? propMatchA[1] : propMatchB[2];
          const fracStr = (propMatchA ? propMatchA[2] : propMatchB[1]).toLowerCase();
          const remainderRaw = propMatchA ? propMatchA[3] : propMatchB[3];

          let fraction = 0.5;
          if (fracStr === 'one-third' || fracStr === '1/3') fraction = 1 / 3;
          else if (fracStr === 'one-fourth' || fracStr === 'quarter' || fracStr === '1/4' || fracStr === '25%') fraction = 0.25;
          else if (fracStr.endsWith('%')) fraction = parseFloat(fracStr) / 100;

          const consumerCanonical = squadLowerMap[consumerNameRaw.toLowerCase()];
          if (!consumerCanonical) {
            unresolved.push(consumerNameRaw);
            warnings.push(`Unknown consumer "${consumerNameRaw}" in proportional allocation.`);
          } else {
            const remainderMembers = [];
            squadNames.forEach(name => {
              if (new RegExp(`\\b${name}\\b`, 'i').test(remainderRaw)) {
                if (!remainderMembers.includes(name)) remainderMembers.push(name);
              }
            });

            if (remainderMembers.length === 0) {
              warnings.push('Could not determine who shares the remainder.');
            } else {
              const propPaise = Math.round(amountPaise * fraction);
              const remainderPaise = amountPaise - propPaise;
              const rBase = Math.floor(remainderPaise / remainderMembers.length);

              allocations = {};
              allocations[consumerCanonical] = propPaise;
              remainderMembers.forEach(m => {
                allocations[m] = (allocations[m] || 0) + rBase;
              });

              splitType = 'proportional';
              included = Object.keys(allocations);
            }
          }
        }
      }

      // --- CHECK 5: Itemized / Specific portion pattern ---
      if (!allocations && amountPaise > 0) {
        const itemRegex = /\bincluding\s+(?:a\s+)?(?:specific\s+)?(?:₹|rs\.?|inr)?\s*(\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b)\s*(?:meal|item|drink|portion|share)?\s*(?:for|to)\s+([A-Za-z0-9_]+)[^,]*,?\s*with\s+the\s+remaining\s*(?:(?:₹|rs\.?|inr)?\s*(\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\b)\s*)?shared\s*(?:by|among|according\s+to\s+the\s+stated\s+rule)?\s*([^.]+)?/i;
        const itemMatch = workingClause.match(itemRegex);

        if (itemMatch) {
          const specAmtStr = itemMatch[1].replace(/,/g, '');
          const specBeneficiaryRaw = itemMatch[2];
          const remContext = itemMatch[4] || '';

          const specPaise = Math.round(parseFloat(specAmtStr) * 100);
          const specBeneficiary = squadLowerMap[specBeneficiaryRaw.toLowerCase()];

          if (!specBeneficiary) {
            unresolved.push(specBeneficiaryRaw);
            warnings.push(`Unknown participant "${specBeneficiaryRaw}" for specific portion.`);
          } else if (specPaise >= amountPaise) {
            warnings.push(`Specific portion cannot exceed total amount.`);
          } else {
            const remPaise = amountPaise - specPaise;
            let remMembers = [];
            squadNames.forEach(name => {
              if (new RegExp(`\\b${name}\\b`, 'i').test(remContext)) {
                if (!remMembers.includes(name) && !excluded.includes(name)) remMembers.push(name);
              }
            });

            if (remMembers.length === 0 || /(?:everyone|everybody|all|squad|stated\s+rule)/i.test(remContext) || !remContext.trim()) {
              remMembers = squadNames.filter(n => !excluded.includes(n));
            }

            if (remMembers.length === 0) {
              warnings.push('No participants found to share the remaining amount.');
            } else {
              const remBase = Math.floor(remPaise / remMembers.length);
              allocations = {};
              remMembers.forEach(m => {
                allocations[m] = remBase;
              });
              allocations[specBeneficiary] = (allocations[specBeneficiary] || 0) + specPaise;

              splitType = 'itemized';
              included = Object.keys(allocations);
            }
          }
        }
      }

      // --- CHECK 6: Default Equal Split ---
      if (!allocations) {
        splitType = 'equal';
        const isForAll = /(?:for\s+all(?:\s+of\s+us)?|for\s+everyone|for\s+everybody|for\s+the\s+group|shared\s+by\s+everyone|shared\s+by\s+all|split\s+between\s+all|for\s+whole\s+squad|for\s+us\s+all|for\s+all\s+three|for\s+all\s+\d+|among\s+all(?:\s+\w+)?\s+members?|for\s+all(?:\s+\w+)?\s+members?|shared\s+equally\s+among\s+all(?:\s+\w+)?\s+members?)/i.test(workingClause);

        if (isForAll) {
          included = squadNames.filter(n => !excluded.includes(n));
        } else {
          const forMatch = workingClause.match(/(?:for|between|split\s+between|split\s+by|shared\s+by|shared\s+equally\s+among|among)\s+([^.]+)/i);
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

            if (payer && /(?:himself|herself|themself|myself)/i.test(forClause)) {
              if (!included.includes(payer) && !excluded.includes(payer)) {
                included.push(payer);
                foundSpecific = true;
              }
            }
          }

          if (!foundSpecific) {
            included = squadNames.filter(n => !excluded.includes(n));
          }
        }

        if (included.length === 0) {
          warnings.push('No participants included for this expense.');
        }
      }

      // 5. Clean Description Extraction
      let desc = workingClause;
      desc = desc.replace(/^\s*(?:\d+[\.\)]\s*|[-*•]\s*)/, '').trim();
      desc = desc.replace(/^(?:finally|later|then|after that|afterward|meanwhile|next|also|furthermore|additionally|plus|subsequently|lastly),?\s*/i, '').trim();

      if (payer) {
        const leadPayerRegex = new RegExp('^\\s*(?:(?:paid|bought|spent|covered)\\s+by\\s+' + payer + '|' + payer + '\\s*(?:[:\\—\\–\\-]|paid|spent|bought|covered|gave|chipped\\s*in|transferred|ordered)?)\\s*', 'i');
        desc = desc.replace(leadPayerRegex, '');
        const trailPayerRegex = new RegExp('\\s+(?:paid|bought|spent|covered)\\s+by\\s+' + payer + '\\b', 'i');
        desc = desc.replace(trailPayerRegex, '');
      }

      desc = desc.replace(/(?:₹|rs\.?|inr)?\s*[0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?\s*(?:₹|rs\.?|inr|bucks|rupees)?/gi, '');
      desc = desc.replace(/(?:except|without|excluding|minus|leaving\s+out|not\s+including)\s+[^.!?]+/gi, '');
      desc = desc.replace(/(?:shared|split)\s+(?:equally\s+)?(?:by|among|between)\s+[^.!?]+/gi, '');
      desc = desc.replace(/(?:for|between|among)\s+(?:all(?:\s+of\s+us)?|everyone|everybody|the\s+group|all\s+the\s+squad|whole\s+squad|all\s+three|all\s+\d+|six\s+registered\s+members|all\s+six\s+registered\s+members)[^.!?]*/gi, '');
      desc = desc.replace(/\ballocated\s+.*$/i, '');
      desc = desc.replace(/\b(?:and\s+)?[A-Za-z0-9_]+\s+consumed\s+.*$/i, '');
      desc = desc.replace(/\bincluding\s+.*$/i, '');
      desc = desc.replace(/[A-Za-z0-9_,\s]+?\s+share\s+half\s+.*$/i, '');
      desc = desc.replace(/\bsplit\s+.*each\s+.*$/i, '');
      desc = desc.replace(/\b(?:with\s+)?(?:the\s+)?other\s+(?:three|two|four|\d+)\s+excluded.*$/i, '');
      desc = desc.replace(/\b(?:half|one[- ]third|two[- ]thirds|quarter|one[- ]fourth|1\/2|1\/3|2\/3|1\/4|3\/4|\d+%)\s+.*$/i, '');

      desc = desc.replace(/,\s*who\s+.*$/i, '');
      desc = desc.replace(/\b[A-Za-z0-9_,\s]+?\s+did\s+not\s+.*$/i, '');
      desc = desc.replace(/^\s*(?:the|a|an)\s+/i, '');
      desc = desc.replace(/^\s*(?:for|and|then|also|on|ate|had|bought|at|[:\—\–\-])\s+/gi, '')
                 .replace(/\s+(?:for|and|by|shared\s+by|at)\s*$/gi, '')
                 .replace(/^[.,;!\s\—\–\-]+|[.,;!\s\—\–\-]+$/g, '')
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
        splitType,
        allocations,
        included,
        excluded,
        unresolved,
        warnings,
        confidence: (warnings.length === 0 && unresolved.length === 0 && payer && payer !== 'Unresolved' && amountPaise > 0) ? 'high' : 'low'
      };
    },

    parseStory(storyText, squadNames = []) {
      const clauses = this.splitStoryIntoClauses(storyText, squadNames);
      const expenses = [];

      clauses.forEach((clause) => {
        const item = this.parseClause(clause, squadNames);
        // Strictly ignore zero-amount or non-financial items
        if (item.amountPaise <= 0) {
          return;
        }

        expenses.push({
          id: 'exp_' + (expenses.length + 1) + '_' + Date.now(),
          ...item
        });
      });

      return expenses;
    },

    discoverNames(storyText, squadNames = []) {
      return []; // Intentionally return empty: participant creation must be separate from expense parsing
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
      const squadNames = [];
      squad.forEach(m => {
        const name = typeof m === 'string' ? m.trim() : (m.name || '').trim();
        if (!name) throw new Error('Registered squad member must have a non-empty name.');
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
        squadNames.push(name);
      });

      const squadLowerMap = {};
      squadNames.forEach(n => {
        squadLowerMap[n.toLowerCase()] = n;
      });

      let totalSpendPaise = 0;
      const matrix = [];

      expenses.forEach((exp, expIdx) => {
        const paise = exp.amountPaise || 0;
        if (paise <= 0) {
          throw new Error(`Expense #${expIdx + 1} ("${exp.description || 'Expense'}") has non-positive amount.`);
        }
        totalSpendPaise += paise;

        // Strict Payer Validation: Payer MUST be a registered squad member
        const rawPayer = (exp.payer || '').trim();
        const canonicalPayer = squadLowerMap[rawPayer.toLowerCase()];
        if (!canonicalPayer || !memberTotals[canonicalPayer]) {
          throw new Error(`Unknown or unregistered payer "${rawPayer || 'Unresolved'}" on expense #${expIdx + 1}. Only registered squad members can pay expenses.`);
        }

        // Record Payer payment
        memberTotals[canonicalPayer].paidPaise += paise;
        memberTotals[canonicalPayer].paidItems.push({
          id: exp.id || ('exp_' + expIdx),
          description: exp.description || exp.raw || `Expense #${expIdx + 1}`,
          amountPaise: paise
        });

        // Determine shares
        let shares = {};
        if (exp.allocations && Object.keys(exp.allocations).length > 0) {
          let sumAlloc = 0;
          Object.keys(exp.allocations).forEach(rawBeneficiary => {
            const canonicalBeneficiary = squadLowerMap[rawBeneficiary.toLowerCase()];
            if (!canonicalBeneficiary || !memberTotals[canonicalBeneficiary]) {
              throw new Error(`Unknown or unregistered beneficiary "${rawBeneficiary}" in allocations for expense #${expIdx + 1}.`);
            }
            const allocPaise = Math.round(exp.allocations[rawBeneficiary]);
            if (allocPaise < 0) {
              throw new Error(`Negative allocation for ${rawBeneficiary} in expense #${expIdx + 1}.`);
            }
            shares[canonicalBeneficiary] = {
              sharePaise: allocPaise,
              hasRemainderPaisa: false
            };
            sumAlloc += allocPaise;
          });

          if (sumAlloc !== paise) {
            throw new Error(`Allocation Invariant Violation on expense #${expIdx + 1}: Sum of allocations (${sumAlloc} paise) does not equal total amount (${paise} paise).`);
          }
        } else {
          // Equal split among valid registered participants
          const participants = (exp.included && exp.included.length > 0 ? exp.included : squadNames)
            .map(rawName => squadLowerMap[(rawName || '').toLowerCase()])
            .filter(Boolean);

          if (participants.length === 0) {
            throw new Error(`No registered participants included for expense #${expIdx + 1}.`);
          }

          shares = this.calculateEqualShares(paise, participants);
        }

        // Record consumption per participant
        Object.keys(shares).forEach(name => {
          const shareInfo = shares[name];
          memberTotals[name].consumedPaise += shareInfo.sharePaise;
          memberTotals[name].consumedItems.push({
            id: exp.id || ('exp_' + expIdx),
            description: exp.description || exp.raw || `Expense #${expIdx + 1}`,
            raw: exp.raw,
            payer: canonicalPayer,
            sharePaise: shareInfo.sharePaise,
            totalAmountPaise: paise,
            participantCount: Object.keys(shares).length,
            hasRemainderPaisa: shareInfo.hasRemainderPaisa || false
          });
        });

        matrix.push({
          id: exp.id || ('exp_' + expIdx),
          description: exp.description || exp.raw || `Expense #${expIdx + 1}`,
          raw: exp.raw,
          payer: canonicalPayer,
          amountPaise: paise,
          participantCount: Object.keys(shares).length,
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

      if (sumAllocations !== totalSpendPaise) {
        throw new Error(`Financial Invariant Failure: Total allocations (${sumAllocations}) do not equal total spend (${totalSpendPaise}).`);
      }
      if (sumPaid !== totalSpendPaise) {
        throw new Error(`Financial Invariant Failure: Total paid (${sumPaid}) does not equal total spend (${totalSpendPaise}).`);
      }
      if (sumConsumed !== totalSpendPaise) {
        throw new Error(`Financial Invariant Failure: Total consumed (${sumConsumed}) does not equal total spend (${totalSpendPaise}).`);
      }
      Object.keys(memberTotals).forEach(name => {
        const m = memberTotals[name];
        if (m.netPaise !== (m.paidPaise - m.consumedPaise)) {
          throw new Error(`Financial Invariant Failure: Net balance for ${name} does not match (Paid - Consumed).`);
        }
      });
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
          splitType: e.splitType || (e.allocations ? 'custom' : 'equal'),
          allocations: (e.allocations && typeof e.allocations === 'object') ? e.allocations : null,
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


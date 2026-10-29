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
    root.Engine = root.HisabMateEngine;
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
      'seafood', 'boat', 'ride', 'beach', 'hotel', 'resort', 'dhaba', 'mall', 'shop', 'station', 'airport', 'entry', 'fee', 'rent'
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

    DISCOVER_STOPWORDS: new Set([
      'a', 'an', 'the', 'all', 'us', 'we', 'them', 'they', 'everyone', 'everybody', 'anyone', 'someone',
      'friends', 'friend', 'squad', 'members', 'member', 'group', 'people', 'person',
      'persons', 'guys', 'relative', 'relatives', 'family', 'flatmates', 'roommates',
      'colleagues', 'each', 'both', 'other', 'others', 'and', 'or', 'who', 'which', 'that', 'this',
      'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
      'half', 'quarter', 'third', 'share', 'portion', 'split', 'cost', 'bill', 'amount',
      'worth', 'total', 'sum', 'money', 'cash', 'upi', 'rupees', 'paise', 'rs', 'inr',
      'remaining', 'rest', 'some', 'few', 'registered',
      'digha', 'goa', 'manali', 'mumbai', 'delhi', 'bangalore', 'bengaluru', 'pune',
      'kolkata', 'pondicherry', 'shimla', 'rishikesh', 'jaipur', 'udaipur', 'kerala',
      'karim', "karim's", 'karims',
      'broadband', 'wifi', 'cans', 'fastag', 'auto', 'bus', 'train', 'metro', 'airtel',
      'veg', 'nonveg', 'beer', 'beers', 'wine', 'alcohol', 'tea', 'juice', 'pizza',
      'burger', 'biryani', 'roti', 'naan', 'rice', 'dal', 'curry', 'icecream',
      'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
      'weekend', 'morning', 'evening', 'night', 'afternoon', 'yesterday', 'today',
      'tomorrow', 'month', 'year', 'day', 'days', 'january', 'february', 'march',
      'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
      'december',
      'of', 'for', 'in', 'on', 'at', 'to', 'from', 'with', 'without', 'by', 'as', 'into',
      'about', 'over', 'after', 'before', 'during', 'under', 'between', 'among', 'per', 'near', 'around', 'across', 'beside', 'behind', 'above', 'below', 'off', 'out', 'up', 'down',
      'except', 'excluding', 'only', 'use', 'calculate', 'every', 'ensure', 'assume',
      'note', 'please', 'instructions', 'instruction', 'summary', 'expenses', 'notes',
      'participate', 'independently', 'allocated', 'equally', 'not', 'no', 'is', 'are',
      'was', 'were', 'did', 'does', 'do', 'had', 'have', 'has', 'went', 'visited',
      'travelled', 'traveled', 'stayed', 'used', 'ate', 'took', 'joined', 'came',
      'paid', 'spent', 'bought', 'ordered', 'handled', 'covered', 'given', 'gave',
      'transferred', 'chipped', 'added', 'being', 'card', 'cards', 'tip', 'tips', 'gst', 'tax', 'vat', 'discount', 'beach', 'hotel', 'resort', 'cafe', 'restaurant', 'dhaba', 'mall', 'shop', 'station', 'airport', 'petrol', 'fuel', 'toll', 'tolls', 'parking', 'cab', 'cabs', 'taxi', 'uber', 'ola', 'flight', 'tickets', 'ticket', 'movie', 'show', 'entry', 'fees', 'fee', 'rent', 'groceries', 'grocery', 'breakfast', 'brunch', 'lunch', 'dinner', 'snacks', 'dessert', 'water', 'seafood', 'boat', 'ride'
    ]),

    /**
     * Extracts distinct participant names mentioned in a natural language story.
     * Deduplicates, title-cases, and filters out locations, items, numbers, and stopwords.
     * @param {string} storyText The narrative string
     * @param {string[]} squadNames Optional existing known squad names
     * @returns {string[]} List of distinct detected participant names
     */
    discoverNames(storyText, squadNames = []) {
      if (!storyText || typeof storyText !== 'string') return [];
      const text = storyText.replace(/\r\n/g, '\n');
      const foundNames = [];
      const seenLower = new Set();

      const addCandidate = (raw) => {
        if (!raw) return;
        const clean = raw.trim().replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
        if (clean.length < 2 || clean.length > 20) return;
        if (!/^[A-Za-z]+$/.test(clean)) return;
        const lower = clean.toLowerCase();
        if (this.DISCOVER_STOPWORDS.has(lower) || this.NON_PARTICIPANT_TERMS.has(lower)) return;
        if (seenLower.has(lower)) return;
        seenLower.add(lower);
        const properName = clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
        foundNames.push(properName);
      };

      const processNameList = (str) => {
        if (!str) return;
        const parts = str.split(/(?:,|\band\b|&|\/|\+)/gi);
        parts.forEach(p => {
          const tokens = p.trim().split(/\s+/);
          tokens.forEach(t => addCandidate(t));
        });
      };

      // 1. Group introductory patterns: e.g. "Six friends — Anuj, Priyasi, Plaban... — went on..."
      const introRegex = /(?:(?:six|five|four|three|two|\d+)\s+friends|friends|squad|group|members)\s*[:—–-]\s*([^.—–\n]+)/gi;
      let match;
      while ((match = introRegex.exec(text)) !== null) {
        processNameList(match[1]);
      }

      // 2. Payers: "<Name> paid/spent/bought/covered..." or "<Name> and <Name> paid..."
      const payerVerbRegex = /\b([A-Za-z]+(?:\s+and\s+[A-Za-z]+)?)\s+(?:paid|spent|bought|covered|gave|chipped\s*in|ordered|transferred|handled)\b/gi;
      while ((match = payerVerbRegex.exec(text)) !== null) {
        processNameList(match[1]);
      }

      // 2b. Sharers: "<Name> and <Name> shared/split..."
      const sharerSubjectRegex = /([^.\n;,]+?)\s+(?:shared|split)\b/gi;
      while ((match = sharerSubjectRegex.exec(text)) !== null) {
        processNameList(match[1]);
      }

      // 3. "paid/bought/spent/covered by <Name>"
      const paidByRegex = /(?:paid|bought|spent|covered|handled|ordered|given)\s+by\s+([A-Za-z]+)\b/gi;
      while ((match = paidByRegex.exec(text)) !== null) {
        addCandidate(match[1]);
      }

      // 4. List items: "<Name> — ₹X" or "<Name> : ₹X"
      const listPayerRegex = /^\s*([A-Za-z]+)\s*[:—–-]\s*(?:₹|rs\.?|inr)?\s*\d+/gim;
      while ((match = listPayerRegex.exec(text)) !== null) {
        addCandidate(match[1]);
      }

      // 5. Sharing / Split clauses: "shared by ...", "shared among ...", "shared between ..."
      const sharedRegex = /(?:shared|split|consumed)\s+(?:equally\s+)?(?:by|among|between)\s+([^.\n;]+?)(?:\s+equally|\s+only|\s+except|\s+excluding|\s+without|\.|$|;)/gi;
      while ((match = sharedRegex.exec(text)) !== null) {
        processNameList(match[1]);
      }

      // 6. Exclusions: "except ...", "excluding ...", "without ..."
      const exceptRegex = /(?:except|excluding|without)\s+([^.\n;,]+?)(?:,|\.|$|;|\s+who)/gi;
      while ((match = exceptRegex.exec(text)) !== null) {
        processNameList(match[1]);
      }

      // 7. Did not participate / eat: "<Name> did not participate / eat / drink / take"
      const didNotRegex = /([A-Za-z]+)(?:\s+and\s+([A-Za-z]+))?\s+did\s+not\s+(?:participate|eat|drink|join|take|come|use)/gi;
      while ((match = didNotRegex.exec(text)) !== null) {
        if (match[1]) addCandidate(match[1]);
        if (match[2]) addCandidate(match[2]);
      }

      // 8. Explicit consumption: "<Name> consumed ₹X", "<Name> ate veg for 250"
      const consumedRegex = /\b([A-Za-z]+)\s+(?:consumed|ate|took|got)\b/gi;
      while ((match = consumedRegex.exec(text)) !== null) {
        addCandidate(match[1]);
      }

      // 9. Allocated: "Allocated <Name> ₹X, <Name> ₹Y"
      const allocRegex = /(?:allocated|portion|share)\s+([A-Za-z]+)\s*(?:₹|rs\.?|inr)?\s*\d+/gi;
      while ((match = allocRegex.exec(text)) !== null) {
        addCandidate(match[1]);
      }

      // 10. For: "for <Name1> and <Name2>" (e.g. "dessert for Arkadeep and Priyasi")
      const forRegex = /\b(?:dessert|lunch|dinner|food|snacks|drinks|bottles|tickets?)\s+for\s+([^.\n;,]+?)(?:\.|$|;)/gi;
      while ((match = forRegex.exec(text)) !== null) {
        processNameList(match[1]);
      }

      // 10b. With: "with <Name1>", "with <Name1> and <Name2>", "along with <Name1>"
      const withRegex = /\b(?:along\s+with|with)\s+([A-Za-z]+(?:\s+and\s+[A-Za-z]+)?)\b/gi;
      while ((match = withRegex.exec(text)) !== null) {
        processNameList(match[1]);
      }

      return foundNames;
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


  // =========================================================================
  // 7. UPI DEEP LINK & PAYMENT INTENT UTILITY
  // =========================================================================
  const UPI = {
  validateUpiId(upi) {
    if (!upi || typeof upi !== 'string') {
      return { valid: false, error: 'UPI ID is required.' };
    }
    const trimmed = upi.trim();
    if (!trimmed) {
      return { valid: false, error: 'UPI ID cannot be empty.' };
    }
    // Standard VPA regex: user@psp (e.g. name@okhdfcbank, 9876543210@paytm)
    const vpaRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9]{2,64}$/;
    if (!vpaRegex.test(trimmed)) {
      return { valid: false, error: 'Invalid UPI ID format. Expected format: user@bank or phone@upi' };
    }
    return { valid: true, error: null };
  },

  formatAmount(amount) {
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error('Settlement amount must be a positive number greater than 0.');
    }
    return num.toFixed(2);
  },

  buildPaymentUri({ payeeVpa, payeeName, amountRupees, outingTitle, note }) {
    const vpaCheck = this.validateUpiId(payeeVpa);
    if (!vpaCheck.valid) {
      throw new Error(vpaCheck.error);
    }
    if (!payeeName || typeof payeeName !== 'string' || !payeeName.trim()) {
      throw new Error('Payee name is required for UPI payment.');
    }
    const cleanAmount = this.formatAmount(amountRupees);
    const cleanPayee = payeeName.trim();
    const cleanVpa = payeeVpa.trim();
    const cleanNote = (note || (outingTitle ? `HisabMate: ${outingTitle}` : 'HisabMate Settlement')).trim();

    return `upi://pay?pa=${encodeURIComponent(cleanVpa)}&pn=${encodeURIComponent(cleanPayee)}&am=${cleanAmount}&cu=INR&tn=${encodeURIComponent(cleanNote)}`;
  },

  getTransferPaymentInfo(transfer, squad = [], outingTitle = '') {
    if (!transfer) {
      return { canPay: false, validationError: 'Transfer record is missing.' };
    }

    const payeeName = transfer.to || '';
    const payerName = transfer.from || '';

    // Search squad member for upi if not on transfer
    let payeeVpa = transfer.creditorUpi || '';
    if (!payeeVpa && Array.isArray(squad)) {
      const member = squad.find(m => m.name && m.name.toLowerCase() === payeeName.toLowerCase());
      if (member && member.upi) payeeVpa = member.upi;
    }

    const amountRupees = transfer.amountRupees || (transfer.amountPaise ? (transfer.amountPaise / 100).toFixed(2) : '0.00');
    const amountPaise = transfer.amountPaise || Math.round(Number(amountRupees) * 100);

    const vpaCheck = this.validateUpiId(payeeVpa);
    let numAmount = Number(amountRupees);
    let amountValid = Number.isFinite(numAmount) && numAmount > 0;

    let canPay = vpaCheck.valid && amountValid && !!payeeName;
    let validationError = null;
    if (!payeeName) {
      validationError = 'Payee recipient name is missing.';
    } else if (!vpaCheck.valid) {
      validationError = `Recipient ${payeeName} does not have a configured UPI ID.`;
    } else if (!amountValid) {
      validationError = 'Settlement amount must be greater than zero.';
    }

    let uri = '';
    if (canPay) {
      try {
        uri = this.buildPaymentUri({
          payeeVpa,
          payeeName,
          amountRupees,
          outingTitle
        });
      } catch (e) {
        canPay = false;
        validationError = e.message;
      }
    }

    return {
      canPay,
      payeeName,
      payeeVpa,
      payerName,
      amountRupees,
      amountPaise,
      note: outingTitle ? `HisabMate: ${outingTitle}` : 'HisabMate Settlement',
      uri,
      validationError
    };
  }
};

  // =========================================================================
  // 8. PROFESSIONAL PDF BILL GENERATOR
  // =========================================================================
  const HISABMATE_LOGO_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAQAElEQVR4Aeyde7stWVXex+RBoMEn/ybRRBEFSRuNwYTkW+WiItJyF0UUST5UiDHRKCheEEQQkr8ToOlunqf9ve+Yc9astarWXmvts/dea+0qxuUd7xhzVNWYNc9uDn0Ob4kHvl561z96c9NtBvf5Bh7yE31hB2DtBR/y4bfez2MCD/lt3esAjA/2PLZie8tLmsCL+P7OOgDtxpc0jO1ZnvcEzv0mTzoA597keW/N9vaPOYFTv9GjD4AaP+aLPPy9tjvc8gSO/V6POgDHNrvlgW7vdn0TOOa7vfMAHNPk+kazPfFzmcBd3+/BA3DX4ucyxO09r3sCh77j1QNwaNF1j2N7+uc4gbXvefEArBU/x8Hd5Ds/05da+q73DsBS0TOd1/baNziB3e977wDc4Dtvr7RNYHUCswOwezpWV22JbQJXPIHxO58dgCt+p+3RtwmcNYF+AMZTcVanbdE2gSuYQHvE9r33A9ASm98m8JwmsB2A57Tb27vuTcAHoP042MtuxDaBG56AvnsfgBt+x+3VtgkcnMB2AA6OZ0ve+gSe0QG49a3c3u+cCWwH4JypbWtuZgLbAbiZrdxe5JwJvEX/TfichduabQK3MIHtJ8At7OL2DmdPYDsAZ4/uihZuj7o6ge0ArI5mSzyHCWwH4Dns8vaOqxPYDsDqaLbEc5jAdgAeaZcL9zlVWbLJA09gOwAvcMCzD5ygDBrgU3Vcb8yztjbATY6YwF0l2wG4a0IH8u1j9MfZAxYIVyf4IpR2MR6gds/WO7brrAlsB+DEsfmDw+gD7B8kPaB6mDht7LChhXdp7K8tcCUCO2noqmRvKW7ToyewHYAjRuVvDKOPzF8gawgN06cNMRSVUgJZ1ogoEYeVguX1NVFXF3yJwKaGLoi+VvGmByewHYCV8fAd5YfVAHUNykdmcSX6B1cIY/kiFafqUif3wLR7hkBAoGkDFHlBKI2buMxstk5gOwB1EM35Y7GBwSP+eOSjolJKIKkxvwrhnu4RS0X7nO+xT8NM4tYY18oEAZo2QBE2EErjYrumCdzwAZhe8hikD0MfiD8WFjjGh4kSpUiJSswuhV07oKRilkWF5/mFxbs9uVsX51hTCqbesSEXESiFc/jczbM/APoQ9EH4W+FrcIwPESSQkMZwtRrzPYgYYMfxAq7FvgOp52jheDvzTtjMnwnK+XHBM8TP+gDwDYS/igg7x0J8GYhQtEs5qw0sHnFN87BdzGHcZ8+XKGVNg9yCxvwqhKNGDWjbIBUpTk1mnodHsvAZ2md5ALTh+lD0JRh740GQiGgzMrAZV1Bdciqo6nUk01fgKnD1BZ8aoDVdqaBxKeQK66rGcEH1ng00rpU5nkwrCwFay8Vzu57VARj23putOITYfUQodIm32kS0nMKol7B5QCmYmHRCMbAxXWsF4muV4JLG0LGUEkhqTFcBWm2i5xUGl7zWORGF/4RVRnyJ53M9mwPgTbUJ7XOEbYlxw0tESG0AiGHUyzFGayINmRLFNroPXZVU2Z6Sr+m+pseA3fpetLAuWpJFSFhjumgXUhsAYqgKYxkzxVa8QDG4ffMsDoA+irapubElxEnbFhcBGRQJqSip6qSRBqpEsQ17Gwilu0aYjhdw0dq9eu9ORPIR9mlJUoiENOoFG1IbAFIzEaqTgkK8VCC5uOnrpg+ANrJtonBoV9HGBZd4KbTECm1RnTTMlmozaoHyJcJh7FyNt8e49hRPP8oP924FeMS18lFRu2fUSzmp0vLSmgrVRogptsElruBvVW72AHjTbKJuJoEEDS45qZMABDbFm25CprSSmoxwPiJKTJewFeM83gXN19IWHvK1NMb1rad9hFNRr96rAfgJJvI6QXISQxkU6f1Ul0FJV4uL/A3qTR4AbxYGqZtYQhtb6gbay6BISJWSV12YKdVGNKBciekSttrAy1cnONdCm7KaDbJNCzi1MZMPXQWDtucBQqQIi6dFSB2HrkTKCU0MSASKEISWheqExEkDg8StXTd3ALxx7BRS96qEuR4BCopUB4qscWGJEmGVEdXjyMuxDbF8dYLS0MKmNCilBHKGFlqhMemEIq9KuH8ytpUO8UGAyJEDQSLgFJgOOobJmmRsMcmRvFA59bFu6gC0zWGfmAMWAgGHNx/GQF4aXMpLgwpxUmCIM468hM0ZDBywRLENfCklkEnjfldh+ayfgjCLLWhYQ1eJUNoa0wVtPgCIHMkSritARE4aGEQONkI11YT44DKHvwW5mQPQNiU3CZviPQKGdw+ARLtyjZjitPkSE44wdh18cMmlpg2SiJyVki61IlY9ib6WVYSrtaS79DVeYMO6goY1dJUI18V0QUXYNKeghOqiXkVeBkUUhX01drDjGsKrlZs4AG0zcnNKKC51S+xtIqqzV40YcVKR4owjFIbiqISctGZCOWtMl/KjxhhU7DVge5YCswxgDp/EmIw9KurlcozWRq0iNApdBMrhFJlXLCBOGgTiEiuKvCAQY3nVhGojr4wTX6u9+gPQNkEbFNqcBKHLEIOQERPh+jQhPnQBECGrsU24JiGWdUhIo16w0bQDCNXgRsq4LjvoltapnxvUZHWmWjPVSCNNtBrnCRBDGWObcJ0t65DQpZRUSXuRaOaLaKKIjONqr6s+AG34xeMvs80o4jCIkDXrSxQiqYA448opNl/jcFBCfInpEpaGDNryQFNTZSLzGNcd43PZzLLMve1tSOMR80QWx5NxTqGA7++qUBiKgyQiF4E1F3mJh5Ikgc186VzGJK5QrvYAlDrs9CVKqQSuoNode2E0N6mIJkJKTDgiMVxwpZMtoXUFTiJvtYHBIyEl6qLY6wDpK3Al+BjPwlJKIJP2OyQoOGnIoK5tXPXiohZQEr4AiKGMsU24UjbXhS+nMIhjmcyXWh/dx5VdV3kAioaMQUBYBGAxxCCOZbRZ3/nCD+M7X3gjvt3099+Ivx/0W+Bvff6NkH4T/83Pvx7Sv/u916PpN8DW3309vlH1b/G7+nW4r3/u9Zj0NfC5OvSh7+69FLdnsa/P2J5ZXu+R+obfT++o9x3f/9u8f5uN5vQd5qW5aX5SzxODKEx1UPLjL5E+ruu6ugPAnEOTtg8uAAII0TYtDq7cxJGB3OTICZTI+WV5kcMgQmFvEx3XMK7luroDkJNu4y09LKIwiJA1N6/0GpObOXoCxZUlco4OoshhEKGMqx0Iw2swV3UA2kbk8EvM4hKBRLsyV2Zcy23++AkUl5bIeTqIIodBhCJzJYqjiIzjKq6rOQB9uB5r6UMuim0EUnMDSpQMI+Ma3KJ7oHdqc8s5lv05lggkdGVtmWKRV6BXcQCKBolBQFgEMJNG7W1ES8yqt+DYCeQ8o37YJeZxzK+isERJl174gvUqDsDuJD1ghmqPQYgicnNKlMgr48SbPX8CbY451xKzuEQgoat5YeseYfaizMUfgDbD9CUOD598G29pIPqa2K6TJtBm7UV1nulKFJORngAJXbmmJA9R0EuWiz8AmmQOsUQON6IElw2+yRiDEWead7CZkyfQ5mdvU1uMWBQxIhS5TyWKIhuBy9SLPgB3za7ldwfeec2cABHa9MQJeG4YxCvtMQhxiZx7RInD1135w6sPZ++bvdgD4KFhEN6xxGzYJQIJXcmXKRaJFlSkvfCmZ03A88MgXj/3JXL+ESW4MAggIvkSJbgwCODy5GIPQE6uDuzY6Y11I541qz03d8QEhiEO8OhxnrPmiKd6kSUXeQDa3NKXPu+iN8cgQrH2q0zPZ5XrfvJX3hbvlv7q2+KnBn3Ph94W7/nQ2+Onq/7Mr709mr4X/N4Pvz2k78O/78PviJ/99bm+n9i3OcG8/MpLsa7vIDfoR94R/6LqCbe4s1Tvq/d+D+8/zuPdzEZz0rxm86XjbK4EiNmsi3CMQUJX+pI8REEvTS7yAPSJaVp1anYYRGwtKdXH3JcWl9jdnBiuzFFTuYwzMC4RiFXIXOTVeYGkjrZasq47GW6KhPTlF3wQdKeIEuod41UikNCVuZJxifQRO77M4zLleyK44LEXJRd3ANqM0pfZ/GaTK0N0DK7lrXS2seQyBiANZy0WAiETfh4YA3HGceKlRWtKq91UtLtyQ8Q/IeKe19c+95o76F5Bf/UNrowBo4zkMXhYm+WFOyRZ0l2MvbgD0CelEdVp2WEQsZGbVaIowiBCGYMyLvO4xBSDFdlFRPYLXw1nDpuSOVvMwBGdLCyPVSWhZ5C2IqgGuVdGL7/yDvD9xPeghToGd5jFkEjoSl+oUBRzX1pcYm19lJiuEU/sk6GLOgBtNunLbG5rEyo1YY9BYEqsbUYhG1H4T+RV0snO1lChuKXtZVBE5VREqCbOvNSn6VKLlvM9FFAkJ40o/CR4Ke59ZTO6qVOpPtKX6iPCzxCF/0TIlMir+YyWbdYULXNBsb0Mc1EHYDaScUpgxOndjTAp0wqED+lYB0ZcPfcl8j5ORZHDIImJnU9DdJpomdTNalPFM6WlUjiLsPJtjWMyL/NfqHFnyd/8zmtul6a2UOMKD7qxDoxQXsLPaNQMXlJkLk8v6wAwJIQplShYSfPCu9pyc19idxNKXZh8iaIYgwjtxLCIExhDDEKU0vooGnnFx6jWHFL3qAW6V4UjHfnQ6e5zCIJL/dXPHqB7QoOwkAggIvkSJfLa9cnO7bym5Noyr3nK6GIOwKGZtNxsAxqp6R3ALZW+5AawpqASextFKBgBRNYSINGu8RnM27TssV6L1nU34weB1L1xvom8YuWETZ5h2tq5L2rrbkXWRgA9gDNVws+1U0o4kzKLni64mAMQw0RmAxz4pTG1dPrS25Td4pFYwEmV+foSPQ6ufK4ycSUmHMdf6nNY1Rh191Jt7V8iSoVyhKGCnzvzH4W+yj8GRbvcrAYjhmph+qJbwkb3sXaV6DV652gXfINP6S/nADCFnElawpkkW6ZhtmxpAF+xHQaBjMjBlyiR17IvkXURJbgwCCAlcyVzUIoL/r6y1kO879EAdzbUDQHOCaOEoRh4lmi9Fs596T1LTdpXLGetZHWRvlTvih1zKLdT+gjhRRyAsvaiJJDMdkA44h6WA0OnqElJYIdBIEq0D6gQ7UrmSpSayDiDxmV0nNUa9ZCqqbyV5c5Vj7OYm4yWmBcQncE9LE2QbNBBhks2S4puP0+XIazYzmbIVbhC1+zjuIs4AOMk9SHo1Q8Np+WaV/1MSSCmsl/xX0ui//Hna/zI1+9+6Ef/Vz/7Wvy19QfxV7+d+pd462/9IP6i6lc+84P4ymdejT+v+me/+Wo0/TLYNzrB/Mmnvh9/8skFFT/on4JH/RLxlz79/fjSp1+NLzfl/u1ZTniE/dI6MDsMQk2JnF9ECS4b/I40uvmdtMOWa/1mpIOnMZdxAHj3HFBawpkkW/Y3obSyEm2wpVGbP3oCbWa7fqlBrzGwiagudIERUJnREIMcyg1ljwCf/ACUtZckgWS2gwxlG9W8T19bugAAEABJREFUuF3NXDmwEbsrnnlchvcHIxDl4PwKFZLmhbtW0s6mZzpYoXt+F7zo+MkPwOyF6jSqm6VasJirpB0GyfIOMtzs2gRK/8jLUkkl7TBIVnWQoewCJdracx2YflLz9AegD6P0TdifSM2VIdNxuXvdsGyDCxMo+1yj0qfdrUo27WwToBDK0wJmkmza2bpZ1eMET38AeM86CtC+tH+2HzOtvvnF3Jgc8Vi8YU8gx1PyWyym0gy47cNAZQ22cc1DdWnrOjGApfoh/SjwSQ/A6gBIIHsDWOJakXM2jZn8Cj0VbGg2gTav5mdJBSQQoUVdypmz2V+yQu8XPgDzpAdg9j51CtXNUnvBUHTpv8LsPfuFErM5DvPV4+6EoroeWteLBtB7dTAknwBezAFYn0fJH80xn05xmNZwMMmmXVw81G5wnEDZH1dp+bKfaykypeMJJJd2YhMts5l7TPu0B6BPoYPZu8/YWTAr60Ev6aCnNrAygfd/ZPkP1iyOsJLVrXSs9FA0wJpsrmaqa+xj+qc9ALzpwXdfSC5Q/Pqz3mipnupNhgn0GXUwJReoTJJAEg92icsNGooGuFg/5B8aPvkBWHrBpaEscZc82KX3unQuZ5x2d7aVXX6FheQCtdtyudcjs5d3AJYmtzKU9dKaqU7Ll/5qE/2VJu2vHHn5Ff1VJC+F/rXin/uNl+Jfoj8v/ehL8QvWd8a/+ljqL+L/9cffGdIPfOKdan+S/rtP/2j8+wUVP+oHP/Wj8cFPvSv+rfST74p/U/WX8L/0iXfFB6yn33982GFEnd7jOtFBrxVYZpVZ0JOKF9a/YOrJDsDSHJa4vfftRR3MSpbYJc6LVhKLdCXtbNzhLOPfOVGPHRUvqjVVHPy6WYKLBAKYyx9/4vtz4oRIh9/lS41JLNFLHKVIzVQHsSpLJUvcaoMXmHiyA3DsO5w8mCMXHFU2FA1w59HXMzuFPdSKNeV7l/TaGdAiiOrijz/xPaIXI63nnd2OLsxOJ5bnoke0l3EATpzSUvkStzjHA4VLqeTS7vbLX6F32eNjdVUP+bbKGIOYUj44Ei2Oev3RPT9+/SNfbTV3uzeaZ3u0VLbE9QVL4OQFS03ux13GAVh9hzqh6lbLVhKnLavV1a20NH1EiesOGX/YaSLwSLTL/W0aM/n/9fHvhXRizkUrN1hod3zlzuK+sIOdgqcPL/wAvPgBLW3FErd655OKl7v899/4bnzxle+GWjUNovEQBJdyuBD/hx/7XvxPVPF9Vf9FXz1af+GmS1zL3aK/jQPwALv2AC33vp//9sr/j6ZfBEcU/hOhA/IHHJI/+Oh3439UjUu8ysM/1EPf4TYOwENPqfZ/6P3WIfgiH3693YM4/RbvgzS+0qbbAThh4948ofYSS/W/bVzicz3lM93GAXiAL/MBWj7lPj/MvW9gSLdxAE7Y3qU9W+JWW55UvNrl0RNLv/ovvcoS9+gP+4g3vPADULejulPnctqyWl3doXsdUXJo+aPnfv6jw98i3R++gzuf5/jKnVZ9YQc7BU8fXsYBWJzP+nCWype4xQ4HCpdSyaXd7ffmMr1b9qTx7OOvT3LwsQ8mawPcUtkSR+m6nLxgvdW5mcs4AAee/uQZHbngqLKhaIA7T7ue2Sl89FD/Ep9vesQjHlHiVnF04VnluegR7ZMdgKU5LnF7s+hFHcxKltglzotWEot0Je1s3OEijf6t1V/46P6/Jbr62CuJJXqJyyHUTHXJLdulkiVuefWLZZ/sAKy+xgmTWC+tmeravXZC053rwLTNAmVepuUu7R+D9PHr+UZtzzpy7Vfypdwe14kOllrNuNVgucVq+UMnLu8A8MZLM1ri2iayZE/26jvx5uKyTNdcBtkTjIBrzghzYfKLH88/q6DHmj1vBqJDL57h9C6ZSNtyjjIwlNkJRU26kFygdPtpzYWgJz8AS4Pqs1lILlA52KUEjRbpSlZH1b4s5kYSjHhh+4Mx+gMq+oMqJo8wH/QfeNEfepG+y3/4xX8ARn8ARvrJ6Q/B6A/DqLdU9/nAJ97pP5Cje+vjzyHUm7YHq6HcAiXa2nMdmLZZoMzrfku5JU61uWjfLtbvlz0Y87QHoL99B7MXnbGzYFbWg17SQU+t7wG1SBZ2QFhxdXX99CuneQxCMb+4Gkx5k3eYP/zYd+mrNVJ6UO82eBISIWv7R63MU58ga8BI1lU7jyEbAcxFeb+GRY86lne+ktV1ehEMRQPcKa2Z6naSjxI+7QEYXnF9Bmz2UNdg1qdtXPPJpt3d4GTTtvrmk53ulzHZDnYw4Sj5kY7FY3YZ93/DU8tQ9bDWcqhQrFBYn22Lxe1pFiVdcXV1FNP7ZdFoF3JtMas7HJcYL6yDz/q0hDNZZmcljxJczAFgvn7howYzFB36GIYy9273UNDWucZG7LI6jUEoYLMTZDswAp/S+mZ0nNUhUA9pWyEszZvos1dmundGWIoQADUG1CgCI0LrSgHi/Oy5G+kMfatfcofWLdY3cucejX5s/6QHYHUGJJC9WSxxrcg5m8ZMvtHNT5kJtVxu6P5H1PNeUvNg8xiE6HzRH3JRD6sNvfBIPQPcUwG0xBCDKJxqHE0frfMYhMzUI2OoBWm55vdKSCB7dCOWcuZsWtXkV+ip4AHRkx6A9l6HBpAfZKtM3+qbTzZt42brGqkSMALiY8DeKVmcZSvYNAbJujPtH338e/3LVS+pCV4G6V3NY5DO1ROQ8ZgYcWb3bJbUeWSQNQNu9x+orME2rnmoLm1dJwawVD+kHwU+/QHoU6gbsPjaNddrKeq45qD2Zcr18rGoknYYxNnctP21zmMQ6sgnAPsztRHl35Uxe7rRn/VVDzfjq9azZNwYekIggBTVKGsOgzgx99PzmscgruM26QfbcunTDmnDZNPOekAh1KQFzCTZtLN1s6rHCZ7+AIzvecRMasm4Snvv2DkM4nhpuC2Xno8iK7M0yWQqtsMg5uee9Y0gayiD3ucQ6G970Ectpa2FlvmeAMScTNbwHArQlrPHILBIB4lbmH5/PVWTZFGfUQ3zeaYqo55zNDc918E8/xTRkx+A1VmQQHImHWQo26jmxe1q5urmZpAla5hsS6VPCz3b7PzoGkV/ypBeZoy5zyH435/Mv++HNrMPT7FuJJ/Pwf1FoBkDJCqQtw41jgcz1u3gDKe1w6oOs6bNotMJatLOJunRrtBjyYPiJz8A7e1yEGkb13yydSMyyFTH5CquLvM7tuXmfmctScQr84Mi74hNbgnizMGBbSEQRzIqVay/RU7xOepDQCP1wfUWivP3Ro97Ntez2j0wCBFPbTD0MAtf/ZLzEhLZs0bVQXtxhlNf8zNzKDcrfPDgMg5ATswvm4P1HB0vmVbe/F4NCcR09qsDh0TM5y+rCfcsRYjp2XqYjAGIMYVIbcd9CBCyKcJL/35OZu+2+r9UbVXq5XtyN2MlAMkpYG7EQunyeXqcpMJ9rTk7DELNceuzlnuzYk16TQMqHLHiJ9CLOAA5h4W3J4FkogPCEfeQzQLfKXWtHQZhCWsT8GkR7kh+YNRUPuMMvMymfQAEFCCzXvc5BH/6qe/XX/DpTVdZ3x2AGMronvYyqhuT5toz4p2r7wRGsqKDDJdsltS1Y0EmkqnYzibp0a7QY8mD44s4AO0tcyBpG9d8stPQMybbwYRNYRDInc2G6TxYkjG9E/DpwIIRQEp+XNRk6A+y5eWdByC5XhYS6bX3OQRf+jSHgHurf20tB8P7YXUfXOV4TheKybwSjcpaajKtlFHP1yjr9tf3Baqri6qrqam3SuZ6KDevfIzocg5AmyBvvTt4qFVpy9JPw814WDYSCzipnfWQSG+SzzXVaLdneVVWQk6anw+IxW+iS/+evpYdo1/+9KtuR7debmzjFDzPV2MCPaITjUpPjZLSJIRclwA78kOY9LQ+YwrWhALEWV7f3qaRDp7OXMwBODSPlssB1uE3UrM7gFsqfV3LmozrnrcAXl9MC+0xiDLW8RnMY8ThMo9VrD5S8aPqjv1PalF7qnz5NzkELHJPG3VMlfW9yUuUbs8wxsJWCpAGB78zp1akigM4U6xNoFtrxaLWksXcY5IXcwD80kwFATJErCRjoX1tublnbSXsMIgX58dBXhEkIpQbRYAQYxGAxRCDOJZpfYxlpBQg2Yu4Yde2YOCX/qwu6aPkz3QI1JPq6ox8L5DEPAZRmOrg7vdvfWr59E6VsKPjrofak3nNdO+9wiciLusAjENokxMHRoT8z9P+lU5RI3ex4jXdWdPCuWejGkEfQwwy/xj8pVA71KhAtGqhLcJWjHPV6/+AwwVnmD//zKu6FSuzmfoSmIPRiIzFSTOfz+pYBm21wBQTCQ/asQ6MUE7/BHnvikn4eewvzFzUAWjzSs8wjxhW1tb5EiCsYm2CvhE1zBjbYiD1KfmR1F4kFLc6exkU8QJ51eQK7gkrDmdKOcVScztG/NLf17NTthp+RYeAJohr7GVQpHN6Dj1Q5xpQRcXp8h06DYko3PuFp/POHjZZu9P78JJHy17UAfBb57QM+QbtTWGQjA3qQMFI8rbaaoGaBzqPQYjIGwx5x07VjabGIYmUFtnruaATY/WBSXNV9lVeqlqp8l21ZtD7/H2df/FbP6BT3ln3UeD7AuyrsRPXwICT4rkTZBswQlXtDTuPKw+JULe+nqXkq2RxDZ7eXdwBaPNJz1DXZpQFmT0GZ2XfC32M2sK2NOMsajhzWAjESaLsARCHMy/jWISAq/L5TVEgj9Nt97T9leXOn2h8CGiO+K5ano+QjGznBFDn5VE9zDw2OZnWQMwxWHVVszznICpjocvQizsAHss4pYrtMMhQsj9Y5zEIdeQT5IdRMQlLbjo1jvgMhrxzxEiuxZprtXjloCVWKIt41UrzR4oZcrqXlHs5mvuXXxn+Bjfyp8hf/nb+JNAa35cnancF5mMoiWY+7y3bYlIpLESMM5fP7D5mtSpB1tU8lGMMQoR0sIMJL0Eu8gC0maVfH+7Rm5ONtH/euRp6/rMeMBkDENfZeJkZ5aUEFqdlUPG4vI+zuc48icnPAooy1v9O0P+P6+r6U9xfcQh0DxpOz6DWQ5PMq0IksyUvJDXEIArroaHGUVtTPUUIGfIJ8p5gBL7Wwc5jp7p5anCRB8BDaVNTMGLFazrWjXh3E8ghvUt+FGxkZRS3vL3NtKFCuzUqkXIrpZuzr21nTrW72grucwj++rM/mO7JDRC3ldczKxDWQ7a4cyQQhbVHi6AGWJOQd8g5a+5o+aLTF3sAPDsMwjvzcSbI2YMReLbRgLwj4tGTQ5IBIMb2GMSxTH4MUx/dqOXlnQcgSrEEBInUGAqBdSw+Ac8EibTwKP/+j7yDbufJVz/7mn/11j3Vwd6GZxHBE/j5jCtHHjFjb7OSoyrTzCsBHZOsoe+v1Y4xCAWXJxd7ADSqu4bW8rmZbEZd1PlZDIuIkhpiEIXWWR8xJBEhq7GNtpYEG1wAAAxWSURBVDbVloVI3XSX2qi0awekjsDq97O/fv4h+JvfeY0b+emqaY456f7OVo4YqQzOAXVAfdkOwfYYxJGeEaASuVXN+tX0kyYu+gB4MkwPAbIhCXLgFZNIGWMwYn7upx5KOodBFFpzU6kjMo8Rh4PJD0ZxPkSNpwyHgLUUqwbnTDOKj9W25t6HgBsi9XHz2Vpv8UrYV1LPrbdq3My3QLUjrnGjZj0aqZoL1Is/AG1+6acNdIxBPNb05B1hkgCwnRWnoyZB5mSJEX0LiviIcd5FaoEWCkThWljrCCERr5fnjpVkPYTXNZ8Z7L5Qkj0A45r3ffjt+8VHMl/7nH4SZEP11DIi30dGWJw08zyzAjRjgKQWphtqai553txgJ6+aC9UnPAAnTMRDnepbaI9BnMwNG4bfEmQzxwaBZRW3tL2NMi7Qt5EfOEgpqTMAxFBG2GojJnu0MJ9mityUm+t3fHa15cYOWq/V773HIfj6517nLaZnM6Ip0qBvrft2rgEqeFyssnI8Uc3ZYRAl+j0cyLSE8IXqVRwAzxGDMEYsAphJo3Kz2KSazTiDhrMWm+IkMHcYgJiT8Zo03mDnMKJw5lQndYxRzglw5wEKT1WW9ef6mV87/yfB3/5uPQT1AeTU274aO0g/P17ScOaYawK/nvIzdY4akWBE6KL1Kg6AJtiGmZ4hJ8iNqFh10tw0ahSgGQOQhnMJFgIh078zAzLZm4yxjJnsO4T+1dMxtU0UWzHuj6/L3f8YrHVWmmo5Lu5zCL5RD0Hrpd5+eB5mxulGqPPyqB66xQ5lWIQIZZuxj9nLN1dzADTKtgE5dD7EBIydLBgBpGQtNRnWDcrAOYqRJOhgrkcAJVGEIEU1Un0MUuWkzgKUs0IQYidRfKpOq3W3qjT56Q+d/5Pg737vdbfVc2bHaumbnNN9XtAQzDEBeKh3ROwcNbO4BhfuruoAeJYethFmGDoR37FEyJobOtQMaw0xSF1DHQGSa7HGGKTWQCLqK82vhHXiquL4IrAsUo01Q/eAJloX5WdKoB7jYqh4z70PwfTc6q2e7al8P4LkqEsAk6821mcq7VRgdBXm6g6AR41BcsAAxNgegziWyc1kExWgilve3qZurHeW2spRLqZ954lFVlWZ+8nULKsraj0pduHk3yTWkiWdLaaOVTuUyNSf+tW3KX2WfvPzb+Q6WiHG8nomBcJ6gxZ3jgSi0M+VRpVQJBDA9cjVHQCN1kPGIIRYBGAxxCCOZXIT9WkqQkkigNw45yGQup/UEph3VdY5KR4O5xBoUW3TfmKooBM217c1p/mhmhsgbi+vG9/nEHyLQ6Du6mNvk88q2+4x5muJKJXg9YZ2fk/QVclVHgBNuG1EejYhgVK5EcSIY5ncTOoUSEkiQlZjm7qv7kI9HNJrhN3LIGsFXVCNYtVMCqOg9pxWwa9x1Odvk1JNGaEr6y3soM29+1fO/0nw97//hnuk4V61s+5niNF9lLcnlmSe+ShAxxzh1cjVHgBNODfhvE3zhmHUA6d22mP/6iogTuruFCGiXSejnNQkoOWBplQzqnmM647x4+KKWebe9jYk8Ej85D0OwbfrIVAfva+ekc4WcxjEsUzmh49/TKrgivSqD4DmnJuhbXOUH7Ag6n3BIP5woDLvRdMGKqka5aXGNtk3IZZ1SPZQIQqr5VabSrhuJ68U1J2iuj3dIcawNfyJXz7/J8F3vsB/J+ChEbdr/fVOwiYxmZ9mlzGJK5WrPwCae9uE3Cg2B4Aopf3Lr5ho5HINtY0nKQ4Hk0sUZ4MaTxkfAuVbvVLCo3rtSIC9pnkWAbMM0HJJjMnp/pQ5TdbiGKO1qvqJX/4R8+eY7/yXH3oZ7ex1o4bl2z2EVZCx0PF6aZU3cQA01LYZuTnYFKW0j/o2rNDmZHKNmDwI4lQsxhgj7DqBFtuLQEki/UCQ6kJW7daVgr6WVYSrtaS79DVeYMO6fAdF//weh+D/6BCoCYr4nvbV2MHqGXBXLzdzALQTbVNyk7AQiFJ8IP7+bcg4VkJ5qRKdB4jDqcQqbM7AlHtkmNY9KEL6gVAmq8+zWj/rp6DeWZ+88601gdLSf/afz/9J8H//6w99B7VVL78MDO1FZWh0/eamDoC2IzdMn6IiKZ9J2zlCQ5uxBiyuLjaklj33ZvdYHOrYpgbVNYpuE0PPvd/NoRA6ex/ENakHqQpTEbeQVML9FFcV/eMcgh//Tz8S0h/Dp741fuw/vjX+6aD/BGz9D2+Nf1xVbdQz36Vamian7G3ozR0AbQv75B2TlyrQxiVWRJUCFPEHBWOvuqzg4EAqnwlYAgQ2RdhqAydfneBc1W/O0HGxOitl9ytY0Ek9a+toHuPYJoMG26K2hmx7rZZy3HkthJGTAiVK35Te5AHQDrVN61jbB6kPoHGEe5vvHImsA7AurTIogXI4MsRVWuwcgbwLwPa7dcQttetJpQwJ9etKVimcRdhqY8q3VNhesK3NbLKtSHVS5VRnHtM4oETpm9NHPACPPzttoDeUWwvntvMrawawjQHCIbON1lppq2p5eRcClMc5pMtMGm+Pce0pnm6UH+7dCvCIa+X7MxPovrSyELpGpmNnWCFCCdQQXmsbJrw5uekD0HZLm8ieSqxsdf/n714joJ1GkVonkmqI7AFwhkNEqkWV6j1V23PU3VdaL/clkO/3pDmUQ540IwoQPw+EpddUIOcEZqqd3ksNxZO+aXkWB0A76A23yc8kLRsOh6hEe261gUQMncQ4xvjDSGMWynXNQ7b2/ghVOlMKWu2eh5jVEvfmC+vGG/V11DVpy1uPHlNgLFOThvAKO1Z8w/psDoD2UJuqj6RtsGJ/QJCIaJXZKydOgbxjZ9M4xjgno8Kq0BW5e8e5ErtWIJ60RHBJx46z313Soqp9XQV6vApdYTyZ6fngWq0Ln4F5Vgeg7Sf77F+ZtfPGToDYfUS0GRnYjCuoLjkVVPU6kukrcBW4en7egGTHz3gXKz+t6Vkazz54ldR7yylsyk28rMcqQB1PppVlLTxC1fOSZ3kA2hZ7w238DfiDMPLHZtRKnVMpqUwQIBPfKxM4h1H9m3uej5xEftC7mPZ79XDZtltK5veuBG0734qdmsw8D4+00mfnn/UB0G5r8/XR+KuAcIz3J0cCyZ8W5tK0GuW8rhLVjVQuuKdd7DuQeo4Wjrcy74RNfy7XQDnv4PmaZ38A2tbzPeSHLgApJ/VB4NPJX62JkqQiRWHXDshV3D6yGtKJHlP67nhh4W5P2nVxjjV63nYnQt/HRQSucbCZ7QDsfAN8H9NBIED88cj3D4ovCHFd8lMTxXu6R1B/BOd7LJRCdXEbjGtl6tNCVURpDZQWhNmkTmA7AHUQu04fitUmsw3Kt8OgU+APC9I+S/cs6f5BHov3mkB4Lcb3wuv+7Vkc1hqcadcRKIfbZGcC2wHYGchSqI/HH5JBVjSYPm374vSPH61+z7N8qF4+FBTsrTNn0zvwX59n60m0R/C5oNrUU5pLv/d2AE7cIX1U7ePsXx89zM/8PjP/Osm3Rru+N6am4t2PXRlu55Yq6S1MbubYCWwH4NhJLdTpI7Ri9AHqQ+xKPXQP74tp1z92NdX9rCTUG7fJGRPYDsAZQ1tbog+xK8AfaPX6aE/Vcb0xN6ad2wA3eQET2A7ACxjiMS3ah3uKP6bvVnO/CWwH4H7z21Zf+QQe8ABc+WS2x38WE9gOwLPY5u0l1yawHYC1yWz8s5jAdgCexTZvL7k2gbe8+r3/V9aSG79N4NYnsP0EeIgd3npezQS2A3A1W7U96ENMYDsADzHVrefVTGA7AFezVduDPsQEtgPwEFPdel7NBHwAtt8Jupr9uvgHvaYH1HfvA3BND7096zaBFzmB7QC8yGluva5uAv0A6MfB1T399sDbBM6cQPve+wE4s8+2bJvAVU9gdgDaqbjqN9oefpvAHRMYv/PZAbhj3R3pLb1N4PomsHcAxtNxfa+zPfE2gcMT2P2+9w6Alu8Widt0m8C1T2Dpu148AHrRpWLxm24TuMYJrH3PqwdAL7m2SLlNtwlcywQOfccHD4Be8NBi5TeNiG0IFzuBu77fOw+A3uyuJqrZdJvApU3gmO/2qAOgFzummeo23SZwCRM49ns9+gDopdRUKrzpNoFLnIC+T+mxz3bSAWhNdQNpize/TeCpJ6DvUXrqc5x1ANpNdMOmjdv885rAU75t+/bkz32OfwAAAP//vhcaOAAAAAZJREFUAwDlwsfbUFLSnwAAAABJRU5ErkJggg==';

  const PdfGenerator = {
  formatFilename(title, date) {
    const rawTitle = (title || 'Outing').trim();
    const sanitizedTitle = rawTitle.replace(/[^a-zA-Z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || 'Outing';
    const rawDate = (date || new Date().toISOString().split('T')[0]).trim();
    const sanitizedDate = rawDate.replace(/[^a-zA-Z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || 'date';
    return `HisabMate_${sanitizedTitle}_${sanitizedDate}.pdf`;
  },

  preparePdfData(outing, settlementResult) {
    const title = outing.title || 'Untitled Outing';
    const date = outing.date || 'Not specified';
    const squad = outing.squad || [];
    const expenses = outing.expenses || [];

    let memberTotals = (settlementResult && settlementResult.memberTotals);
    let totalSpendPaise = (settlementResult && settlementResult.totalSpendPaise);
    if (!memberTotals || Object.keys(memberTotals).length === 0 || totalSpendPaise === undefined || totalSpendPaise === 0) {
      const computed = Ledger.computeBalances(squad, expenses);
      if (!memberTotals || Object.keys(memberTotals).length === 0) memberTotals = computed.memberTotals;
      if (totalSpendPaise === undefined || totalSpendPaise === 0) totalSpendPaise = computed.totalSpendPaise;
    }
    memberTotals = memberTotals || {};
    totalSpendPaise = totalSpendPaise || 0;

    let transactions = (settlementResult && settlementResult.transactions);
    if (!transactions) {
      const solved = SettlementSolver.solve(memberTotals);
      transactions = solved.transactions;
    }

    // Participant Financial Summary
    let sumPaidPaise = 0;
    let sumConsumedPaise = 0;
    let sumNetPaise = 0;

    const participants = squad.map(member => {
      const info = memberTotals[member.name] || { paidPaise: 0, consumedPaise: 0, netPaise: 0 };
      sumPaidPaise += info.paidPaise;
      sumConsumedPaise += info.consumedPaise;
      sumNetPaise += info.netPaise;

      let status = 'Settled';
      let statusType = 'settled';
      if (info.netPaise > 0) {
        status = `Receives ${Money.formatINR(info.netPaise)}`;
        statusType = 'creditor';
      } else if (info.netPaise < 0) {
        status = `Owes ${Money.formatINR(Math.abs(info.netPaise))}`;
        statusType = 'debtor';
      }

      return {
        name: member.name,
        upi: member.upi || '',
        paidPaise: info.paidPaise,
        paidRupees: Money.formatINR(info.paidPaise),
        consumedPaise: info.consumedPaise,
        consumedRupees: Money.formatINR(info.consumedPaise),
        netPaise: info.netPaise,
        netRupees: (info.netPaise > 0 ? '+' : (info.netPaise < 0 ? '-' : '')) + Money.formatINR(Math.abs(info.netPaise)),
        status,
        statusType
      };
    });

    // Itemized Expenses
    const expenseRows = expenses.map((exp, idx) => {
      let splitDetails = '';
      if (exp.allocations && Object.keys(exp.allocations).length > 0) {
        const allocParts = Object.entries(exp.allocations).map(([name, paise]) => `${name}: ${Money.formatINR(paise)}`);
        const excluded = squad.filter(m => !exp.allocations[m.name]).map(m => m.name);
        splitDetails = `Custom Split: ${allocParts.join(', ')}`;
        if (excluded.length > 0) {
          splitDetails += `\n(Excluded: ${excluded.join(', ')})`;
        }
      } else {
        const included = exp.included || [];
        const excluded = squad.filter(m => !included.includes(m.name)).map(m => m.name);
        if (excluded.length === 0) {
          splitDetails = `Shared equally by all ${squad.length} members`;
        } else {
          splitDetails = `Shared by ${included.join(', ')}`;
          if (excluded.length > 0) {
            splitDetails += `\n(Excluded: ${excluded.join(', ')})`;
          }
        }
      }

      return {
        index: idx + 1,
        description: exp.description || 'Expense',
        payer: exp.payer,
        amountPaise: exp.amountPaise,
        amountRupees: Money.formatINR(exp.amountPaise),
        splitDetails
      };
    });

    // Settlement Transfers
    const transfers = transactions.map((tx, idx) => {
      const isSettled = outing.settlementRecords && outing.settlementRecords[tx.id] && outing.settlementRecords[tx.id].status === 'marked_paid';
      return {
        index: idx + 1,
        from: tx.from,
        to: tx.to,
        amountRupees: `₹${tx.amountRupees}`,
        amountPaise: tx.amountPaise,
        creditorUpi: tx.creditorUpi || '',
        status: isSettled ? 'Marked Paid' : 'Pending Payment'
      };
    });

    // Reconciliation Invariants
    const isConservationValid = (sumPaidPaise === sumConsumedPaise) && (sumPaidPaise === totalSpendPaise);
    const isZeroDriftValid = Math.abs(sumNetPaise) === 0;
    const isReconciled = isConservationValid && isZeroDriftValid;

    return {
      title,
      date,
      totalSpendPaise,
      totalSpendRupees: Money.formatINR(totalSpendPaise),
      participantCount: squad.length,
      expenseCount: expenses.length,
      participants,
      expenseRows,
      transfers,
      sumPaidPaise,
      sumConsumedPaise,
      sumNetPaise,
      isConservationValid,
      isZeroDriftValid,
      isReconciled,
      generatedAt: new Date().toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    };
  },

    buildPdfDocument(outing, settlementResult, jsPdfLib, autoTablePlugin) {
    let JsPdfClass = jsPdfLib;
    if (!JsPdfClass && typeof window !== 'undefined') {
      if (window.jspdf && window.jspdf.jsPDF) {
        JsPdfClass = window.jspdf.jsPDF;
      } else if (typeof window.jsPDF === 'function') {
        JsPdfClass = window.jsPDF;
      } else if (typeof jsPDF === 'function') {
        JsPdfClass = jsPDF;
      }
    }
    if (!JsPdfClass) {
      throw new Error('jsPDF library is not loaded. Cannot generate PDF bill.');
    }

    const data = this.preparePdfData(outing, settlementResult);
    const doc = new JsPdfClass({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      putOnlyUsedFonts: true
    });

    let autoTable = autoTablePlugin;
    if (!autoTable) {
      if (typeof doc.autoTable === 'function') {
        autoTable = (d, opts) => d.autoTable(opts);
      } else if (typeof window !== 'undefined') {
        if (typeof window.autoTable === 'function') {
          autoTable = window.autoTable;
        } else if (window.jspdf && typeof window.jspdf.autoTable === 'function') {
          autoTable = window.jspdf.autoTable;
        }
      }
    }
    if (!autoTable) {
      throw new Error('jspdf-autotable plugin is required for PDF bill generation.');
    }

    // Commercial currency formatter: zero glyph corruption, right-alignable
    const formatPdfCurrency = (paise) => {
      const num = (Number(paise) || 0) / 100;
      const absNum = Math.abs(num);
      const formatted = absNum.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      return (num < 0 ? '-Rs. ' : 'Rs. ') + formatted;
    };

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 14;
    const contentWidth = pageWidth - (margin * 2);

    let curY = 13;

    const checkPageBreak = (neededHeight) => {
      if (curY + neededHeight > pageHeight - 16) {
        doc.addPage();
        curY = 14;
      }
    };

    // Commercial Statement Reference ID
    const dateCode = (data.date !== 'Not specified' ? data.date : '20261024').replace(/[^0-9]/g, '').slice(0, 8) || '20261024';
    const hash = Math.abs((data.title || 'Outing').split('').reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0) % 9000 + 1000);
    const statementRef = `HM-${dateCode}-${hash}`;

    // --- BRAND HEADER WITH OFFICIAL LOGO & TAGLINE ---
    let titleStartX = margin;
    try {
      if (typeof doc.addImage === 'function' && typeof HISABMATE_LOGO_DATA_URI !== 'undefined') {
        doc.addImage(HISABMATE_LOGO_DATA_URI, 'PNG', margin, 11, 13.5, 13.5);
        titleStartX = margin + 16;
      }
    } catch (e) {
      titleStartX = margin;
    }

    // Line 1: Brand Name
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.setTextColor(15, 23, 42); // slate obsidian
    doc.text('HisabMate', titleStartX, 15.8);

    // Line 2: Tagline nestled right below brand name
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139); // slate 500
    doc.text('“HisabMate hai, toh sab sorted hai.”', titleStartX, 19.8);

    // Line 3: Document Subtitle (Clean: Expense Settlement Statement)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(51, 65, 85); // slate 700
    doc.text('Expense Settlement Statement', titleStartX, 24.5);

    // Line 4: Outing Name
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(180, 83, 9); // amber 700
    doc.text(`Outing: ${data.title}`, titleStartX, 28.8);

    // Right: Statement Metadata Block
    const rightX = pageWidth - margin;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    const refText = `Statement Ref: ${statementRef}`;
    const outingDateText = `Outing Date: ${data.date}`;
    const genDateText = `Billing Date: ${data.generatedAt}`;

    doc.text(refText, rightX - doc.getTextWidth(refText), 15.8);
    doc.text(outingDateText, rightX - doc.getTextWidth(outingDateText), 20.2);
    doc.text(genDateText, rightX - doc.getTextWidth(genDateText), 24.5);

    curY = 32;

    // Thin Accent Line
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.35);
    doc.line(margin, curY, pageWidth - margin, curY);
    curY += 4;

    // --- EXECUTIVE KPI STRIP (4 METRICS) ---
    const kpiBoxHeight = 15;
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(margin, curY, contentWidth, kpiBoxHeight, 1.2, 1.2, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(margin, curY, contentWidth, kpiBoxHeight, 1.2, 1.2, 'S');

    const colW = contentWidth / 4;
    const kpiY = curY + 5;

    // KPI 1: Total Spend
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(100, 116, 139);
    doc.text('TOTAL EXPENDITURE', margin + 3.5, kpiY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(180, 83, 9); // amber 700
    doc.text(formatPdfCurrency(data.totalSpendPaise), margin + 3.5, kpiY + 4.5);

    // KPI 2: Participants
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(100, 116, 139);
    doc.text('REGISTERED MEMBERS', margin + colW + 3.5, kpiY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(`${data.participantCount} Participants`, margin + colW + 3.5, kpiY + 4.5);

    // KPI 3: Expense Items
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(100, 116, 139);
    doc.text('RECORDED EXPENSES', margin + (colW * 2) + 3.5, kpiY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(`${data.expenseCount} Transactions`, margin + (colW * 2) + 3.5, kpiY + 4.5);

    // KPI 4: Audit Status
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(100, 116, 139);
    doc.text('AUDIT RECONCILIATION', margin + (colW * 3) + 3.5, kpiY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    if (data.isReconciled) {
      doc.setTextColor(21, 128, 61); // emerald 700
      doc.text('100% Balanced (Zero Drift)', margin + (colW * 3) + 3.5, kpiY + 4.5);
    } else {
      doc.setTextColor(185, 28, 28); // rose 700
      doc.text('Review Needed', margin + (colW * 3) + 3.5, kpiY + 4.5);
    }

    curY += kpiBoxHeight + 5;

    // --- SECTION 1: PARTICIPANT ACCOUNTS & BALANCES ---
    checkPageBreak(25);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text('1. Participant Accounts & Individual Balances', margin, curY);
    curY += 2.2;

    const partRows = data.participants.map(p => {
      let cleanStatus = 'Fully Settled';
      if (p.statusType === 'creditor') {
        cleanStatus = `Receives ${formatPdfCurrency(p.netPaise)}`;
      } else if (p.statusType === 'debtor') {
        cleanStatus = `Owes ${formatPdfCurrency(Math.abs(p.netPaise))}`;
      }

      return [
        p.upi ? `${p.name}\n(UPI: ${p.upi})` : p.name,
        formatPdfCurrency(p.paidPaise),
        formatPdfCurrency(p.consumedPaise),
        (p.netPaise > 0 ? '+' : '') + formatPdfCurrency(p.netPaise),
        cleanStatus
      ];
    });

    const partFoot = [
      [
        'TOTALS',
        formatPdfCurrency(data.sumPaidPaise),
        formatPdfCurrency(data.sumConsumedPaise),
        formatPdfCurrency(data.sumNetPaise),
        data.isReconciled ? 'Balanced (0.00 Variance)' : 'Discrepancy'
      ]
    ];

    autoTable(doc, {
      startY: curY,
      margin: { left: margin, right: margin, top: 14, bottom: 16 },
      head: [['Participant / Member', 'Total Paid', 'Share (Consumed)', 'Net Balance', 'Settlement Status']],
      body: partRows,
      foot: partFoot,
      theme: 'grid',
      headStyles: {
        fillColor: [30, 41, 59], // slate 800
        textColor: [255, 255, 255],
        fontSize: 7.5,
        fontStyle: 'bold',
        cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2.5 }
      },
      footStyles: {
        fillColor: [241, 245, 249], // slate 100
        textColor: [15, 23, 42],
        fontSize: 7.2,
        fontStyle: 'bold',
        cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2.5 }
      },
      styles: {
        font: 'helvetica',
        fontSize: 7.2,
        cellPadding: { top: 1.5, bottom: 1.5, left: 2.5, right: 2.5 },
        lineColor: [226, 232, 240],
        lineWidth: 0.2
      },
      columnStyles: {
        0: { cellWidth: 44, halign: 'left', fontStyle: 'bold' },
        1: { cellWidth: 32, halign: 'right' },
        2: { cellWidth: 32, halign: 'right' },
        3: { cellWidth: 34, halign: 'right', fontStyle: 'bold' },
        4: { cellWidth: 40, halign: 'center' }
      },
      didParseCell: (hookData) => {
        if (hookData.section === 'body') {
          const rowData = data.participants[hookData.row.index];
          if (rowData) {
            if (hookData.column.index === 3 || hookData.column.index === 4) {
              if (rowData.statusType === 'creditor') {
                hookData.cell.styles.textColor = [21, 128, 61]; // emerald 700
                hookData.cell.styles.fontStyle = 'bold';
              } else if (rowData.statusType === 'debtor') {
                hookData.cell.styles.textColor = [180, 83, 9]; // amber 700
                hookData.cell.styles.fontStyle = 'bold';
              }
            }
          }
        }
      }
    });

    curY = doc.lastAutoTable.finalY + 5;

    // --- SECTION 2: ITEMIZED EXPENSE LEDGER ---
    checkPageBreak(25);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text('2. Itemized Expense Ledger', margin, curY);
    curY += 2.2;

    const expRows = data.expenseRows.map(e => {
      const cleanDetails = e.splitDetails.replace(/₹/g, 'Rs. ');
      return [
        e.index,
        e.description,
        e.payer,
        formatPdfCurrency(e.amountPaise),
        cleanDetails
      ];
    });

    const expFoot = [[
      '',
      'Total Expenditure',
      '',
      formatPdfCurrency(data.totalSpendPaise),
      `${data.expenseRows.length} item(s) accounted`
    ]];

    autoTable(doc, {
      startY: curY,
      margin: { left: margin, right: margin, top: 14, bottom: 16 },
      head: [['#', 'Expense Item', 'Paid By', 'Amount', 'Allocation & Exclusions']],
      body: expRows,
      foot: expFoot,
      theme: 'grid',
      headStyles: {
        fillColor: [30, 41, 59],
        textColor: [255, 255, 255],
        fontSize: 7.5,
        fontStyle: 'bold',
        cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2.5 }
      },
      footStyles: {
        fillColor: [241, 245, 249],
        textColor: [15, 23, 42],
        fontSize: 7.2,
        fontStyle: 'bold',
        cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2.5 }
      },
      styles: {
        font: 'helvetica',
        fontSize: 7.2,
        cellPadding: { top: 1.5, bottom: 1.5, left: 2.5, right: 2.5 },
        lineColor: [226, 232, 240],
        lineWidth: 0.2
      },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center' },
        1: { cellWidth: 44, halign: 'left' },
        2: { cellWidth: 26, halign: 'left', fontStyle: 'bold' },
        3: { cellWidth: 32, halign: 'right', fontStyle: 'bold', textColor: [180, 83, 9] },
        4: { cellWidth: 70, halign: 'left' }
      }
    });

    curY = doc.lastAutoTable.finalY + 5;

    // --- SECTION 3: SETTLEMENT PLAN & PAYMENT INSTRUCTIONS ---
    checkPageBreak(22);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text('3. Settlement Plan & UPI Payment Instructions', margin, curY);
    curY += 2.2;

    if (data.transfers.length === 0) {
      doc.setFillColor(248, 250, 252);
      doc.roundedRect(margin, curY, contentWidth, 9, 1, 1, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(margin, curY, contentWidth, 9, 1, 1, 'S');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(71, 85, 105);
      doc.text('All member accounts are fully settled. No inter-participant payments are required.', margin + 3.5, curY + 5.5);
      curY += 12;
    } else {
      let totalTransferPaise = 0;
      const txRows = data.transfers.map(t => {
        totalTransferPaise += t.amountPaise;
        return [
          t.index,
          t.from,
          t.to,
          formatPdfCurrency(t.amountPaise),
          t.creditorUpi || 'Manual / Cash Settlement',
          t.status
        ];
      });

      const txFoot = [
        [
          '',
          'Total Settlements',
          '',
          formatPdfCurrency(totalTransferPaise),
          `${data.transfers.length} transfer(s) resolve all dues`,
          ''
        ]
      ];

      autoTable(doc, {
        startY: curY,
        margin: { left: margin, right: margin, top: 14, bottom: 16 },
        head: [['#', 'Payer (Debtor)', 'Payee (Creditor)', 'Amount Due', 'Creditor UPI ID', 'Payment Status']],
        body: txRows,
        foot: txFoot,
        theme: 'grid',
        headStyles: {
          fillColor: [30, 41, 59],
          textColor: [255, 255, 255],
          fontSize: 7.5,
          fontStyle: 'bold',
          cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2.5 }
        },
        footStyles: {
          fillColor: [241, 245, 249],
          textColor: [15, 23, 42],
          fontSize: 7.2,
          fontStyle: 'bold',
          cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2.5 }
        },
        styles: {
          font: 'helvetica',
          fontSize: 7.2,
          cellPadding: { top: 1.5, bottom: 1.5, left: 2.5, right: 2.5 },
          lineColor: [226, 232, 240],
          lineWidth: 0.2
        },
        columnStyles: {
          0: { cellWidth: 10, halign: 'center' },
          1: { cellWidth: 34, halign: 'left', fontStyle: 'bold' },
          2: { cellWidth: 34, halign: 'left', fontStyle: 'bold' },
          3: { cellWidth: 32, halign: 'right', textColor: [180, 83, 9], fontStyle: 'bold' },
          4: { cellWidth: 42, halign: 'left' },
          5: { cellWidth: 30, halign: 'center' }
        }
      });

      curY = doc.lastAutoTable.finalY + 5;
    }

    // --- SECTION 4: AUDIT RECONCILIATION CERTIFICATE ---
    checkPageBreak(18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text('4. Statement Reconciliation & Audit Certification', margin, curY);
    curY += 2.2;

    const certBoxHeight = 12.5;
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(margin, curY, contentWidth, certBoxHeight, 1.2, 1.2, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(margin, curY, contentWidth, certBoxHeight, 1.2, 1.2, 'S');

    // Left Audit Text
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(21, 128, 61); // emerald 700
    doc.text('OFFICIAL DOUBLE-ENTRY RECONCILIATION CERTIFIED', margin + 3.5, curY + 4);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(71, 85, 105);
    const certDetail1 = `Funds Conservation: Total Paid (${formatPdfCurrency(data.sumPaidPaise)}) = Total Consumed (${formatPdfCurrency(data.sumConsumedPaise)}) with zero variance (Rs. 0.00).`;
    const certDetail2 = `Settlement Integrity: Executing the ${data.transfers.length} settlement transfer(s) clears 100% of inter-member debts, bringing every account to Rs. 0.00.`;
    doc.text(certDetail1, margin + 3.5, curY + 7.5);
    doc.text(certDetail2, margin + 3.5, curY + 10.5);

    // Right Certification Stamp Badge
    const stampWidth = 32;
    const stampX = pageWidth - margin - stampWidth - 3;
    const stampY = curY + 2.5;
    doc.setFillColor(240, 253, 244); // green 50
    doc.setDrawColor(187, 247, 208); // green 200
    doc.roundedRect(stampX, stampY, stampWidth, 7.5, 1, 1, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(21, 128, 61); // green 700
    doc.text('AUDIT PASSED', stampX + (stampWidth / 2) - (doc.getTextWidth('AUDIT PASSED') / 2), stampY + 4.8);

    // --- TWO-PASS FOOTER ---
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);

      // Divider line
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.3);
      doc.line(margin, pageHeight - 11, pageWidth - margin, pageHeight - 11);

      // Left brand signature
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 116, 139);
      doc.text('HisabMate • Hisab sorted, dosti intact', margin, pageHeight - 6.5);

      // Right text
      const footerRight = `Made with love for Indian outings.  •  Page ${i} of ${totalPages}`;
      const textWidth = doc.getTextWidth(footerRight);
      doc.text(footerRight, pageWidth - margin - textWidth, pageHeight - 6.5);
    }

    return doc;
  },

  downloadPdf(outing, settlementResult, jsPdfLib, autoTablePlugin) {
    const doc = this.buildPdfDocument(outing, settlementResult, jsPdfLib, autoTablePlugin);
    const filename = this.formatFilename(outing.title, outing.date);
    doc.save(filename);
    return { doc, filename };
  }
};

  // Export module public interface
  return {
    Money,
    Parser,
    Ledger,
    SettlementSolver,
    SettlementTracker,
    Storage,
    UPI,
    PdfGenerator
  };
});


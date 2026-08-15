import { describe, expect, it } from "vitest";

import { NAME_MATCH_MIN_SCORE } from "@/lib/constants/kyc";
import { compareNames, lowestPairScore, normaliseName, roundScore } from "@/lib/kyc/names";

/**
 * SPEC §6: "penny-drop returns the real account holder name; PAN API returns the
 * registered name. Both compared automatically" — and "name mismatch = blocked,
 * no override".
 *
 * This file is the specification of where that line falls, because nothing else
 * is. The spec says a mismatch blocks and says nothing about what counts as one,
 * so every pair below is a judgement written down: the first block is names that
 * MUST pass, and every one of them is a real way an Indian name differs between
 * a form, a bank ledger and the PAN registry. The second block is names that
 * must NOT, and each is a case where letting it through means paying a stranger.
 *
 * Both blocks assert against the shipped threshold rather than a number of their
 * own. Moving `kyc.name_match_min_bps` without moving the matcher will fail here
 * and name the pair it broke — which is the point, since the failure mode in
 * production is silent and permanent.
 */

const PASS = NAME_MATCH_MIN_SCORE;

/** Every pair here is one person. A false negative ends their account. */
const SAME_PERSON: [string, string, string][] = [
  ["identical", "Rajesh Kumar", "RAJESH KUMAR"],
  ["case and spacing", "  priya   sharma ", "Priya Sharma"],
  ["reversed order", "Rajesh Kumar", "KUMAR RAJESH"],
  ["leading initial", "Rajesh Kumar", "R KUMAR"],
  ["dotted initials with a surname", "Rajesh Kumar Sharma", "R. K. SHARMA"],
  ["honorific on the bank side", "Priya Sharma", "SMT. PRIYA SHARMA"],
  ["honorific on the form side", "Dr. Anita Desai", "ANITA DESAI"],
  ["extra surname in the ledger", "Rajesh Kumar", "RAJESH KUMAR VERMA"],
  ["extra middle name on the form", "Rajesh Mohan Kumar", "RAJESH KUMAR"],
  ["truncated ledger field", "Venkateswara Rao", "VENKATESWARA RA"],
  ["joined given name", "Sri Ram Iyer", "SRIRAM IYER"],
  ["joined both ways", "Venkataraman Iyer", "VENKATA RAMAN IYER"],
  ["gendered suffix", "Sunita Kumari", "SUNITA KUMAR"],
  ["transliteration", "Mohammed Ali", "MOHAMMAD ALI"],
  ["transliteration, second form", "Lakshmi Narayanan", "LAXMI NARAYANAN"],
  ["diacritics", "Bālājī Subramanian", "BALAJI SUBRAMANIAN"],
  ["punctuation in the ledger", "Rajesh Kumar", "RAJESH-KUMAR"],
  ["mononym both sides", "Nandita", "NANDITA"],
  ["mononym against a full name", "Anushka", "ANUSHKA SHARMA"],
];

/** Every pair here is two people, or too little to tell them apart. */
const DIFFERENT_PEOPLE: [string, string, string][] = [
  ["different given name", "Rajesh Kumar", "SURESH KUMAR"],
  ["different surname", "Rajesh Kumar", "RAJESH SHARMA"],
  ["shared surname only", "Rajesh Kumar", "PRIYA KUMAR"],
  ["initials alone", "Rajesh Kumar", "R K"],
  ["initials alone, three parts", "Rajesh Kumar Sharma", "R K S"],
  ["nothing in common", "Rajesh Kumar", "ANITA DESAI"],
  ["a company, not a person", "Rajesh Kumar", "ACME TRADING PRIVATE LIMITED"],
  ["one letter off in both parts", "Rajesh Kumar", "RAJESH KAPOOR"],
  ["a title and nothing else", "Rajesh Kumar", "MR"],
  ["empty against a name", "", "RAJESH KUMAR"],
];

describe("compareNames", () => {
  for (const [label, declared, provider] of SAME_PERSON) {
    it(`accepts ${label}: "${declared}" vs "${provider}"`, () => {
      expect(compareNames(declared, provider)).toBeGreaterThanOrEqual(PASS);
    });
  }

  for (const [label, declared, provider] of DIFFERENT_PEOPLE) {
    it(`refuses ${label}: "${declared}" vs "${provider}"`, () => {
      expect(compareNames(declared, provider)).toBeLessThan(PASS);
    });
  }

  it("is symmetric — which side a name arrived from cannot change the outcome", () => {
    for (const [, declared, provider] of [...SAME_PERSON, ...DIFFERENT_PEOPLE]) {
      expect(compareNames(declared, provider)).toBeCloseTo(
        compareNames(provider, declared),
        10,
      );
    }
  });

  it("scores an exact match at 1 and an empty name at 0", () => {
    expect(compareNames("Rajesh Kumar", "Rajesh Kumar")).toBe(1);
    expect(compareNames("   ", "Rajesh Kumar")).toBe(0);
    expect(compareNames("123456", "Rajesh Kumar")).toBe(0);
  });
});

describe("normaliseName", () => {
  it("strips accents, punctuation and case", () => {
    expect(normaliseName("  Dr. Bālājī  S/O Subramanian ")).toEqual([
      "BALAJI",
      "S",
      "O",
      "SUBRAMANIAN",
    ]);
  });

  it("keeps an honorific when it is the only thing there", () => {
    // Otherwise the name normalises to nothing, nothing compares to nothing at
    // 1, and "SMT" verifies against every account in the country.
    expect(normaliseName("Smt.")).toEqual(["SMT"]);
  });
});

describe("lowestPairScore", () => {
  it("returns null when there is nothing to compare", () => {
    expect(lowestPairScore(["Rajesh Kumar"])).toBeNull();
    expect(lowestPairScore(["Rajesh Kumar", null, "  "])).toBeNull();
    expect(lowestPairScore([])).toBeNull();
  });

  it("takes the worst pair, not the average", () => {
    // The declared name agrees with both providers; the providers do not agree
    // with each other. That is a bank account and a PAN belonging to two
    // different people, and averaging would hide it.
    const score = lowestPairScore(["R Kumar", "RAJESH KUMAR", "RAKESH KUMAR"]);

    expect(score).not.toBeNull();
    expect(score as number).toBeLessThan(PASS);
  });

  it("passes when all three agree", () => {
    const score = lowestPairScore([
      "Rajesh Kumar Sharma",
      "RAJESH KUMAR SHARMA",
      "R K SHARMA",
    ]);

    expect(score).not.toBeNull();
    expect(score as number).toBeGreaterThanOrEqual(PASS);
  });

  it("ignores a provider that returned nothing rather than scoring it as a mismatch", () => {
    expect(lowestPairScore(["Rajesh Kumar", "RAJESH KUMAR", null])).toBe(1);
  });
});

describe("roundScore", () => {
  it("fits the three decimals worker_kyc.name_match_score stores", () => {
    expect(roundScore(0.9166666)).toBe(0.917);
    expect(roundScore(1)).toBe(1);
    expect(roundScore(0)).toBe(0);
  });
});

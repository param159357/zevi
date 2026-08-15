/**
 * Comparing a declared name against the names two providers hand back.
 *
 * Spec §6: "penny-drop returns the real account holder name; PAN API returns the
 * registered name. Both compared automatically" — and "name mismatch = blocked,
 * no override".
 *
 * That last clause is why this module is pure, separate, and tested. It is the
 * only code on the platform whose false negative is *permanent*: a worker this
 * function scores 0.83 loses their account with no appeal, and nobody gets to
 * look at the two strings and say "those are obviously the same person". So the
 * job here is not "are these strings similar" — it is "does this difference
 * still describe one human being", against the ways Indian names actually vary
 * between an ID, a bank ledger and a form field:
 *
 *   order        KUMAR RAJESH        ·  Rajesh Kumar
 *   initials     R K SHARMA          ·  Rajesh Kumar Sharma
 *   honorifics   SMT. PRIYA SHARMA   ·  Priya Sharma
 *   extra parts  RAJESH KUMAR        ·  Rajesh Kumar Verma
 *   spacing      SRIRAM IYER         ·  Sri Ram Iyer
 *   suffixes     KUMARI              ·  Kumar
 *   diacritics   BALAJI              ·  Bālājī
 *
 * Every one of those must pass. RAJESH KUMAR against SURESH KUMAR must not, and
 * neither must a name that shares only its initials, because "R K" matches most
 * of the country.
 *
 * ---------------------------------------------------------------------------
 * The shape of the answer
 *
 * `compareNames` returns 0–1 and takes no view on where the line is;
 * `lowestPairScore` reduces however many names arrived to the single worst
 * agreement among them. The threshold lives in `platform_settings`
 * (`kyc.name_match_min_bps`) so it can be moved without a deploy, and the score
 * this returns is what gets written to `worker_kyc.name_match_score` — the
 * number that made the decision, kept beside the decision.
 */

/**
 * Titles that carry no identity. Stripped only when something is left over, so
 * a bank record that genuinely reads "SRI" is compared rather than emptied.
 *
 * Kept short on purpose. Every entry is a token that could otherwise be a real
 * name somewhere in India, and the cost of over-stripping is two different
 * people scoring as one.
 */
const HONORIFICS = new Set([
  "MR",
  "MRS",
  "MS",
  "MISS",
  "MASTER",
  "SHRI",
  "SRI",
  "SMT",
  "KUMARI",
  "DR",
  "PROF",
  "LATE",
]);

/**
 * Case, accents, punctuation and titles removed; what is left is the tokens.
 *
 * `NFD` then dropping combining marks is what turns Bālājī into BALAJI — the
 * same person typed on two different keyboards. Everything that is not a letter
 * becomes a separator, so `S/O RAJESH`, `RAJESH.KUMAR` and `RAJESH-KUMAR` all
 * arrive as the same two tokens.
 */
function tokenise(raw: string): string[] {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^\p{L}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0);
}

export function normaliseName(raw: string): string[] {
  const tokens = tokenise(raw);
  const kept = tokens.filter((token) => !HONORIFICS.has(token));

  // "SMT" on its own is all we were given; comparing nothing to nothing would
  // score 1 and let an empty name through.
  return kept.length > 0 ? kept : tokens;
}

/**
 * Transliteration folded away: LAKSHMI and LAXMI are one name spelled by two
 * clerks, and so are SATHISH and SATISH, VISHWA and VISHVA, MOHAMMED and
 * MOHAMED. Devanagari and the Dravidian scripts have sounds Latin letters spell
 * several ways, and which spelling reached a bank ledger is not something the
 * account holder chose.
 *
 * Only the substitutions that are genuinely the same sound. Nothing here folds
 * a consonant into a different one — J and K stay apart, which is what keeps
 * RAJESH and RAKESH two people.
 */
function fold(token: string): string {
  return token
    .replace(/KSH/g, "KS")
    .replace(/X/g, "KS")
    .replace(/PH/g, "F")
    .replace(/TH/g, "T")
    .replace(/W/g, "V")
    .replace(/(.)\1+/g, "$1");
}

/** Levenshtein distance. Names are short, so the plain two-row DP is both the
 *  clearest and the fastest thing available. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];

    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }

    previous = current;
  }

  return previous[b.length];
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 0 : 1 - editDistance(a, b) / longest;
}

type TokenMatch = { score: number; full: boolean };

const NO_MATCH: TokenMatch = { score: 0, full: false };

/**
 * How close two spellings of one name part have to be before they are treated as
 * that one part.
 *
 * 0.86 is not a round number and is not meant to be: it is the gap between
 * MOHAMMED/MOHAMMAD (0.875, one vowel, one person) and RAJESH/RAKESH (0.833, one
 * consonant, two people). Both are a single edit; only the second changes who is
 * being paid. Everything looser than this has to come from `fold` — a rule that
 * names the sound it is folding — rather than from moving the number.
 */
const TOKEN_SIMILARITY_FLOOR = 0.86;

/**
 * How much two name parts agree, and whether that agreement was substantive.
 *
 * The `full` flag is what separates "SHARMA vs SHARMA" from "S vs SHARMA". Both
 * are real matches; only one of them is evidence. See the cap in `tokenScore`.
 */
function matchTokens(a: string, b: string): TokenMatch {
  if (a === b) return { score: 1, full: true };

  // An initial against the name it stands for. Banks abbreviate given names
  // constantly and the worker has no say in it.
  if (a.length === 1 || b.length === 1) {
    const [initial, word] = a.length === 1 ? [a, b] : [b, a];
    return initial === word[0] ? { score: 0.9, full: false } : NO_MATCH;
  }

  // Two spellings of one sound: LAKSHMI / LAXMI, SATHISH / SATISH.
  const folded = [fold(a), fold(b)];
  if (folded[0] === folded[1]) return { score: 0.95, full: true };

  // A truncated ledger field, or a gendered suffix: KUMAR / KUMARI, RAO / RA.
  // Under three characters the prefix is not evidence on its own — it scores,
  // but it does not count as the real match the cap below asks for.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 2 && longer.startsWith(shorter)) {
    return { score: 0.85, full: shorter.length >= 3 };
  }

  const score = Math.max(similarity(a, b), similarity(folded[0], folded[1]));

  return score >= TOKEN_SIMILARITY_FLOOR ? { score, full: true } : NO_MATCH;
}

/**
 * Token-by-token, order-insensitive, greedy: each part of the shorter name takes
 * its best unclaimed partner from the longer one.
 *
 * Scored against the *shorter* name's length rather than the longer one, because
 * an extra part on one side is the single most common difference there is —
 * "Rajesh Kumar" on a form and "RAJESH KUMAR VERMA" in the bank's ledger is one
 * person. Dividing by the longer name would score that 0.67 and end the account.
 */
function tokenScore(left: string[], right: string[]): number {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];

  const claimed = new Set<number>();
  let total = 0;
  let matched = 0;
  let fullMatches = 0;

  for (const token of shorter) {
    let best = NO_MATCH;
    let bestIndex = -1;

    for (let index = 0; index < longer.length; index += 1) {
      if (claimed.has(index)) continue;

      const candidate = matchTokens(token, longer[index]);
      if (candidate.score > best.score) {
        best = candidate;
        bestIndex = index;
      }
    }

    if (bestIndex === -1 || best.score === 0) continue;

    claimed.add(bestIndex);
    total += best.score;
    matched += 1;
    if (best.full) fullMatches += 1;
  }

  // Two names that share one part share a surname, and a surname is not an
  // identity. Waived only when one side genuinely has a single part, which is
  // a real way for a name to be and not something to punish.
  if (matched < Math.min(2, shorter.length)) return 0;

  const score = total / shorter.length;

  // "R K" against "Rajesh Kumar" scores 0.9 on initials alone, and so does "R K"
  // against every other pair of names starting R and K. Agreement made entirely
  // of initials is capped below any sane threshold; one real part in common is
  // all it takes to lift it.
  if (fullMatches === 0 && (shorter.length > 1 || longer.length > 1)) {
    return Math.min(score, 0.8);
  }

  return score;
}

/**
 * How near-identical the two names have to be, run together, before spacing is
 * accepted as the only difference.
 *
 * Deliberately far above the pass mark. This pass exists for VENKATARAMAN
 * against VENKATA RAMAN, where the letters are the same and only the spaces
 * moved — not as a second, softer route for names that are merely similar.
 * RAJESHKUMAR against RAKESHKUMAR scores 0.909 here, and 0.909 is a different
 * person.
 */
const JOINED_MIN_SCORE = 0.95;

/**
 * How much two names agree, 0–1.
 *
 * Four passes, best wins, in two pairs. Each name is read both with its
 * honorifics stripped and with them left alone — because SRI is a title in front
 * of one name and the first syllable of the next, and no list can tell which
 * from the token alone. Within each reading, the token pass handles order,
 * initials and extra parts, and the joined pass catches what it cannot see: a
 * name split differently on each side, which is spacing rather than identity.
 */
export function compareNames(left: string, right: string): number {
  const readings: [string[], string[]][] = [
    [normaliseName(left), normaliseName(right)],
    [tokenise(left), tokenise(right)],
  ];

  let best = 0;

  for (const [a, b] of readings) {
    if (a.length === 0 || b.length === 0) continue;

    const joined = similarity(a.join(""), b.join(""));

    best = Math.max(best, tokenScore(a, b), joined >= JOINED_MIN_SCORE ? joined : 0);
  }

  return best;
}

/**
 * The worst agreement among every pair of names supplied — the declared name,
 * the penny drop's account holder, the PAN registry's.
 *
 * Every pair, not just each provider against what the worker typed. Two
 * providers that agree with a declared name but not with each other is the
 * interesting case: it means the bank account and the PAN belong to different
 * people, and only comparing them directly finds it.
 *
 * Null when fewer than two names arrived — there is nothing to compare, which is
 * not the same as a mismatch and must not be scored as one.
 */
export function lowestPairScore(names: readonly (string | null | undefined)[]): number | null {
  const present = names.flatMap((name) => {
    const value = (name ?? "").trim();
    return value.length > 0 ? [value] : [];
  });

  if (present.length < 2) return null;

  let lowest = 1;

  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      lowest = Math.min(lowest, compareNames(present[i], present[j]));
    }
  }

  return lowest;
}

/** `0.9166…` → `0.917`, the three decimals `worker_kyc.name_match_score`
 *  stores. Rounded here so the number written down is the number compared. */
export function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

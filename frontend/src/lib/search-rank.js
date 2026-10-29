// One rule for every search that finds apps or communities by name (#5891):
// Home's search over your apps and Discover's (features/home/home.js
// Home.filterApps), All communities, the community switcher and the phone
// drawer (features/workshop/sections.ts matchRows), and the guest directory
// (features/guest/guest-data.ts filterApps).
//
// A row matches when what was typed is inside one of its texts. Among the
// matches, a row whose name (or short name) IS what was typed, letter for
// letter in any case, leads; then a row whose name is what was typed once
// Latin accents are set aside ("Cafe" when "Café" was typed); then the rest
// in the list's own order (#4793, #5472, #5891). Each tier is stable, so
// several matches in one tier keep the list's order among themselves.
//
// Matching and the second tier compare in searchKey's form: trimmed,
// lower-cased, and with the accents of Latin letters set aside, so "cafe"
// finds "Café" however its accent was written. Only a combining accent
// (U+0300-U+036F) that follows a Latin letter goes: "Всё" stays apart from
// "Все", a Greek tonos stays, and a Japanese voicing mark or a Hangul
// syllable keeps its meaning. The first tier compares in exactKey's form,
// the same without the folding, so the name typed with its own accents
// always comes first.
//
// No import of its own: home.js runs as a classic script in its tests, which
// inline this file's text in place of the import line
// (tests/helpers/home-modules.js).

const LATIN_ACCENTS = /(\p{Script=Latin})[\u0300-\u036f]+/gu;

/** A name or a query letter for letter: NFC, trimmed, lower-cased. */
export function exactKey(value) {
  return String(value ?? '').normalize('NFC').trim().toLowerCase();
}

/** The form a name and a query are matched in: exactKey, Latin accents aside. */
export function searchKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(LATIN_ACCENTS, '$1')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

/**
 * The items that match `query`, an exact name first (letter for letter, then
 * accents aside). `names(item)` lists the texts that count as the item's name;
 * `texts(item)`, when given, lists every text a match may be found in
 * (a description, say), and defaults to the names. An empty query returns
 * every item, in order.
 */
export function rankSearch(items, query, names, texts) {
  // `filter`, never Array.from: the answer is an array of the caller's own
  // realm, which a test running home.js in a vm context compares against.
  const list = items || [];
  const q = searchKey(query);
  if (!q) return list.filter(() => true);
  const within = texts || names;
  const matches = list.filter((item) => within(item).some((text) => searchKey(text).includes(q)));
  const exactQ = exactKey(query);
  const tier = (item) => {
    const own = names(item);
    if (own.some((text) => exactKey(text) === exactQ)) return 0;
    if (own.some((text) => searchKey(text) === q)) return 1;
    return 2;
  };
  const tiers = matches.map(tier);
  if (!tiers.some((t) => t < 2)) return matches;
  const inTier = (t) => matches.filter((_, i) => tiers[i] === t);
  return inTier(0).concat(inTier(1), inTier(2));
}

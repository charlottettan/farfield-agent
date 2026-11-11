// Shared helpers for the tests. Not a test file (the test runner only picks up *.test.js).

// True only if `word` appears as a whole token, not inside a longer id, hash or timestamp. A short value like "2100" would otherwise
// match random ids by chance and make these tests fail now and then (or pass when it should not).
export function hasToken(haystack, word) {
  const esc = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<![0-9A-Za-z_])" + esc + "(?![0-9A-Za-z_])").test(haystack);
}

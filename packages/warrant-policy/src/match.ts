/**
 * Glob matching for protected-audience patterns.
 * Only '*' wildcard is supported (matches any sequence of characters).
 * Returns an object with a .test(s) method, the same interface the callers use,
 * but implemented via a pure linear scan with NO RegExp construction, which
 * eliminates the ReDoS risk entirely (no backtracking engine involved).
 *
 * Algorithm: dp over pattern[0..i) x text[0..j), kept as TWO ROWS, not a full matrix.
 * O(P*T) time, O(T) space. P is bounded by the policy doc; T is the CALLER'S string and
 * must never size an allocation quadratically: a full matrix here was a memory
 * exhaustion vector before evaluate()'s target-length cap existed, and the two-row form
 * keeps this function safe even if that cap is ever bypassed.
 */

interface Glob {
  test(text: string): boolean;
}

function globMatch(pattern: string, text: string): boolean {
  const P = pattern.length;
  const T = text.length;

  // prev[j]: pattern[0..i-1) matches text[0..j).  curr[j]: pattern[0..i) matches text[0..j).
  let prev = new Uint8Array(T + 1);
  let curr = new Uint8Array(T + 1);
  prev[0] = 1;

  for (let i = 1; i <= P; i++) {
    const pc = pattern[i - 1] as string;
    // Leading '*'s can match empty text; anything else cannot.
    curr[0] = pc === '*' ? (prev[0] as number) : 0;
    for (let j = 1; j <= T; j++) {
      if (pc === '*') {
        // '*' matches zero chars (row above) or one more char (same row, prior col).
        curr[j] = (prev[j] as number) | (curr[j - 1] as number);
      } else if (pc === (text[j - 1] as string)) {
        curr[j] = prev[j - 1] as number;
      } else {
        curr[j] = 0;
      }
    }
    const swap = prev; prev = curr; curr = swap;
  }

  return prev[T] === 1;
}

/**
 * Compiles a glob pattern into a Glob object whose .test(s) returns true iff
 * the entire string s matches the pattern (full-string, anchored).
 */
export function globToRegExp(pattern: string): Glob {
  return {
    test(text: string): boolean {
      return globMatch(pattern, text);
    },
  };
}

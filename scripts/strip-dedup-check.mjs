/**
 * Judge the `[strip-dedup]` lines of a Perry compile log.
 *
 * Perry removes the symbols duplicated between libperry_stdlib.a and libperry_ext_net.a before
 * linking. When it cannot read its archives (llvm-nm / llvm-objcopy missing, or too old for the
 * LLVM 23.1 bitcode inside), it prints `(non-fatal)` notices and links with the duplicates left
 * in. The binary is produced anyway, but may bind the wrong copy of a duplicated symbol (the
 * darwin client then cannot reach the broker). This module decides from the text whether the
 * dedup completed.
 *
 * Only lines containing `[strip-dedup]` are judged; other Perry lines (e.g. the
 * "Perry workspace source not found" note) are ignored.
 */

export const SUCCESS_MARKER = /localized wrapper-only globals/;

/** [pattern, label] — a `[strip-dedup]` line matching any of these means the dedup did not complete. */
const FAILURE_PATTERNS = [
  [/archive preparation was incomplete/, "archive preparation was incomplete"],
  [/\(non-fatal\)/, "(non-fatal) skipped"],
  [/not found/, "not found"],
  [/failed to inspect/, "failed to inspect"],
];

/**
 * @param {string} text whole compile output (stdout + stderr)
 * @returns {{ ok: boolean, problems: string[], stripDedupLines: string[] }}
 */
export function checkStripDedup(text) {
  const stripDedupLines = text.split(/\r?\n/).filter((l) => l.includes("[strip-dedup]"));
  const problems = [];

  for (const line of stripDedupLines) {
    for (const [pattern, label] of FAILURE_PATTERNS) {
      if (!pattern.test(line)) continue;
      // `(non-fatal)` alone is not a failure; only the `skipped` notices are.
      if (label === "(non-fatal) skipped" && !/skipped/.test(line)) continue;
      problems.push(`${label}: ${line.trim()}`);
      break;
    }
  }

  if (stripDedupLines.length === 0) {
    problems.push("no [strip-dedup] line in the Perry output");
  } else if (!stripDedupLines.some((l) => SUCCESS_MARKER.test(l))) {
    problems.push(`success marker missing: no [strip-dedup] line contains "localized wrapper-only globals"`);
  }

  return { ok: problems.length === 0, problems, stripDedupLines };
}

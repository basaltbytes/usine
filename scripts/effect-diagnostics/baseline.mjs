// Effect diagnostic counts per rule and file, and the rules for changing a baseline of them.
// Counts are a Map from rule to a Map from file path to count.

const add = (counts, rule, file, count) => {
  const files = counts.get(rule) ?? new Map();
  files.set(file, (files.get(file) ?? 0) + count);
  counts.set(rule, files);
};

const total = (files) => [...(files ?? new Map()).values()].reduce((sum, count) => sum + count, 0);

const rulesOf = (...counts) => [...new Set(counts.flatMap((each) => [...each.keys()]))].sort();

export const countDiagnostics = (diagnostics) => {
  const counts = new Map();
  for (const { rule, file } of diagnostics) add(counts, rule, file, 1);
  return counts;
};

export const fromDocument = (document) => {
  const counts = new Map();
  for (const [file, rules] of Object.entries(document))
    for (const [rule, count] of Object.entries(rules)) add(counts, rule, file, count);
  return counts;
};

export const toDocument = (counts) => {
  const document = {};
  const entries = [...counts].flatMap(([rule, files]) =>
    [...files].filter(([, count]) => count > 0).map(([file, count]) => ({ file, rule, count })),
  );
  entries.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule));
  for (const { file, rule, count } of entries)
    document[file] = { ...document[file], [rule]: count };
  return document;
};

// Lowers each entry to its current count. Per rule, the counts that leave listed files can follow
// the code into files the baseline doesn't list, so a rename, split, or move keeps its allowance
// while the rule's total can only fall. Current counts nothing covers are returned as uncovered.
export const shrink = (baseline, current) => {
  const next = new Map();
  const uncovered = [];
  for (const rule of rulesOf(baseline, current)) {
    const before = baseline.get(rule) ?? new Map();
    const now = current.get(rule) ?? new Map();
    let released = 0;
    for (const [file, count] of before) {
      const kept = Math.min(count, now.get(file) ?? 0);
      released += count - kept;
      if (kept > 0) add(next, rule, file, kept);
    }
    for (const [file, count] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
      const listed = before.get(file);
      if (listed !== undefined) {
        if (count > listed) uncovered.push({ rule, file, count, allowed: listed });
        continue;
      }
      const moved = Math.min(count, released);
      released -= moved;
      if (moved > 0) add(next, rule, file, moved);
      if (moved < count) uncovered.push({ rule, file, count, allowed: moved });
    }
  }
  return { next, uncovered };
};

// Entries where head allows more than base: a file listed in both with a higher count, or a rule
// whose total grew. Together these forbid any count that shrink would not produce.
export const raises = (base, head) => {
  const found = [];
  for (const rule of rulesOf(base, head)) {
    const before = base.get(rule) ?? new Map();
    const after = head.get(rule) ?? new Map();
    for (const [file, count] of after) {
      const listed = before.get(file);
      if (listed !== undefined && count > listed)
        found.push({ rule, file, before: listed, after: count });
    }
    if (total(after) > total(before))
      found.push({ rule, before: total(before), after: total(after) });
  }
  return found;
};

export const sameCounts = (a, b) => JSON.stringify(toDocument(a)) === JSON.stringify(toDocument(b));

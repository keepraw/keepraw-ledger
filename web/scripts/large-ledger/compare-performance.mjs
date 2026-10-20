import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [beforePath, afterPath] = process.argv.slice(2)
assert.ok(beforePath && afterPath, 'Usage: node compare-performance.mjs BEFORE.json AFTER.json')
const before = JSON.parse(await readFile(beforePath, 'utf8'))
const after = JSON.parse(await readFile(afterPath, 'utf8'))
for (const key of ['mode', 'seed', 'node', 'cpu', 'cpus', 'browser', 'os', 'sampleCounts']) {
  assert.deepEqual(after.metadata[key], before.metadata[key], `Comparable environment: ${key}`)
}
assert.equal(before.metadata.mode, 'performance')
assert.ok(before.metadata.completedAt && after.metadata.completedAt, 'Both campaigns must finish')
assert.deepEqual(before.cases.map(item => item.count), [18000, 100000])
assert.deepEqual(after.cases.map(item => item.count), [18000, 100000])
const metrics = [
  // Budgets declared in aud002-20261020.md before changing production code.
  ['Snapshot read', 'samples', 'readMs', 150, 750],
  ['Full filter', 'samples', 'filterAllMs', 4, 20],
  ['Full search', 'samples', 'searchAllMs', 6, 45],
  ['Filtered search', 'samples', 'filteredSearchMs', 4, 25],
  ['Date sort', 'samples', 'dateSortMs', 20, 140],
  ['Description sort', 'samples', 'descriptionSortMs', 15, 120],
  ['Search input', 'ui', 'searchMs', 50, 100],
  ['Date sort click', 'ui', 'dateSortMs', 50, 160],
  ['Description sort click', 'ui', 'descriptionSortMs', 45, 160],
  ['Edit commit', 'edits', 'commitMs', 50, 160],
  ['Edit paint', 'edits', 'paintMs', 60, 180],
  ['Refresh paint', 'samples', 'refreshPaintMs', 180, 1000],
  ['Startup', 'startup', null, 400, 1200],
]
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b)
  assert.ok(sorted.every(Number.isFinite))
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), n: sorted.length }
}
const values = (entry, group, key) => key ? entry[group].map(sample => sample[key]) : entry[group]
let failed = false
for (let index = 0; index < before.cases.length; index++) {
  const oldCase = before.cases[index], newCase = after.cases[index]
  for (const entry of [oldCase, newCase]) {
    for (const group of ['imports', 'startup', 'actualBackup']) assert.equal(entry[group].length, 3, `${group} samples`)
    for (const group of ['samples', 'edits', 'ui']) assert.equal(entry[group].length, 5, `${group} samples`)
    assert.ok(entry.samples.every(sample => sample.records === entry.count), 'Full ledger measured')
    assert.ok(entry.edits.every(sample => sample.fullReads === 0), 'Edits retain incremental state path')
    assert.ok(entry.imports.every(cycle => cycle.parts.reduce((sum, part) => sum + part.valid, 0) === entry.count))
  }
  for (const key of ['filteredRecords', 'searchedRecords']) {
    assert.deepEqual(newCase.samples.map(sample => sample[key]), oldCase.samples.map(sample => sample[key]), `Unchanged selection: ${key}`)
  }
  assert.deepEqual(newCase.fixtures, oldCase.fixtures, 'Identical fixture names, sizes and valid rows')
  process.stdout.write(`\n${oldCase.count} transactions — milliseconds; median [min, max], n\n`)
  process.stdout.write('| Metric | Before | After | Change | Budget | Result |\n| --- | ---: | ---: | ---: | ---: | --- |\n')
  const format = item => `${item.median.toFixed(1)} [${item.min.toFixed(1)}, ${item.max.toFixed(1)}], ${item.n}`
  for (const [label, group, key, ...budgets] of metrics) {
    const oldValue = summarize(values(oldCase, group, key)), newValue = summarize(values(newCase, group, key))
    const budget = budgets[index], pass = newValue.median <= budget
    if (!pass) failed = true
    const change = (newValue.median / oldValue.median - 1) * 100
    process.stdout.write(`| ${label} | ${format(oldValue)} | ${format(newValue)} | ${change.toFixed(1)}% | ${budget} | ${pass ? 'PASS' : 'MISS'} |\n`)
  }
}
if (failed) process.exitCode = 1

// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { DEFAULT_BASELINE_SETTINGS, compareToCurrent } from '../../src/views/baselineCompare';
import { BaselineLabel } from '../../src/views/baselineMap';
import { buildBaselineReport, escapeCell } from '../../src/views/baselineReport';
import { T0 } from './aiFixtures';
import { Call, apiCalls, capture, collectAll } from './baselineFixtures';

const label: BaselineLabel = { name: 'main | `x`', createdMs: 0, sourceKind: 'mark', sourceLabel: 'live', };
const meta = { baseline: label, against: 'live calls', cutoffMs: 5, time: (ms: number) => `T${ms}` };
const calls = (n: number, f: (i: number) => Partial<Call>): Call[] => Array.from({ length: n }, (_, i) => ({ endMs: T0 + i * 100, ...f(i) }));
const compare = (base: Call[], cur: Call[], coverageWarnPct = 30) =>
  compareToCurrent(capture(apiCalls(base), { realm: 'other' }), collectAll(apiCalls(cur, 10_000)), { ...DEFAULT_BASELINE_SETTINGS, coverageWarnPct });

describe('baseline report', () => {
  it('escapes untrusted names into a single Markdown table cell', () => {
    assert.strictEqual(escapeCell('a|b`c<script>\n*d*'), 'a\\|b\\`c\\<script\\> \\*d\\*');
    assert.strictEqual(escapeCell('x'.repeat(500)).length, 120);
  });

  it('summarises changes, then lists services/calls and operations with before → after', () => {
    const text = buildBaselineReport(
      compare(
        calls(60, (i) => ({ dbMs: 4 + (i % 3) })),
        calls(60, (i) => ({ dbMs: 40 + (i % 3), route: i % 2 ? '/a' : '/new' }))
      ),
      meta
    );
    assert.ok(text.startsWith('## Service map vs baseline “main \\| \\`x\\`”'), text);
    assert.ok(text.includes('Compared with: live calls after T5.'));
    assert.match(text, /\*\*⬆ \d+ regressed · ⬇ 0 improved · ✚ 0 new · ⊖ 0 not seen\*\*/);
    assert.ok(text.includes('### Services and calls'));
    assert.ok(text.includes('### Operations'));
    assert.ok(/\| ⬆ \| api → postgresql: shop \| 60 → 60 \|/.test(text), text);
    assert.ok(text.includes('**'), 'regressed values are bold');
    assert.ok(text.includes('| ✚ | api | GET /new |'), text);
    for (const line of text.split('\n').filter((l) => l.startsWith('| ⬆') || l.startsWith('| ✚'))) {
      assert.strictEqual(line.split(/(?<!\\)\|/).length, 9, line);
    }
  });

  it('caps long tables and says how many were left out', () => {
    const many = (n: number) => calls(n * 20, (i) => ({ route: `/r${i % n}` }));
    const text = buildBaselineReport(compare(calls(20, () => ({})), many(8)), meta, 3);
    // 8 new routes plus the vanished GET /a, three shown.
    assert.ok(text.includes('…and 6 more.'), text);
  });

  it('warns about low coverage and says when nothing changed', () => {
    const same = calls(40, () => ({}));
    const flat = buildBaselineReport(compare(same, same), meta);
    assert.ok(flat.includes('No significant changes.'));
    assert.ok(!flat.includes('⚠'));
    const warned = buildBaselineReport(compare(same, calls(40, () => ({ dbMs: 3 }))), meta);
    assert.ok(warned.includes('> ⚠ 50% of the services'), warned);
  });
});

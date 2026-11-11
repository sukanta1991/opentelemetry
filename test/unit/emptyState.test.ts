// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { emptyCase, emptyContent } from '../../src/views/webview/emptyState';

describe('emptyState', () => {
  it('picks gone, none, filtered or nothing', () => {
    assert.strictEqual(emptyCase(true, 5, 5), 'gone');
    assert.strictEqual(emptyCase(false, 0, 0), 'none');
    assert.strictEqual(emptyCase(false, 5, 0), 'filtered');
    assert.strictEqual(emptyCase(false, 5, 2), undefined);
  });

  it('offers Clear filters only when filters hide everything', () => {
    for (const signal of ['traces', 'logs', 'metrics'] as const) {
      const filtered = emptyContent(signal, 'filtered');
      assert.strictEqual(filtered.title, `No ${signal} match the current filters.`);
      assert.strictEqual(filtered.clear, true);
      assert.strictEqual(emptyContent(signal, 'none').clear, false);
      assert.strictEqual(emptyContent(signal, 'gone').clear, false);
    }
  });

  it('names the exporter to enable when a signal has no data', () => {
    assert.strictEqual(emptyContent('traces', 'none').code, 'OTEL_TRACES_EXPORTER=otlp');
    assert.strictEqual(emptyContent('logs', 'none').code, 'OTEL_LOGS_EXPORTER=otlp');
    assert.strictEqual(emptyContent('metrics', 'none').code, 'OTEL_METRICS_EXPORTER=otlp');
    assert.match(emptyContent('logs', 'none').hint!, /logging bridge/);
  });
});

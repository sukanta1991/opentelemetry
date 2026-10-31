// SPDX-License-Identifier: Apache-2.0
// A store filled to every cardinality cap, for performance tests. Not a *.test.ts file.

import { DEFAULT_CARDINALITY_CAPS } from '../../src/store/cardinality/budget';
import { LogRecord, Metric, Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import { T0 } from './aiFixtures';

export const CAPS = DEFAULT_CARDINALITY_CAPS;
export const VALUES_PER_KEY = 200;
export const SPAN_INSTANCES = 7;
const METRIC_INSTANCES = 3;
const LOG_INSTANCES = 4;

const resource = (svc: string) => ({ serviceName: svc, serviceInstanceId: 'i', attrs: {} });
const hex = (i: number, len: number) => (i + 1).toString(16).padStart(len, '0');
// Letters only, so Drain routes on the word itself rather than the wildcard child.
const word = (i: number) => `w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;

/** 3584 span keys in sketch mode (each a finding), 1024 metrics and 2000 log templates. */
export function fillToCaps(): TelemetryStore {
  const store = new TelemetryStore();
  for (let s = 0; s < SPAN_INSTANCES; s++) {
    const spans: Span[] = [];
    for (let v = 0; v < VALUES_PER_KEY; v++) {
      const attrs: Record<string, string> = {};
      for (let k = 0; k < CAPS.keysPerInstance; k++) attrs[`attr.${k}`] = `value-${k}-${v}`;
      const id = s * VALUES_PER_KEY + v;
      spans.push({
        traceId: hex(id, 32),
        spanId: hex(id, 16),
        name: `op${v % 50}`,
        kind: 'SERVER',
        startMs: T0 + v * 1000,
        endMs: T0 + v * 1000 + 5,
        durationMs: 5,
        statusCode: 'UNSET',
        attrs,
        events: [],
        links: [],
      });
    }
    store.ingestSpans([{ resource: resource(`spans${s}`), spans }]);
  }
  let metric = 0;
  for (let s = 0; s < METRIC_INSTANCES && metric < CAPS.metricsTotal; s++) {
    const metrics: Metric[] = [];
    for (let n = 0; n < CAPS.metricsPerInstance && metric < CAPS.metricsTotal; n++, metric++) {
      metrics.push({
        name: `metric.${metric}`,
        type: 'sum',
        monotonic: true,
        dataPoints: Array.from({ length: 5 }, (_, p) => ({ attrs: { route: `/r${p}`, user: `u${p}` }, timeMs: T0 + p, value: p })),
      });
    }
    store.ingestMetrics([{ resource: resource(`metrics${s}`), metrics }]);
  }
  for (let s = 0; s < LOG_INSTANCES; s++) {
    const logs: LogRecord[] = [];
    for (let t = 0; t < CAPS.templatesPerInstance; t++) {
      const body = [word(t % 99), ...new Array<string>(2 + Math.floor(t / 99)).fill('steady')].join(' ');
      for (let r = 0; r < 2; r++) logs.push({ timeMs: T0 + t, severityNumber: 9, severityText: 'INFO', body, attrs: {} });
    }
    store.ingestLogs([{ resource: resource(`logs${s}`), logs }]);
  }
  return store;
}

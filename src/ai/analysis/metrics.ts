// SPDX-License-Identifier: Apache-2.0
// otel_queryMetrics: list metrics, or summarize every series of one metric.

import { TelemetryStore } from '../../store/store';
import { reduceOverTime } from '../../views/webview/stats';
import { iso, safeValue, truncateString } from '../serialize';
import { QueryMetricsInput } from '../toolInputs';
import { AnalysisContext, AnalysisOutput, errorOutput, selectInstances } from './common';

const MAX_KNOWN = 20;

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function queryMetrics(store: TelemetryStore, input: QueryMetricsInput, ctx: AnalysisContext): AnalysisOutput {
  const sel = selectInstances(store, input.service, input.instanceId);
  if ('error' in sel) return errorOutput(sel.error);
  const instances = [...sel.instances].sort((a, b) => cmpStr(a.id, b.id));

  if (!input.name) {
    const metrics = [];
    for (const inst of instances) {
      const seriesCount = new Map<string, number>();
      for (const s of inst.metricSeries.values()) seriesCount.set(s.metricName, (seriesCount.get(s.metricName) ?? 0) + 1);
      for (const m of [...inst.metrics.values()].sort((a, b) => cmpStr(a.name, b.name))) {
        metrics.push({
          instanceId: inst.id,
          service: inst.serviceName,
          name: m.name,
          type: m.type,
          unit: m.unit || undefined,
          description: m.description ? truncateString(ctx.redactor.text(m.description), 200) : undefined,
          monotonic: m.type === 'sum' ? m.monotonic ?? false : undefined,
          seriesCount: seriesCount.get(m.name) ?? 0,
        });
      }
    }
    return {
      result: { totalMetrics: metrics.length, metrics: metrics.slice(0, input.limit) },
      refs: [],
      listKey: 'metrics',
    };
  }

  const name = input.name;
  const owners = instances.filter((i) => i.metrics.has(name));
  if (!owners.length) {
    const known = [...new Set(instances.flatMap((i) => [...i.metrics.keys()]))].sort().slice(0, MAX_KNOWN);
    return errorOutput(`metric ${JSON.stringify(name)} not found; known metrics: ${known.join(', ') || '(none)'}`);
  }

  const series = [];
  for (const inst of owners) {
    const metric = inst.metrics.get(name)!;
    const counter = metric.type === 'sum' && metric.monotonic === true;
    const list = store
      .getMetricSeries(inst.id, name)
      .map((s) => ({ s, attrsKey: JSON.stringify(s.attrs) }))
      .sort((a, b) => cmpStr(a.s.field, b.s.field) || cmpStr(a.attrsKey, b.attrsKey));
    for (const { s } of list) {
      const ys = s.data.map((p) => p.value);
      const first = s.data[0];
      const last = s.data[s.data.length - 1];
      const delta = first && last ? last.value - first.value : null;
      const elapsedSec = first && last ? (last.timeMs - first.timeMs) / 1000 : 0;
      series.push({
        instanceId: inst.id,
        service: inst.serviceName,
        attrs: safeValue(ctx.redactor.attrs(s.attrs)),
        field: s.field,
        points: s.data.length,
        from: iso(first?.timeMs),
        to: iso(last?.timeMs),
        last: reduceOverTime(ys, 'last'),
        min: reduceOverTime(ys, 'min'),
        max: reduceOverTime(ys, 'max'),
        avg: reduceOverTime(ys, 'avg'),
        p50: reduceOverTime(ys, 'p50'),
        p95: reduceOverTime(ys, 'p95'),
        delta,
        ratePerSec: counter ? (delta !== null && elapsedSec > 0 ? delta / elapsedSec : null) : undefined,
      });
    }
  }

  const metric = owners[0].metrics.get(name)!;
  return {
    result: {
      name,
      type: metric.type,
      unit: metric.unit || undefined,
      monotonic: metric.type === 'sum' ? metric.monotonic ?? false : undefined,
      totalSeries: series.length,
      series: series.slice(0, input.limit),
    },
    refs: [],
    listKey: 'series',
  };
}

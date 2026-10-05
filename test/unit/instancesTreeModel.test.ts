// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { LogRecord, ResourceLogs, Span } from '../../src/store/model';
import { TelemetryStore } from '../../src/store/store';
import {
  diffDescriptions,
  instanceDescription,
  instanceLabel,
  serviceDescription,
  treeShape,
} from '../../src/views/instancesTreeModel';

function log(body: string): LogRecord {
  return { timeMs: 1000, severityNumber: 9, severityText: 'INFO', body, attrs: {} };
}

function logs(serviceName: string, serviceInstanceId?: string, count = 1): ResourceLogs[] {
  const records = Array.from({ length: count }, (_, i) => log(`m${i}`));
  return [{ resource: { serviceName, serviceInstanceId, attrs: {} }, logs: records }];
}

function span(spanId: string): Span {
  return {
    traceId: 'a'.repeat(32),
    spanId,
    name: spanId,
    kind: 'INTERNAL',
    startMs: 0,
    endMs: 1,
    durationMs: 1,
    statusCode: 'UNSET',
    attrs: {},
    events: [],
    links: [],
  };
}

const shapeOf = (store: TelemetryStore) =>
  treeShape(store.getApplications(), store.getImportedInstances());

const allInstances = (store: TelemetryStore) => [
  ...store.getApplications().flatMap((a) => a.instances),
  ...store.getImportedInstances(),
];

describe('instancesTreeModel', () => {
  describe('instanceLabel', () => {
    it('prefers service.instance.id', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('svc', 'pod-1'));
      assert.strictEqual(instanceLabel(store.getInstance('svc::pod-1')!), 'pod-1');
    });

    it('falls back to the hash part of the id', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('svc'));
      const inst = store.getAllInstances()[0];
      assert.strictEqual(instanceLabel(inst), inst.id.split('::')[1]);
    });
  });

  describe('instanceDescription', () => {
    it('shows counts for live instances', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('svc', 'i1', 2));
      store.ingestSpans([
        { resource: { serviceName: 'svc', serviceInstanceId: 'i1', attrs: {} }, spans: [span('1111111111111111')] },
      ]);
      assert.strictEqual(
        instanceDescription(store.getInstance('svc::i1')!),
        '2 logs · 1 traces · 0 metrics'
      );
    });

    it('shows source and log count for imported instances', () => {
      const store = new TelemetryStore();
      const id = store.importLogs({
        serviceName: 'svc',
        resourceAttrs: {},
        logs: [log('a'), log('b'), log('c')],
        sourceLabel: 'dump.json',
      });
      assert.strictEqual(instanceDescription(store.getInstance(id)!), 'dump.json · 3 logs · 0 traces · 0 metrics');
    });

    it('adds trace and metric counts for loaded sessions and can omit the source', () => {
      const store = new TelemetryStore();
      const resource = { serviceName: 'svc', serviceInstanceId: 'i1', attrs: {} };
      const { instanceIds } = store.importSession({
        sourceLabel: 's.otel.json',
        traces: [{ resource, spans: [span('3333333333333333')] }],
        logs: [{ resource, logs: [log('a')] }],
        metrics: [{ resource, metrics: [{ name: 'm', type: 'gauge', dataPoints: [{ attrs: {}, timeMs: 1, value: 1 }] }] }],
      });
      const inst = store.getInstance(instanceIds[0])!;
      assert.strictEqual(instanceDescription(inst), 's.otel.json · 1 logs · 1 traces · 1 metrics');
      assert.strictEqual(instanceDescription(inst, false), '1 logs · 1 traces · 1 metrics');
    });
  });

  describe('loaded session instances', () => {
    it('labels by instance id or resource hash, not the file name', () => {
      const store = new TelemetryStore();
      const { instanceIds } = store.importSession({
        sourceLabel: 'a::b.json',
        traces: [],
        logs: [
          { resource: { serviceName: 'svc', serviceInstanceId: 'pod-1', attrs: {} }, logs: [log('a')] },
          { resource: { serviceName: 'svc', attrs: { host: 'h' } }, logs: [log('b')] },
        ],
        metrics: [],
      });
      const [withId, hashed] = instanceIds.map((id) => store.getInstance(id)!);
      assert.strictEqual(instanceLabel(withId), 'pod-1');
      assert.match(instanceLabel(hashed), /^[0-9a-f]{16}$/);
    });

    it('summarises a service across its instances', () => {
      const store = new TelemetryStore();
      const resource = (id: string) => ({ serviceName: 'svc', serviceInstanceId: id, attrs: {} });
      const { instanceIds } = store.importSession({
        sourceLabel: 's.json',
        traces: [{ resource: resource('a'), spans: [span('4444444444444444')] }],
        logs: [{ resource: resource('b'), logs: [log('x'), log('y')] }],
        metrics: [],
      });
      const instances = instanceIds.map((id) => store.getInstance(id)!);
      assert.strictEqual(serviceDescription(instances), '2 instances · 2 logs · 1 traces · 0 metrics');
      assert.strictEqual(serviceDescription(instances.slice(0, 1)), '1 instance · 0 logs · 1 traces · 0 metrics');
    });
  });

  describe('treeShape', () => {
    it('is unchanged when only counts change', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('svc', 'i1'));
      const before = shapeOf(store);
      store.ingestLogs(logs('svc', 'i1', 5));
      store.ingestSpans([
        { resource: { serviceName: 'svc', serviceInstanceId: 'i1', attrs: {} }, spans: [span('2222222222222222')] },
      ]);
      assert.strictEqual(shapeOf(store), before);
    });

    it('changes when an instance is added or removed', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('svc', 'i1'));
      const one = shapeOf(store);
      store.ingestLogs(logs('svc', 'i2'));
      const two = shapeOf(store);
      assert.notStrictEqual(two, one);
      store.removeInstance('svc::i2');
      assert.strictEqual(shapeOf(store), one);
    });

    it('changes when logs are imported', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('svc', 'i1'));
      const before = shapeOf(store);
      store.importLogs({ serviceName: 'svc', resourceAttrs: {}, logs: [log('a')], sourceLabel: 'f.json' });
      assert.notStrictEqual(shapeOf(store), before);
    });
  });

  describe('diffDescriptions', () => {
    it('reports every instance against an empty baseline', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('a', 'i1'));
      store.ingestLogs(logs('b', 'i1'));
      const { changed, next } = diffDescriptions(new Map(), allInstances(store));
      assert.deepStrictEqual(changed.sort(), ['a::i1', 'b::i1']);
      assert.strictEqual(next.size, 2);
    });

    it('reports only instances whose counts changed', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('a', 'i1'));
      store.ingestLogs(logs('b', 'i1'));
      const baseline = diffDescriptions(new Map(), allInstances(store)).next;
      store.ingestLogs(logs('b', 'i1'));
      assert.deepStrictEqual(diffDescriptions(baseline, allInstances(store)).changed, ['b::i1']);
    });

    it('reports nothing when nothing changed', () => {
      const store = new TelemetryStore();
      store.ingestLogs(logs('a', 'i1'));
      const baseline = diffDescriptions(new Map(), allInstances(store)).next;
      assert.deepStrictEqual(diffDescriptions(baseline, allInstances(store)).changed, []);
    });
  });
});

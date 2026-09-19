import * as assert from 'assert';
import { TelemetryStore } from '../../src/store/store';
import { LogRecord, ResourceLogs } from '../../src/store/model';

function log(timeMs: number, body: string): LogRecord {
  return { timeMs, severityNumber: 9, severityText: 'INFO', body, attrs: {} };
}

function batch(logs: LogRecord[]): ResourceLogs[] {
  return [{ resource: { serviceName: 'svc', serviceInstanceId: 'i1', attrs: {} }, logs }];
}

const instanceId = 'svc::i1';

describe('store log sequencing', () => {
  it('assigns monotonic seq ids across ingests', () => {
    const store = new TelemetryStore();
    store.ingestLogs(batch([log(1000, 'a'), log(2000, 'b')]));
    store.ingestLogs(batch([log(3000, 'c')]));
    assert.deepStrictEqual(
      store.getLogs(instanceId).map((l) => l.seq),
      [1, 2, 3]
    );
  });

  it('keeps seq ids stable when the ring buffer evicts', () => {
    const store = new TelemetryStore(3);
    for (let i = 0; i < 5; i++) store.ingestLogs(batch([log(i * 1000, `m${i}`)]));
    const logs = store.getLogs(instanceId);
    assert.strictEqual(logs.length, 3);
    assert.deepStrictEqual(
      logs.map((l) => l.seq),
      [3, 4, 5]
    );
    assert.deepStrictEqual(
      logs.map((l) => l.body),
      ['m2', 'm3', 'm4']
    );
  });

  it('getLogsSince returns only newer records plus the eviction watermark', () => {
    const store = new TelemetryStore(3);
    for (let i = 0; i < 5; i++) store.ingestLogs(batch([log(i * 1000, `m${i}`)]));

    const all = store.getLogsSince(instanceId, 0);
    assert.deepStrictEqual(
      all.records.map((l) => l.seq),
      [3, 4, 5]
    );
    assert.strictEqual(all.oldestSeq, 3);
    assert.strictEqual(all.total, 3);

    const delta = store.getLogsSince(instanceId, 4);
    assert.deepStrictEqual(
      delta.records.map((l) => l.seq),
      [5]
    );

    assert.strictEqual(store.getLogsSince(instanceId, 5).records.length, 0);
  });

  it('getLogsSince on an unknown instance is empty', () => {
    const store = new TelemetryStore();
    const delta = store.getLogsSince('nope', 0);
    assert.deepStrictEqual(delta, { records: [], oldestSeq: 0, total: 0 });
  });

  it('findLog resolves a record after eviction has shifted array indices', () => {
    const store = new TelemetryStore(3);
    for (let i = 0; i < 5; i++) store.ingestLogs(batch([log(i * 1000, `m${i}`)]));
    assert.strictEqual(store.findLog(instanceId, 5)?.body, 'm4');
    assert.strictEqual(store.findLog(instanceId, 3)?.body, 'm2');
    assert.strictEqual(store.findLog(instanceId, 1), undefined, 'evicted seq');
    assert.strictEqual(store.findLog(instanceId, 99), undefined, 'future seq');
  });
});

describe('store imported instances', () => {
  const imported = (store: TelemetryStore, label: string, logs: LogRecord[]) =>
    store.importLogs({ serviceName: 'svc', resourceAttrs: {}, logs, sourceLabel: label });

  it('creates a distinct instance per import of the same filename', () => {
    const store = new TelemetryStore();
    const a = imported(store, 'run.json', [log(1000, 'a')]);
    const b = imported(store, 'run.json', [log(2000, 'b')]);
    assert.notStrictEqual(a, b);
    assert.strictEqual(store.getImportedInstances().length, 2);
  });

  it('assigns seq ids and reports the source label', () => {
    const store = new TelemetryStore();
    const id = imported(store, 'run.json', [log(1000, 'a'), log(2000, 'b')]);
    const inst = store.getInstance(id);
    assert.strictEqual(inst?.kind, 'imported');
    assert.strictEqual(inst?.source, 'run.json');
    assert.deepStrictEqual(
      store.getLogs(id).map((l) => l.seq),
      [1, 2]
    );
  });

  it('is excluded from getApplications', () => {
    const store = new TelemetryStore();
    imported(store, 'run.json', [log(1000, 'a')]);
    assert.deepStrictEqual(store.getApplications(), []);
    store.ingestLogs(batch([log(1000, 'live')]));
    const apps = store.getApplications();
    assert.strictEqual(apps.length, 1);
    assert.strictEqual(apps[0].instances.length, 1);
    assert.strictEqual(apps[0].instances[0].id, instanceId);
  });

  it('survives clear() while live instances are removed', () => {
    const store = new TelemetryStore();
    store.ingestLogs(batch([log(1000, 'live')]));
    const id = imported(store, 'run.json', [log(1000, 'a')]);
    store.clear();
    assert.strictEqual(store.getInstance(instanceId), undefined);
    assert.strictEqual(store.getInstance(id)?.logs.length, 1);
  });

  it('is exempt from retention capping', () => {
    const store = new TelemetryStore(3);
    const logs = Array.from({ length: 10 }, (_, i) => log(i * 1000, `m${i}`));
    const id = imported(store, 'run.json', logs);
    assert.strictEqual(store.getLogs(id).length, 10);
    store.setRetention(2, 2000, 500);
    assert.strictEqual(store.getLogs(id).length, 10, 'setRetention must not truncate imports');
  });

  it('ignores live ingest targeted at an imported instance id', () => {
    const store = new TelemetryStore();
    const id = imported(store, 'run.json', [log(1000, 'a')]);
    store.ingestLogs(batch([log(2000, 'live')]));
    assert.strictEqual(store.getLogs(id).length, 1);
  });

  it('removeInstance deletes an imported instance', () => {
    const store = new TelemetryStore();
    const id = imported(store, 'run.json', [log(1000, 'a')]);
    store.removeInstance(id);
    assert.strictEqual(store.getInstance(id), undefined);
    assert.strictEqual(store.getImportedInstances().length, 0);
  });
});

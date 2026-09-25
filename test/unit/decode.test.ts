import * as assert from 'assert';
import { decodeLogs, decodeMetrics, decodeTraces, toHexId } from '../../src/store/decode';

describe('decode', () => {
  it('toHexId handles base64 and hex and empty', () => {
    // 16-byte trace id as base64
    const b64 = Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex').toString('base64');
    assert.strictEqual(toHexId(b64), '0af7651916cd43dd8448eb211c80319c');
    // already-hex passthrough (OTLP/JSON style)
    assert.strictEqual(toHexId('b7ad6b7169203331'), 'b7ad6b7169203331');
    assert.strictEqual(toHexId(''), undefined);
    assert.strictEqual(toHexId(undefined), undefined);
  });

  it('decodeTraces normalizes ids, kind, status and duration', () => {
    const req = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
          scopeSpans: [
            {
              scope: { name: 's' },
              spans: [
                {
                  traceId: 'CvdlGRbNQ91ESOshHIAxnA==', // base64 of 0af765...
                  spanId: Buffer.from('b7ad6b7169203331', 'hex').toString('base64'),
                  name: 'op',
                  kind: 3,
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000000002500000',
                  status: { code: 2, message: 'boom' },
                  attributes: [{ key: 'http.method', value: { stringValue: 'GET' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const [batch] = decodeTraces(req);
    assert.strictEqual(batch.resource.serviceName, 'svc');
    const span = batch.spans[0];
    assert.strictEqual(span.traceId.length, 32);
    assert.strictEqual(span.spanId, 'b7ad6b7169203331');
    assert.strictEqual(span.kind, 'CLIENT');
    assert.strictEqual(span.statusCode, 'ERROR');
    assert.strictEqual(span.statusMessage, 'boom');
    assert.strictEqual(span.durationMs, 2.5);
    assert.strictEqual(span.attrs['http.method'], 'GET');
    assert.deepStrictEqual(span.links, []);
    assert.strictEqual(span.codeLocation, undefined);
  });

  const TRACE = '0af7651916cd43dd8448eb211c80319c';
  const SPAN = 'b7ad6b7169203331';
  const kv = (key: string, v: string | number) => ({
    key,
    value: typeof v === 'string' ? { stringValue: v } : { intValue: v },
  });
  const traces = (span: Record<string, unknown>) => ({
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans: [span] }] }],
  });

  it('decodeTraces decodes links in hex and base64 and drops malformed ones', () => {
    const [batch] = decodeTraces(
      traces({
        traceId: TRACE,
        spanId: SPAN,
        links: [
          { traceId: TRACE.toUpperCase(), spanId: SPAN, traceState: 'k=v', attributes: [kv('a', 'b')] },
          {
            traceId: Buffer.from(TRACE, 'hex').toString('base64'),
            spanId: Buffer.from(SPAN, 'hex').toString('base64'),
            traceState: '',
          },
          { traceId: TRACE },
          { traceId: '0'.repeat(32), spanId: SPAN },
          null,
        ],
      })
    );
    const [link1, link2, ...rest] = batch.spans[0].links;
    assert.deepStrictEqual(link1, { traceId: TRACE, spanId: SPAN, traceState: 'k=v', attrs: { a: 'b' } });
    assert.deepStrictEqual(link2, { traceId: TRACE, spanId: SPAN, attrs: {} });
    assert.strictEqual(rest.length, 0);
  });

  it('decodeTraces reads span code location from old and new semconv keys', () => {
    const [oldKeys] = decodeTraces(
      traces({
        traceId: TRACE,
        spanId: SPAN,
        attributes: [kv('code.filepath', 'src/a.ts'), kv('code.lineno', 12), kv('code.function', 'f')],
      })
    );
    assert.deepStrictEqual(oldKeys.spans[0].codeLocation, {
      filepath: 'src/a.ts',
      line: 12,
      column: undefined,
      function: 'f',
    });
    const [newKeys] = decodeTraces(
      traces({
        traceId: TRACE,
        spanId: SPAN,
        attributes: [kv('code.file.path', 'b.py'), kv('code.line.number', 3), kv('code.function.name', 'g')],
      })
    );
    assert.strictEqual(newKeys.spans[0].codeLocation?.filepath, 'b.py');
    assert.strictEqual(newKeys.spans[0].codeLocation?.line, 3);
  });

  it('decodeTraces treats an all-zero parent as no parent', () => {
    const [batch] = decodeTraces(traces({ traceId: TRACE, spanId: SPAN, parentSpanId: '0'.repeat(16) }));
    assert.strictEqual(batch.spans[0].parentSpanId, undefined);
  });

  it('decodeLogs drops all-zero trace and span ids', () => {
    const logs = (traceId: string, spanId: string) =>
      decodeLogs({
        resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ traceId, spanId }] }] }],
      })[0].logs[0];
    const zero = logs('0'.repeat(32), '0'.repeat(16));
    assert.strictEqual(zero.traceId, undefined);
    assert.strictEqual(zero.spanId, undefined);
    const real = logs(TRACE.toUpperCase(), SPAN);
    assert.strictEqual(real.traceId, TRACE);
    assert.strictEqual(real.spanId, SPAN);
  });

  it('decodeMetrics handles gauge and histogram', () => {
    const req = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'm' } }] },
          scopeMetrics: [
            {
              metrics: [
                { name: 'temp', gauge: { dataPoints: [{ asDouble: 21.5, attributes: [] }] } },
                {
                  name: 'lat',
                  histogram: {
                    dataPoints: [
                      { count: '10', sum: 100, explicitBounds: [1, 2], bucketCounts: ['4', '6'] },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const [batch] = decodeMetrics(req);
    const gauge = batch.metrics.find((x) => x.name === 'temp')!;
    assert.strictEqual(gauge.type, 'gauge');
    assert.strictEqual(gauge.dataPoints[0].value, 21.5);
    const hist = batch.metrics.find((x) => x.name === 'lat')!;
    assert.strictEqual(hist.type, 'histogram');
    assert.strictEqual(hist.dataPoints[0].count, 10);
    assert.deepStrictEqual(hist.dataPoints[0].bucketCounts, [4, 6]);
  });

  it('decodeMetrics captures summary quantiles', () => {
    const req = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'm' } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'rt',
                  summary: {
                    dataPoints: [
                      {
                        count: '3',
                        sum: 30,
                        quantileValues: [
                          { quantile: 0.5, value: 8 },
                          { quantile: 0.99, value: 20 },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const [batch] = decodeMetrics(req);
    const summary = batch.metrics.find((x) => x.name === 'rt')!;
    assert.strictEqual(summary.type, 'summary');
    assert.strictEqual(summary.dataPoints[0].count, 3);
    assert.deepStrictEqual(summary.dataPoints[0].quantiles, [
      { quantile: 0.5, value: 8 },
      { quantile: 0.99, value: 20 },
    ]);
  });

  it('decodeMetrics threads sum monotonicity and leaves it undefined otherwise', () => {
    const req = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'm' } }] },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'requests',
                  sum: { isMonotonic: true, dataPoints: [{ asInt: '5', attributes: [] }] },
                },
                {
                  name: 'queue.depth',
                  sum: { isMonotonic: false, dataPoints: [{ asInt: '2', attributes: [] }] },
                },
                { name: 'temp', gauge: { dataPoints: [{ asDouble: 21.5, attributes: [] }] } },
              ],
            },
          ],
        },
      ],
    };
    const [batch] = decodeMetrics(req);
    assert.strictEqual(batch.metrics.find((x) => x.name === 'requests')!.monotonic, true);
    assert.strictEqual(batch.metrics.find((x) => x.name === 'queue.depth')!.monotonic, false);
    assert.strictEqual(batch.metrics.find((x) => x.name === 'temp')!.monotonic, undefined);
  });
});

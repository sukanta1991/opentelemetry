import * as assert from 'assert';
import { decodeMetrics, decodeTraces, toHexId } from '../../src/store/decode';

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
});

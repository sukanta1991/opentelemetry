import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

const rawEndpoint = process.argv[2] || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://127.0.0.1:4318/v1/logs';
const endpoint = normalizeEndpoint(rawEndpoint);
const body = JSON.stringify({
  resourceLogs: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'out-of-order-demo' } },
          { key: 'service.instance.id', value: { stringValue: 'instance-1' } },
        ],
      },
      scopeLogs: [
        {
          scope: { name: 'push-out-of-order-logs' },
          logRecords: [
            {
              timeUnixNano: '300000000000',
              severityNumber: 9,
              severityText: 'Info',
              body: { stringValue: 'third log' },
              attributes: [{ key: 'ordinal', value: { stringValue: '3' } }],
            },
            {
              timeUnixNano: '100000000000',
              severityNumber: 9,
              severityText: 'Info',
              body: { stringValue: 'first log' },
              attributes: [{ key: 'ordinal', value: { stringValue: '1' } }],
            },
            {
              timeUnixNano: '200000000000',
              severityNumber: 9,
              severityText: 'Info',
              body: { stringValue: 'second log' },
              attributes: [{ key: 'ordinal', value: { stringValue: '2' } }],
            },
          ],
        },
      ],
    },
  ],
});

console.log(`Sending out-of-order logs to ${endpoint.href}`);
console.log('Payload:', JSON.stringify(JSON.parse(body), null, 2));

const client = endpoint.protocol === 'https:' ? https : http;
const req = client.request(
  {
    method: 'POST',
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: endpoint.pathname + endpoint.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    res.on('end', () => {
      const responseBody = Buffer.concat(chunks).toString('utf8');
      console.log(`Response: ${res.statusCode} ${res.statusMessage}`);
      console.log(responseBody);
    });
  }
);

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});
req.write(body);
req.end();

function normalizeEndpoint(raw: string): URL {
  let value = raw.trim();
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    value = `http://${value}`;
  }
  const url = new URL(value);
  if (!url.pathname || url.pathname === '/') {
    url.pathname = '/v1/logs';
  }
  if (!url.port) {
    url.port = url.protocol === 'https:' ? '443' : '80';
  }
  return url;
}

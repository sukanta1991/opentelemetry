// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { REDACTED, createRedactor } from '../../src/ai/redact';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';

describe('ai redact', () => {
  const r = createRedactor();

  describe('key-based', () => {
    const sensitive = [
      'Authorization',
      'http.request.header.authorization',
      'auth',
      'Cookie',
      'Set-Cookie',
      'http.response.header.set_cookie',
      'password',
      'DB_PASSWORD',
      'passwd',
      'PWD',
      'client_secret',
      'token',
      'access_token',
      'X-Api-Key',
      'x_api_key',
      'apiKey',
      'aws.access_key',
      'AccessKey',
      'private-key',
      'user.credentials',
      'session.id',
      'connection_string',
      'db.connection_string',
      'DB.CONNECTION-STRING',
      'xapikey',
    ];

    for (const key of sensitive) {
      it(`redacts "${key}"`, () => {
        assert.deepStrictEqual(r.attrs({ [key]: 'hunter2', keep: 'ok' }), { [key]: REDACTED, keep: 'ok' });
      });
    }

    it('redacts whole nested values under a sensitive key', () => {
      assert.deepStrictEqual(r.value({ credentials: { user: 'a', pass: 'b' }, cookie: ['x', 'y'] }), {
        credentials: REDACTED,
        cookie: REDACTED,
      });
    });

    it('keeps ordinary keys, including GenAI token counts', () => {
      const attrs = {
        'http.method': 'GET',
        'gen_ai.usage.input_tokens': 120,
        'gen_ai.usage.output_tokens': 30,
        'gen_ai.request.max_tokens': 512,
        inputTokens: 5,
      };
      assert.deepStrictEqual(r.attrs(attrs), attrs);
    });

    it('adds user keys, normalised the same way, without removing built-ins', () => {
      const custom = createRedactor(['Tenant.ID', '', '   ', 42 as unknown as string]);
      assert.deepStrictEqual(custom.attrs({ tenant_id: 't1', 'TENANT-ID': 't2', password: 'p', name: 'n' }), {
        tenant_id: REDACTED,
        'TENANT-ID': REDACTED,
        password: REDACTED,
        name: 'n',
      });
    });
  });

  describe('value-based', () => {
    const cases: [string, string, string][] = [
      ['Bearer', 'auth header Bearer abcdef123456.xyz-_~+/= sent', 'abcdef123456'],
      ['lowercase bearer', 'bearer abcdefghijklmnop', 'abcdefghijklmnop'],
      ['Basic', 'Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
      [
        'JWT',
        'jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end',
        'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      ],
      ['AWS AKIA', 'key AKIAIOSFODNN7EXAMPLE used', 'AKIAIOSFODNN7EXAMPLE'],
      ['AWS ASIA', 'key ASIAIOSFODNN7EXAMPLE used', 'ASIAIOSFODNN7EXAMPLE'],
      ['GitHub ghp_', 'gh ghp_' + 'A1b2C3d4E5'.repeat(4) + ' ok', 'A1b2C3d4E5A1b2'],
      ['GitHub gho_', 'gh gho_' + 'Z9'.repeat(18), 'Z9Z9Z9Z9Z9'],
      ['GitHub ghs_', 'gh ghs_' + 'Q'.repeat(36), 'QQQQQQQQQQ'],
      ['GitHub github_pat_', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '11ABCDEFG0123456789'],
      ['Slack', 'slack xoxb-1234567890-abcdefghij', '1234567890-abcdefghij'],
      ['sk- key', 'OPENAI sk-proj-abcdefghijklmnopqrstuvwxyz0123 done', 'abcdefghijklmnopqrstuvwxyz'],
      [
        'PEM block',
        'k=-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaDcBo\n-----END RSA PRIVATE KEY----- tail',
        'MIIEowIBAAKCAQEA',
      ],
      ['PEM without END', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'MIIEvQIBADAN'],
      ['URL password', 'dial postgres://admin:s3cr3t-pa55@db.local:5432/shop', 's3cr3t-pa55'],
      ['query token', 'GET /cb?code=1&access_token=abc123xyz&state=s', 'abc123xyz'],
      ['query api_key', 'https://x.io/v1?api_key=K3y-value', 'K3y-value'],
      ['connection string Password', 'Server=db;User Id=sa;Password=hunter2;Encrypt=true', 'hunter2'],
      ['connection string pwd', 'host=db pwd=hunter3 port=5432', 'hunter3'],
      ['JSON-ish text', '{"user":"bob","password":"hunter4"}', 'hunter4'],
    ];

    for (const [name, input, secret] of cases) {
      it(`masks ${name}`, () => {
        const out = r.text(input);
        assert.ok(!out.includes(secret), `${name}: "${out}" still contains "${secret}"`);
        assert.ok(out.includes('[REDACTED'), `${name}: "${out}" has no marker`);
      });
    }

    it('keeps surrounding text and non-secret pairs', () => {
      assert.strictEqual(
        r.text('GET /cb?code=1&access_token=abc123xyz&state=s'),
        `GET /cb?code=1&access_token=${REDACTED}&state=s`
      );
      assert.strictEqual(
        r.text('dial postgres://admin:s3cr3t@db.local:5432/shop'),
        `dial postgres://admin:${REDACTED}@db.local:5432/shop`
      );
      assert.strictEqual(r.text('Server=db;Password=hunter2;Encrypt=true'), `Server=db;Password=${REDACTED};Encrypt=true`);
    });

    it('leaves ordinary prose alone', () => {
      for (const s of [
        'Running basic validation for order 42',
        'task-scheduler finished in 20ms',
        'GET https://example.com/path?page=2&sort=asc',
        'user=bob status=200 duration=12ms',
        'The authorization step took 3ms',
      ]) {
        assert.strictEqual(r.text(s), s);
      }
    });

    it('masks long secrets completely', () => {
      const secret = 'q'.repeat(5000);
      assert.ok(!r.text(`token=${secret}`).includes('qqqq'));
      assert.ok(!r.text(`Bearer ${secret}`).includes('qqqq'));
    });

    it('applies to nested attribute values, arrays and log-like bodies', () => {
      const out = r.value({ body: { msg: 'token=abc12345' }, list: ['Bearer abcdefghijkl'] });
      assert.deepStrictEqual(out, { body: { msg: `token=${REDACTED}` }, list: [`Bearer ${REDACTED}`] });
    });
  });

  describe('structural fields', () => {
    it('leaves 32-hex trace ids and 16-hex span ids alone', () => {
      const text = `trace ${TRACE} span ${SPAN} traceparent 00-${TRACE}-${SPAN}-01 id=${TRACE}`;
      assert.strictEqual(r.text(text), text);
    });

    it('never touches ids, seq, code locations or timestamps', () => {
      const v = {
        traceId: TRACE,
        spanId: SPAN,
        parentSpanId: SPAN,
        instanceId: 'checkout::pod-1',
        seq: 7,
        code: { filepath: '/srv/app/auth/session_token.py', line: 42, column: 3, function: 'login' },
        time: '2026-01-01T00:00:00.000Z',
        startMs: 1767225600000,
        firstSeen: '2026-01-01T00:00:00.000Z',
      };
      assert.deepStrictEqual(r.value(v), v);
    });

    it('still redacts a structural key whose value has the wrong shape', () => {
      assert.deepStrictEqual(r.value({ traceId: 'Bearer abcdefghijkl' }), { traceId: `Bearer ${REDACTED}` });
    });
  });

  describe('safety', () => {
    it('returns deep copies and does not modify the input', () => {
      const input = {
        attrs: { password: 'p', nested: { msg: 'Bearer abcdefghijkl' } },
        list: [{ token: 't' }],
        body: 'x',
      };
      const snapshot = JSON.parse(JSON.stringify(input));
      const out = r.value(input);
      assert.deepStrictEqual(input, snapshot);
      assert.notStrictEqual(out, input);
      assert.notStrictEqual(out.attrs, input.attrs);
      assert.notStrictEqual(out.attrs.nested, input.attrs.nested);
      assert.notStrictEqual(out.list, input.list);
      assert.notStrictEqual(out.list[0], input.list[0]);
      const plain = { a: { b: 'c' } };
      assert.notStrictEqual(r.value(plain).a, plain.a);
    });

    it('treats a "__proto__" key as data', () => {
      const out = r.value(JSON.parse('{"__proto__": {"password": "p"}}'));
      assert.strictEqual(Object.getPrototypeOf(out), Object.prototype);
      assert.strictEqual(JSON.stringify(out), `{"__proto__":{"password":"${REDACTED}"}}`);
      assert.deepStrictEqual(r.value({ toString: 'Bearer abcdefghijkl', constructor: 'x' }), {
        toString: `Bearer ${REDACTED}`,
        constructor: 'x',
      });
    });

    it('does not overflow on deeply nested input', () => {
      let v: unknown = 'leaf';
      for (let i = 0; i < 10000; i++) v = { n: v };
      assert.doesNotThrow(() => r.value(v));
    });

    it('handles hostile 100 KB inputs without runaway backtracking', () => {
      const size = 100 * 1024;
      const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      const hostile = [
        fill('a'),
        fill(' '),
        fill('Bearer '),
        fill('Basic '),
        'Bearer ' + fill('a'),
        'eyJ' + fill('a'),
        fill('eyJaaaaa.'),
        fill('eyJaaaaa.bbbbb.'),
        fill('eyJa-'),
        fill('x eyJaaaaa.' + 'b'.repeat(200)),
        'eyJaaaaa.' + fill('b'),
        fill('-----BEGIN PRIVATE KEY-----'),
        '-----BEGIN ' + fill('A ') + 'PRIVATE',
        '-----BEGIN PRIVATE KEY-----' + fill('A'),
        fill('AKIA'),
        fill('ghp_'),
        fill('xoxb-'),
        fill('sk-'),
        fill('a://'),
        'a://' + fill('b:'),
        'a://b:' + fill('c'),
        fill('?a='),
        fill('&'),
        '&' + fill('a'),
        fill(' a'),
        ' ' + fill('a') + '=',
        fill('password='),
        fill('"password":"'),
        fill('a='),
        fill(' \t= '),
      ];
      for (const s of hostile) {
        const t = process.hrtime.bigint();
        r.text(s);
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        assert.ok(ms < 50, `took ${ms.toFixed(1)} ms on input starting ${JSON.stringify(s.slice(0, 20))}`);
      }
    });
  });
});

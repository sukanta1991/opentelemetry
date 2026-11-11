// SPDX-License-Identifier: Apache-2.0
// Per-language OTLP instrumentation snippets shown via the "Connect Your App…" flow.
import { envBlock, envLine, otlpEnv } from './connectApp';

export interface Snippet {
  language: string;
  /** VS Code language id used to open the snippet with syntax highlighting. */
  languageId: string;
  title: string;
  code: (endpoint: string) => string;
}

export const SNIPPETS: Snippet[] = [
  {
    language: 'Environment variables',
    languageId: 'shellscript',
    title: 'Environment variables, bash/zsh (any SDK)',
    code: (ep) => `${envBlock(otlpEnv(ep), 'posix')}\n${envLine('OTEL_SERVICE_NAME', 'my-service', 'posix')}`,
  },
  {
    language: 'Environment variables',
    languageId: 'powershell',
    title: 'Environment variables, PowerShell (any SDK)',
    code: (ep) => `${envBlock(otlpEnv(ep), 'powershell')}\n${envLine('OTEL_SERVICE_NAME', 'my-service', 'powershell')}`,
  },
  {
    language: 'Node.js',
    languageId: 'javascript',
    title: 'Node.js (@opentelemetry/sdk-node)',
    code: (ep) =>
      `import { NodeSDK } from '@opentelemetry/sdk-node';\n` +
      `import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';\n` +
      `const sdk = new NodeSDK({\n` +
      `  traceExporter: new OTLPTraceExporter({ url: '${ep}' }),\n` +
      `});\n` +
      `sdk.start();`,
  },
  {
    language: 'Python',
    languageId: 'python',
    title: 'Python (opentelemetry-sdk)',
    code: (ep) =>
      `from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter\n` +
      `exporter = OTLPSpanExporter(endpoint="${ep}", insecure=True)`,
  },
  {
    language: 'Go',
    languageId: 'go',
    title: 'Go (otlptracegrpc)',
    code: (ep) =>
      `exporter, _ := otlptracegrpc.New(ctx,\n` +
      `  otlptracegrpc.WithEndpointURL("${ep}"),\n` +
      `  otlptracegrpc.WithInsecure())`,
  },
  {
    language: '.NET',
    languageId: 'csharp',
    title: '.NET (OpenTelemetry)',
    code: (ep) =>
      `builder.Services.AddOpenTelemetry()\n` +
      `  .WithTracing(t => t.AddOtlpExporter(o => o.Endpoint = new Uri("${ep}")));`,
  },
  {
    language: 'Java',
    languageId: 'plaintext',
    title: 'Java (autoconfigure)',
    code: (ep) => `-Dotel.exporter.otlp.endpoint=${ep} -Dotel.exporter.otlp.protocol=grpc`,
  },
];

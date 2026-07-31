// Per-language OTLP instrumentation snippets shown via the "onboard external app" flow.
export interface Snippet {
  language: string;
  title: string;
  code: (endpoint: string) => string;
}

export const SNIPPETS: Snippet[] = [
  {
    language: 'Environment variables',
    title: 'Environment variables (any SDK)',
    code: (ep) =>
      `export OTEL_EXPORTER_OTLP_ENDPOINT="${ep}"\n` +
      `export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"\n` +
      `export OTEL_SERVICE_NAME="my-service"`,
  },
  {
    language: 'Node.js',
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
    title: 'Python (opentelemetry-sdk)',
    code: (ep) =>
      `from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter\n` +
      `exporter = OTLPSpanExporter(endpoint="${ep}", insecure=True)`,
  },
  {
    language: 'Go',
    title: 'Go (otlptracegrpc)',
    code: (ep) =>
      `exporter, _ := otlptracegrpc.New(ctx,\n` +
      `  otlptracegrpc.WithEndpointURL("${ep}"),\n` +
      `  otlptracegrpc.WithInsecure())`,
  },
  {
    language: '.NET',
    title: '.NET (OpenTelemetry)',
    code: (ep) =>
      `builder.Services.AddOpenTelemetry()\n` +
      `  .WithTracing(t => t.AddOtlpExporter(o => o.Endpoint = new Uri("${ep}")));`,
  },
  {
    language: 'Java',
    title: 'Java (autoconfigure)',
    code: (ep) => `-Dotel.exporter.otlp.endpoint=${ep} -Dotel.exporter.otlp.protocol=grpc`,
  },
];

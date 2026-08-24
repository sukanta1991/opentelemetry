# OpenTelemetry for VS Code

This extension brings **OpenTelemetry** debugging directly into VS Code. It runs a local **OTLP
receiver** inside the editor that collects **logs, traces, metrics, and service relationships**
from any application that exports OpenTelemetry data — whether the app is launched from VS Code or
run entirely outside it.

There's nothing else to install and run: no Jaeger, no Zipkin, no OpenTelemetry Collector, and no
extra containers. Point any OTLP-compatible SDK at the receiver and your telemetry appears in the
editor, grouped by service and instance. Data is kept **in memory** and cleared when the receiver
restarts.

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-v0.1.3-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=SukantaSaha.opentelemetry)
[![CI](https://github.com/sukanta1991/opentelemetry/actions/workflows/ci.yml/badge.svg)](https://github.com/sukanta1991/opentelemetry/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-green)

## Preview

Traces & spans — find slow or failing requests and examine them in a waterfall timeline:

![Traces panel](images/screenshots/traces.png)

Logs — search and filter, then jump straight to the source line:

![Logs panel](images/screenshots/logs.png)

Metrics — inspect gauges, counters, and histograms per service instance:

![Metrics panel](images/screenshots/metrics.png)

## What this extension does

- **Embedded OTLP receiver** — accepts **OTLP/gRPC** (default `4317`) and **OTLP/HTTP**
  (protobuf + JSON, default `4318`).
- **Logs** — search and filter by text, level, and attributes; resizable columns;
  displayed in capture-time order (`timeMs` / `observedTimeMs`), **Navigate To Code** to jump to
  the source line, and **Open In Editor** to view a log as JSON.
- **Traces & spans** — filter by duration, trace ID, or errors, and **Examine** any trace as a
  span waterfall. Distributed spans are merged by trace ID.
- **Metrics** — per-instance gauges, counters/sums, and histograms.
- **Service map** — services, databases, queues, and external dependencies inferred from spans.
- **Instances tree** — applications grouped by `service.name`, each with its own instances.

Works with any OTLP-compatible SDK — **Java, .NET, Go, Node.js, Python, Rust**, and others.

## Getting started

1. **Install** from the Extensions view (search “OpenTelemetry”), or from a terminal:

   ```bash
   code --install-extension SukantaSaha.opentelemetry
   ```

2. Open the **OpenTelemetry** view in the Activity Bar and click **Start receiver** (or start it
   from the status bar item). The status bar then shows the active gRPC and HTTP ports.

3. Point your application's OTLP exporter at the receiver. Its instance, logs, traces, and metrics
   appear as data arrives.

### Apps launched from VS Code

When you run or debug an app from VS Code, the extension automatically injects the
`OTEL_EXPORTER_OTLP_ENDPOINT` environment variable so a configured OTLP exporter sends data to the
receiver. You can disable this with the `otel.overwriteEnvVars` setting.

### Apps running outside VS Code

Point the exporter at the receiver yourself. Use the **OpenTelemetry: Copy OTLP Endpoint** or
**Copy OTLP Endpoint Environment Variable** commands (or **Show Instrumentation Snippet** for a
per-language example), then set:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
```

You can also route data through an
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) by adding the receiver as an
OTLP exporter target.

## Common workflows

**Debug a failing request**

1. Start your app and generate some traffic.
2. Open **Traces**, tick **errors only**, and select the failed trace.
3. Click **Examine** to open the span waterfall and find the slow or failing span.
4. Open **Logs**, filter by text or level, and use **Navigate To Code** to jump to the source.

**Understand what a service talks to**

1. Generate distributed traffic (HTTP calls, database queries, queue messages).
2. Open the **Service Map** to see services, databases, and queues and how they connect.

## Commands

| Command | Description |
| --- | --- |
| `OpenTelemetry: Start / Stop / Restart Receiver` | Control the embedded OTLP receiver. |
| `OpenTelemetry: Clear Collected Data` | Drop all in-memory telemetry. |
| `OpenTelemetry: Copy OTLP Endpoint` | Copy the gRPC or HTTP endpoint. |
| `OpenTelemetry: Copy OTLP Endpoint Environment Variable` | Copy `OTEL_EXPORTER_OTLP_ENDPOINT=…`. |
| `OpenTelemetry: Open Terminal With OTLP Environment` | New terminal pre-set with the OTLP env vars. |
| `OpenTelemetry: Show Instrumentation Snippet` | Per-language exporter snippets (Node/Python/Go/.NET/Java). |
| `OpenTelemetry: Open Logs / Traces / Metrics` | Open a panel for the selected instance. |
| `OpenTelemetry: Open Service Map` | Show the service dependency graph. |

Instances in the tree also expose inline **Logs / Traces / Metrics** icons and a **Remove
Instance** action.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `otel.launchOnStartup` | `false` | Start the receiver when VS Code starts. |
| `otel.port.mode` | `fixed` | `fixed` or `random` port assignment. |
| `otel.port.grpc` | `4317` | OTLP/gRPC port (fixed mode). |
| `otel.port.http` | `4318` | OTLP/HTTP port (fixed mode). |
| `otel.host` | `127.0.0.1` | Bind address. Binding beyond localhost exposes telemetry. |
| `otel.overwriteEnvVars` | `true` | Inject the OTLP endpoint into launch/debug configs. |
| `otel.retention.maxLogsPerInstance` | `5000` | Log retention cap per instance. |
| `otel.retention.maxTracesPerInstance` | `2000` | Trace retention cap per instance. |

Example `settings.json`:

```json
{
  "otel.launchOnStartup": true,
  "otel.port.mode": "fixed",
  "otel.port.grpc": 4317,
  "otel.port.http": 4318
}
```

## Troubleshooting

### The Instances view says the receiver isn't running

The receiver does not start automatically by default. Click **Start receiver** in the Instances
view (or the status bar), or set `otel.launchOnStartup` to `true` to start it whenever VS Code
launches.

### "Port already in use"

If the configured port is busy, the extension reports the error and offers to retry on randomly
assigned ports. You can also set `otel.port.mode` to `random`, or change `otel.port.grpc` /
`otel.port.http` to free ports.

### No telemetry appears

- Confirm the exporter endpoint matches the receiver: **gRPC** uses `4317`, **HTTP** uses `4318`.
  Set `OTEL_EXPORTER_OTLP_PROTOCOL` (`grpc` or `http/protobuf`) accordingly.
- For apps launched from VS Code, make sure `otel.overwriteEnvVars` is `true`.
- For external apps, copy the endpoint with **OpenTelemetry: Copy OTLP Endpoint** and verify your
  SDK is actually exporting.

> **Note:** the receiver binds to `127.0.0.1` by default. A firewall prompt may appear the first
> time it starts.

### "Navigate To Code" doesn't jump anywhere

Navigate To Code applies to **log entries** and requires source-location attributes
(`code.filepath` / `code.lineno`) on the log record. If those attributes aren't present, the
action is unavailable. It also can't navigate to third-party or decompiled code.

### My collected data disappeared

Telemetry is stored **in memory** and is cleared when the receiver restarts. Configurable
export/persistence is planned.

### The settings gear opens an empty page

This was fixed in `0.1.2`. Update to the latest version, or open settings manually and search for
“OpenTelemetry”.

## Roadmap

Planned and under exploration — feedback welcome via
[issues](https://github.com/sukanta1991/opentelemetry/issues):

- Configurable export and persistence (beyond the in-memory store)
- Metric charts (metrics are tabular today)
- Richer search and filtering for logs and traces, plus live tailing
- Deeper service-map analytics (latency, error rates, throughput)

## Contributing

Issues and pull requests are welcome at
[github.com/sukanta1991/opentelemetry](https://github.com/sukanta1991/opentelemetry). Please read
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) first.
See [`CHANGELOG.md`](./CHANGELOG.md) for release notes.

For contributors, from a clone:

```bash
npm install
npm run build     # bundle with esbuild
npm run typecheck # type-check
npm run lint      # eslint
npm test          # unit + smoke + activation tests
npm run package   # produce a .vsix
```

Press **F5** to launch the Extension Development Host.

## License

[MIT](./LICENSE) © Sukanta Saha

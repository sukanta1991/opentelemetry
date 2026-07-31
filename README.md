<h1 align="center">OpenTelemetry for VS Code</h1>

<p align="center">
  <em>Runtime observability, right inside your editor.</em><br/>
  Collect and explore OpenTelemetry <strong>logs, metrics, traces &amp; spans</strong> and a
  <strong>service map</strong> from any app — via an embedded OTLP receiver. No external collector required.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=SukantaSaha.opentelemetry"><img alt="Version" src="https://img.shields.io/visual-studio-marketplace/v/SukantaSaha.opentelemetry?color=1e88e5&label=Marketplace&logo=visual-studio-code"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SukantaSaha.opentelemetry"><img alt="Installs" src="https://img.shields.io/visual-studio-marketplace/i/SukantaSaha.opentelemetry?color=1e88e5"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SukantaSaha.opentelemetry"><img alt="Downloads" src="https://img.shields.io/visual-studio-marketplace/d/SukantaSaha.opentelemetry?color=1e88e5"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SukantaSaha.opentelemetry"><img alt="Rating" src="https://img.shields.io/visual-studio-marketplace/r/SukantaSaha.opentelemetry?color=1e88e5"></a>
  <a href="https://github.com/sukanta1991/opentelemetry/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sukanta1991/opentelemetry/actions/workflows/ci.yml/badge.svg"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
</p>

---

This extension embeds a local **OTLP receiver** ("Satellite service") that collects **logs,
metrics, and traces** from any application that exports OpenTelemetry data — whether launched
from VS Code or run externally — and lets you explore it through an instances tree, logs,
traces/spans, metrics, and a service map. It is a language-agnostic VS Code re-imagining of the
JetBrains Rider OpenTelemetry plugin.

## ✨ Features

- **Embedded OTLP receiver** — in-process Node.js server accepting **OTLP/gRPC** (default `4317`)
  and **OTLP/HTTP** (protobuf + JSON, default `4318`). No external collector or binaries.
- **Instances tree** — applications (grouped by `service.name`) → instances (identified by
  `service.instance.id` or a synthesized GUID). Remove instances from the context menu.
- **Logs** — timestamp, level, message, and attributes with text/level/attribute filtering,
  **Navigate To Code** (via `code.filepath`/`code.lineno`), and **Open In Editor** (JSON).
- **Traces & spans** — filter traces by duration/ID/errors and **Examine** any trace as a span
  **waterfall** (distributed spans across services are merged by trace ID).
- **Metrics** — per-instance view of gauges, sums, and histograms.
- **Service map** — architecture diagram of services, databases, queues, and external
  dependencies derived from trace spans, refreshed as data arrives.
- **Launch/debug integration** — auto-injects `OTEL_EXPORTER_OTLP_ENDPOINT` into VS Code
  launch/debug configs, plus copy-endpoint commands, an OTel-enabled terminal, and per-language
  instrumentation snippets for **external apps**.

> Telemetry is stored **in memory** and cleared when the receiver restarts (Phase 1).

## 🚀 Quick start

1. **Install** from the Extensions view (search “OpenTelemetry”), or:
   ```bash
   code --install-extension SukantaSaha.opentelemetry
   ```
2. Open the **OpenTelemetry** view in the Activity Bar and click **Start receiver** (or use the
   status bar item). The status bar shows the active gRPC/HTTP ports.
3. Point your app at the receiver and watch instances, logs, traces, and metrics appear.

### Wire up your app

**Launched from VS Code** — just run/debug; the OTLP endpoint env var is injected automatically
(disable via `otel.overwriteEnvVars`).

**Running externally** — point your app's OTLP exporter at the receiver. Use
**OpenTelemetry: Copy OTLP Endpoint / Copy Environment Variable**, or **Show Instrumentation
Snippet**, e.g.:
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
```
You can also route through an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/)
by adding the receiver as an OTLP exporter target.

## 🧭 Commands

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

Instances also expose inline **Logs / Traces / Metrics** icons and a **Remove Instance** action.

## ⚙️ Settings

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

## 🏗️ Architecture

- `src/receiver/` — gRPC (`@grpc/grpc-js` + `@grpc/proto-loader`) and HTTP (`protobufjs`) OTLP
  servers, plus the `Receiver` lifecycle facade.
- `src/store/` — OTLP decoding and the in-memory `TelemetryStore` (applications → instances →
  logs/traces/metrics) with ring-buffer retention and debounced change events.
- `src/views/` — the instances `TreeDataProvider` and the Logs, Traces, Metrics, and Service Map
  webview panels.
- `src/integration/` — debug-config env injection and instrumentation snippets.
- `proto/` — vendored `opentelemetry-proto` definitions (bundled into `dist/proto`).

## 🧪 Development

```bash
npm install
npm run build         # bundle with esbuild (copies proto assets to dist/)
npm run watch         # rebuild on change
npm run typecheck     # type-check only
npm run lint          # eslint
npm test              # build + unit + smoke + activation tests
npm run package       # produce a .vsix
```

Press **F5** to launch the Extension Development Host.

## 🚧 Limitations (Phase 1)

- Telemetry is in-memory only; configurable export/persistence is a planned enhancement.
- The receiver binds to `127.0.0.1` with no TLS/auth (localhost-only by design).
- Navigate To Code depends on `code.*` span/log attributes being present.
- Service-map edges are heuristic (span kind + trace parent/child + semantic-convention attrs).

## 🤝 Contributing

Issues and pull requests are welcome at
[github.com/sukanta1991/opentelemetry](https://github.com/sukanta1991/opentelemetry).
See [`PUBLISHING.md`](./PUBLISHING.md) for the release process.

## 📄 License

[MIT](./LICENSE) © Sukanta Saha

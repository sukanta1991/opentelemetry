# Connect your app

Any OpenTelemetry SDK can send to the receiver. Pick the way your app starts.

## Started with F5 from VS Code

Nothing to do. While the receiver is running, every debug session gets `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_PROTOCOL` automatically (setting `otel.overwriteEnvVars`).

## Started from a terminal

Run **OpenTelemetry: Open Terminal With OTLP Environment**, or set these variables in your own shell.

bash / zsh:

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4317'
export OTEL_EXPORTER_OTLP_PROTOCOL='grpc'
export OTEL_TRACES_EXPORTER='otlp'
export OTEL_METRICS_EXPORTER='otlp'
export OTEL_LOGS_EXPORTER='otlp'
export OTEL_SERVICE_NAME='my-service'
```

PowerShell:

```powershell
$env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4317'
$env:OTEL_EXPORTER_OTLP_PROTOCOL = 'grpc'
$env:OTEL_TRACES_EXPORTER = 'otlp'
$env:OTEL_METRICS_EXPORTER = 'otlp'
$env:OTEL_LOGS_EXPORTER = 'otlp'
$env:OTEL_SERVICE_NAME = 'my-service'
```

## Running in a container or on another machine

Use an address of this machine that the app can reach instead of `127.0.0.1` (Docker Desktop: `host.docker.internal`). The receiver binds to `127.0.0.1` by default; if connections are refused, set `otel.host` to `0.0.0.0` so it accepts them from outside. Only do this on a network you trust.

## Nothing shows up?

- An OTLP/HTTP exporter needs port `4318` and `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`.
- Check that your app's SDK is actually started (for Node.js, load it before your app code).
- If the receiver is on random ports, use **Connect Your App…** to copy the current endpoint.

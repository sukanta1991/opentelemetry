# Start the receiver

The extension has its own OTLP receiver built in, so you don't need a Collector, Jaeger or Grafana. When it's running, it listens on your machine:

| Protocol | Default endpoint |
|---|---|
| OTLP/gRPC | `http://127.0.0.1:4317` |
| OTLP/HTTP | `http://127.0.0.1:4318` |

The status bar shows the receiver's state (`OTel: off` or the two ports). Hover it to see the exact endpoints.

If the ports are already taken (for example by a local Collector), the extension offers to use random free ports instead.

Data stays in memory on your machine and is cleared when VS Code closes, unless you save a session.

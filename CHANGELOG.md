# Changelog

All notable changes to the **OpenTelemetry for VS Code** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Live service dependency map.** The Service Map now lays out services top-down from callers to callees and shows, for every service, dependency and call:
  - p50/p95 latency, error rate, call count and **req/min**, plus a sparkline of recent traffic.
  - A health colour and icon (**Healthy ●**, **Warning ▲**, **Critical ✖**, **Idle ○**) from the worse of error rate and p95 latency.
  - A **time window** picker (1 min … 2 hours, or all retained data), measured back from the newest span like the Traces and Logs panels, with a **partial window** badge when less data is available.
  - A **details panel**: callers and callees, top operations, recent errors, slowest traces and source files, with buttons to open the service's **Traces**, **Logs** and **Metrics** (a picker appears for multi-instance services).
  - Zoom, pan, **Fit** and **Re-layout**; keyboard navigation (Tab, Enter, Esc). The map updates live, at most twice a second, and does no work while hidden.
- Settings `otel.serviceMap.latencyWarnMs` (300), `otel.serviceMap.latencyCriticalMs` (1000), `otel.serviceMap.errorRateWarn` (0.01) and `otel.serviceMap.errorRateCritical` (0.05). They can be set per workspace.

### Fixed

- The service map and the `otel_getServiceMap` tool could draw a wrong cross-service edge when two traces reused the same span ID. Parent spans are now looked up within their own trace.

## [1.0.0] - 2026-10-05

First stable release. No functional changes from 0.6.1. From now on, settings, commands and language model tool names follow semantic versioning: breaking changes only in a new major version.

### Changed

- **License changed from MIT to the Apache License 2.0**, with the consent of all contributors. A `NOTICE` file credits the bundled OpenTelemetry protocol definitions.
- Contributions are now accepted under the Apache License 2.0 (section 5); see `CONTRIBUTING.md`.

## [0.6.1] - 2026-10-05

### Added

- Project website with a user guide (getting started, features, query syntax, AI, privacy, reference and troubleshooting) at <https://sukanta1991.github.io/opentelemetry/>. The Marketplace **Homepage** link now points to it.

## [0.6.0] - 2026-10-03

### Added

- Local timezone display for log and trace timestamps and metric chart axes. The `otel.useLocalTime` setting switches between local time and UTC; the default is local time.
- **Save Session / Load Session**: save everything the receiver captured (traces, logs and metrics, including metric history) to one `.otel.json` file and load it back later. Each section of the file is a standard OTLP `Export*ServiceRequest`.
- Save scopes: all data (**Save Session…** in the Instances toolbar), one instance (**Save Instance…** on an instance), one loaded file, or one trace with its correlated logs (**Export Trace…** when you right-click a row in the Traces panel).
- **Load Session…** also accepts a bare OTLP/JSON request and OpenTelemetry Collector file-exporter JSON Lines, for example CI artifacts.
- Loaded files appear under **Imported**. A file with several services becomes one node you can open as a service map, save again, or remove. Imported instances now also open in Traces and Metrics.

### Changed

- Logs, Traces and metric chart axes now show timestamps in your local timezone instead of UTC, because `otel.useLocalTime` defaults to `true`. CSV and JSON log exports follow the same setting. Set it to `false` to keep UTC.
- Each loaded file is isolated: waterfalls, trace-to-log links and the service map join only data from the same file, and live views no longer mix in imported data. AI tools still read everything.
- `otel.import.maxFileSize` and `otel.import.maxRecords` also apply to loaded sessions. For sessions, `maxRecords` counts spans, logs and metric points together.
- OTLP/JSON log export now keeps sub-millisecond timestamps.
- README reorganised: why and when to use the extension, features at a glance, a privacy and data-handling section, and a comparison with Jaeger and Grafana. The detailed feature list moved further down.
- Added `SECURITY.md` and `SUPPORT.md`.

### Security

- An attribute named `__proto__` in received or loaded telemetry is now stored as a normal key and can no longer replace an object's prototype.

## [0.5.0] - 2026-09-28

### Added

- **Ask Copilot about your telemetry (opt-in).** Enable the `otel.ai.enabled` user setting, then ask the new **`@otel`** chat participant questions such as "why is my slowest request slow?". Slash commands: `/slow`, `/errors` and `/agent`. Answers cite trace and span IDs and end with buttons that open the trace, span, logs or source line.
- **Nine language model tools** for Copilot agent mode and any chat participant: `otel_listServices`, `otel_searchTraces`, `otel_findSpans`, `otel_getTrace`, `otel_compareTraces`, `otel_queryLogs`, `otel_queryMetrics`, `otel_getServiceMap` and `otel_genAiSummary`. Reference them in prompts as `#otelServices`, `#otelTraces`, `#otelSpans`, `#otelTrace`, `#otelCompare`, `#otelLogs`, `#otelMetrics`, `#otelServiceMap` and `#otelAgent`. They cover:
  - trace search and grouping with p50/p95 and error rates
  - span self-time
  - critical path
  - comparison against a median baseline
  - log and metric queries
  - the service graph
  - AI-agent runs (`gen_ai.*`): LLM vs. tool time, tokens per model, slowest and failed tool calls
- Settings: `otel.ai.enabled` (default off, user-level only), `otel.ai.redactAttributeKeys` and `otel.ai.maxResultItems`.
- An **OpenTelemetry AI** output channel. It logs each tool call, and at Debug level the exact text sent to the model.
- An internal `otel._openSource` command that opens a code location. It uses the same path checks as Navigate To Code.
- `npm run push:genai` sends a sample AI-agent trace for trying `@otel /agent`.

### Changed

- **Minimum VS Code version is now 1.95.** That is the first release with stable language model tool and chat APIs. In VS Code builds without these APIs, the extension still activates without the AI features.
- The service map's graph building moved to its own module (`src/views/serviceGraph.ts`). The map itself is unchanged.
- The packaged extension no longer includes internal docs or TypeScript type files: 536 files instead of 957.

### Security

- AI access is off by default. It can only be enabled in user settings, never by a workspace. Each tool call needs your confirmation in chat.
- Data is redacted before it is sent:
  - keys such as `authorization`, `cookie`, `password`, `token`, `secret`, API keys and connection strings
  - Bearer/Basic credentials, JWTs, AWS, GitHub, Slack and `sk-` keys, private keys, URL passwords and `password=` pairs in any text
  - Redaction works on copies, so the stored telemetry and the panels are unchanged.
  - The patterns are fixed and resistant to runaway backtracking (ReDoS), and none come from user input.
- Prompt and completion text in AI-agent spans is never sent, only its length.
- Results are size-limited.
- Telemetry is treated as untrusted input. The tools are read-only, and only this extension's tools are offered to the model. Button arguments come from validated IDs only, never from text the model wrote.
- No new runtime dependencies.

## [0.4.0] - 2026-09-25

### Added

- **Trace ↔ log correlation.** Logs gain a **View Trace** button, and their Trace ID / Span ID cells are clickable. Either opens the trace's waterfall with the log's span selected. From a trace or span, **View logs** opens Logs filtered to it: a clearable chip shows the filter, and the time range is ignored while it is active. When a trace's logs come from several instances, a picker shows the count per instance.
- **Logs in the waterfall.** Each span's correlated logs are drawn as severity-coloured markers on its bar. Nearby markers are grouped. Logs outside the span's time are pinned to its edge and flagged. Logs with the trace ID but no matching span appear in a trace-level strip. A **Show logs** toggle is remembered.
- **Span details pane.** Adds **links** (open a collected linked trace, then **Back**), the span's logs with **Open in Logs** (jumps to that row), the collapsible **resource**, exception stack traces in a scrollable block, **Copy span ID**, and **Navigate To Code** for spans with `code.*` attributes. Span links and code locations are now decoded from OTLP.
- **Traces panel rebuilt.**
  - The trace list is virtualized and can be sorted by any column (start, duration, spans, errors, logs…).
  - Columns can be resized and reordered, and root-span attributes can be added as columns.
  - Filters for service, span name, status, kind, attributes (several, AND'd), min/max duration and trace ID; the time-range picker from Logs; and an advanced **query bar**, e.g. `service=checkout status=error dur>200ms http.status_code>=500`.
  - Span conditions must match the same span. Traces from several services are shown as one entry, with root, services and counts combined.
  - The open waterfall refreshes live.
- **OpenTelemetry: Find Trace by ID** opens a trace from a trace ID or a W3C `traceparent`.
- `test/scripts/push-correlated.ts` sends linked traces and logs (plus a `--bulk` mode) for trying these features without an instrumented app.

### Changed

- The traces list refreshes at most twice a second, and hidden Traces panels stop updating until shown.
- Navigate To Code prefers the closest path match. When several files match equally, you pick one.

### Fixed

- Traces: spans whose parents form a cycle, or that point to themselves, were silently missing from the waterfall; they are now shown and flagged. Very deep traces no longer risk a stack overflow. Duplicate copies of a span collapse into one.
- Traces: the root span is now the earliest span with no parent, whatever order spans arrive in; it is no longer simply the last one received.
- Trace and span IDs are normalized (lowercase hex; `0x` prefixes and dashes stripped) for received and imported data, so logs and traces match reliably. All-zero IDs are treated as "no trace context".

### Security

- Navigate To Code resolves paths only inside workspace folders and refuses non-file URIs. It escapes glob characters in the fallback search. It asks for confirmation before opening an absolute path outside the workspace, because telemetry can come from any process.
- Webview messages are validated on the extension side. Actions such as View Trace, View logs, Open in Logs, following a link and Copy only work on IDs the extension already holds for the current view.
- Webview nonces now come from `crypto.randomBytes`.

## [0.3.2] - 2026-09-24

### Added

- Traces panel: click a span in the waterfall (or focus it and press Enter/Space) to open a **span details** pane with its status, duration, IDs, scope, **attributes** and **events**. Structured values are pretty-printed as JSON and long values scroll in place ([#13](https://github.com/sukanta1991/opentelemetry/issues/13)).
- Traces panel: an **attribute filter** (`key` or `key=value`) narrows the trace list to traces with a span that has the attribute, or whose value contains the text (case-insensitive).

### Fixed

- Traces panel: quotes in span names no longer break the waterfall row tooltip.

## [0.3.1] - 2026-09-22

### Added

- Logs import: JSON Lines files (`.jsonl` or `.ndjson`) are now supported alongside OTLP/JSON
  and exported plain JSON.

### Fixed

- Logs panel: generated table rows now render correctly while telemetry cell values remain escaped.

## [0.3.0] - 2026-09-20

### Added

- Logs panel: a **Columns** button opens a picker to show or hide any of Time, Observed Time,
  Level, Severity #, Message, Attributes, Scope, Trace ID, Span ID, Code Location and Function.
  Individual log **attributes** can be promoted to their own sortable columns. The "Shown" list
  is drag-to-reorder, the catalogue is searchable, and **Reset** restores the defaults.
- Logs panel: **every** column is now resizable, including Time and Level. Double-click a
  resize handle to fit the column to its content. Widths, order and visibility persist per
  instance panel.
- Logs panel: a **row height** control with Raw (full wrap), 1 line, 2 lines, and Condensed
  (max 4 lines) modes.
- Logs panel: a **time-range picker** (1 min, 2 min, 5 min, 15 min, 30 min, 1 hour, 2 hours,
  or All logs) anchored to the newest log received, so rows stay visible after the emitting app
  stops. A hint appears when retention holds less history than the selected window, with a
  shortcut to raise `otel.retention.maxLogsPerInstance`.
- Logs panel: **click-to-sort** headers for Time, Observed Time, Severity and attribute columns.
- Logs panel: a **Pause** toggle that freezes the view while logs keep arriving in the
  background, showing how many are queued.
- Logs panel: **multi-select** via Cmd/Ctrl+click, Shift+click ranges and Cmd/Ctrl+A, plus an
  optional selection checkbox column with a select-all header.
- Logs panel: **Export…** writes logs as OTLP/JSON, plain JSON, or CSV, choosing between the
  visible columns or all attributes, a record count, and the filtered, all, or selected rows.
  Also available as `OpenTelemetry: Export Logs`.
- New command `OpenTelemetry: Import Logs From File` (and an upload icon in the Instances view)
  loads OTLP/JSON or previously exported plain JSON into a read-only instance under a new
  **Imported** node. Imported instances are exempt from retention, survive
  **Clear Collected Data**, and are removed only explicitly.
- New settings `otel.import.maxFileSize` (default `200` MB) and `otel.import.maxRecords`
  (default `50000`) bound what a single import may load.

### Changed

- **Breaking (display):** the Logs table now sorts **newest first**, with new logs appearing at
  the top. It previously showed oldest first and appended at the bottom. Click the **Time**
  header to switch back to ascending order.
- Logs panel: the table is now **virtualized** and only renders the visible rows, removing the
  previous 2000-row display cap. The extension host also sends only newly arrived records
  instead of re-sending the whole buffer on every update, so streaming no longer re-renders the
  table several times a second.
- Logs panel: the **Attributes** column now shows every attribute rather than the first eight.

### Fixed

- Logs panel: the table header no longer scrolls away with the rows.
- Logs panel: selecting a log after older entries were dropped from the retention buffer could
  target the wrong record; **Navigate To Code** and **Open In Editor** now resolve the intended
  log. Selection and scroll position are also preserved as new logs arrive.

## [0.2.2] - 2026-09-19

### Fixed

- Graph view page reload issue on every metrics ingestion. 

## [0.2.1] - 2026-09-19

### Added

- **Experimental.** The Metrics Graph aggregation, time-range and step controls below are new
  and we are actively collecting feedback — defaults and behaviour may change in a future
  release. Please report anything surprising at
  <https://github.com/sukanta1991/opentelemetry/issues>.
- Metrics Graph cards now have an **Over time** dropdown that aggregates each series into
  fixed-width time buckets (avg / min / max / sum / last / count / std-dev / P50 / P90 / P95 /
  P99) and reshapes the plotted line, plus a **Series** dropdown (sum / avg / min / max / P95
  across label sets) for multi-series scalar metrics. Both choices persist per metric across
  panel reopens.
- Metrics Graph view now has a **time-range picker** in the toolbar (1 min, 2 min, 5 min,
  15 min, 30 min, 1 hour, 2 hour) that applies to every graph at once and pins the x-axis to
  the selected window, plus a **Step** control for the over-time bucket width (Auto, 10s, 30s,
  1 min, 2 min, 5 min, 15 min, 30 min). Auto follows the range; a coarser step gathers several
  samples per bucket so the aggregations actually differ from each other. The bucket is never
  finer than the metric's own export interval, and a hint appears when the retained history is
  shorter than the range.

### Changed

- Metrics Graph card headers now put the metric name on its own full-width row, so long names
  are no longer truncated by the dropdowns. The type and unit badges moved into the title
  tooltip alongside the description.

### Removed

- The Metrics Graph **Statistic** readout beside each chart. The equivalent aggregations are
  now applied to the graph itself via the **Over time** dropdown.

- Metrics Graph view now has a **per-graph chart-type dropdown** with options scoped to each
  metric's OTEL type: counters and updown-counters offer line, rate, stacked-area, area, bar,
  and table; gauges add a single-value gauge readout; summaries add a percentile view;
  histograms render bucket bars. For updown-counters the `rate` view keeps genuine increases
  and decreases, while monotonic counters clamp resets. The selected chart type is remembered
  per metric across panel reopens. Counters and updown-counters are distinguished via sum
  monotonicity.

## [0.2.0] - 2026-08-29

### Added

- Metrics panel now offers a **Graph** view alongside the existing table: gauge/sum metrics
  render as time-series line charts, histograms as bucket-distribution bar charts, and
  summaries as per-quantile lines. Charts use theme-aware colors and render fully offline.
- New setting `otel.retention.maxMetricPointsPerSeries` (default 500) controls how much
  metric history is retained per series for graphing.

### Fixed

- Sanitized webview content to prevent a cross-site scripting (XSS) vulnerability caused by
  unescaped characters in rendered telemetry.

## [0.1.3] - 2026-08-24

### Fixed

- Logs are now displayed in chronological capture order by `timeMs` or `observedTimeMs`, even when OTLP telemetry arrives out of order or in batches.

## [0.1.2] - 2026-08-01

### Added

- Sample configurations to help users get started quickly.

### Changed

- Telemetry table columns can now be resized.

## [0.1.1] - 2026-07-31

### Fixed

- Corrected extension settings not being applied as expected.
- Updated icons to match Marketplace standards.

## [0.1.0] - 2026-07-31

### Added

- Initial release: embedded OTLP receiver with panels for logs, metrics, traces, spans, and a service map.

# Changelog

All notable changes to the **OpenTelemetry for VS Code** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

# Changelog

All notable changes to the **OpenTelemetry for VS Code** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

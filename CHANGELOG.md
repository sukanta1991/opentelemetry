# Changelog

All notable changes to the **OpenTelemetry for VS Code** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Metrics panel now offers a **Graph** view alongside the existing table: gauge/sum metrics
  render as time-series line charts, histograms as bucket-distribution bar charts, and
  summaries as per-quantile lines. Charts use theme-aware colors and render fully offline.
- New setting `otel.retention.maxMetricPointsPerSeries` (default 500) controls how much
  metric history is retained per series for graphing.

### Fixed

- Logs are now displayed in chronological capture order by `timeMs` or `observedTimeMs`, even when OTLP telemetry arrives out of order or in batches.

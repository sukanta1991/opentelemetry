# Changelog

All notable changes to the **OpenTelemetry for VS Code** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

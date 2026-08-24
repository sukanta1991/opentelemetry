# Changelog

All notable changes to the **OpenTelemetry for VS Code** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Logs are now displayed in chronological capture order by `timeMs` or `observedTimeMs`, even when OTLP telemetry arrives out of order or in batches.

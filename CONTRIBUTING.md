# Contributing to OpenTelemetry for VS Code

Thanks for your interest in contributing! This document explains how to set up the project,
make changes, and submit them. By participating, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Getting started

**Prerequisites:** Node.js 20+ and VS Code.

```bash
git clone https://github.com/sukanta1991/opentelemetry.git
cd opentelemetry
npm install
npm run build
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

## Development workflow

| Command | Purpose |
| --- | --- |
| `npm run build` | Bundle the extension with esbuild (copies proto assets to `dist/`). |
| `npm run watch` | Rebuild on change. |
| `npm run typecheck` | Type-check only (`tsc --noEmit`). |
| `npm run lint` | Run ESLint. |
| `npm test` | Build + unit + smoke + activation tests. |
| `npm run package` | Produce a `.vsix`. |

Please run `npm run typecheck`, `npm run lint`, and `npm test` before opening a pull request.

## Project layout

- `src/receiver/` — gRPC and HTTP OTLP servers plus the `Receiver` lifecycle facade.
- `src/store/` — OTLP decoding and the in-memory `TelemetryStore`.
- `src/views/` — the instances tree and the Logs, Traces, Metrics, and Service Map webviews.
- `src/integration/` — debug-config env injection and instrumentation snippets.
- `proto/` — vendored `opentelemetry-proto` definitions.
- `test/` — unit, integration (smoke), and activation tests.

## Making changes

1. Create a branch from `main`: `git checkout -b feat/my-change`.
2. Keep changes focused and small. Add or update tests where it makes sense.
3. Follow the existing code style (TypeScript, ESLint, Prettier defaults). Comment only where
   clarification is genuinely needed.
4. Update documentation (`README.md`, `CHANGELOG.md` under **Unreleased**) when behavior changes.

## Commit messages

Use clear, imperative commit messages (e.g., "Fix sticky header in Logs panel"). Reference
related issues where applicable (e.g., `Fixes #12`).

## Pull requests

- Fill out the pull request template.
- Ensure CI is green (typecheck, lint, build, tests across the OS/Node matrix).
- Describe what you changed and how you tested it. Screenshots/GIFs are welcome for UI changes.

## Reporting bugs & requesting features

Please use the [issue templates](https://github.com/sukanta1991/opentelemetry/issues/new/choose).
Include your VS Code version, OS, extension version, and the OTLP source/exporter you used.

## Releases

Maintainers: see [`PUBLISHING.md`](./PUBLISHING.md) for the Marketplace release process.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).

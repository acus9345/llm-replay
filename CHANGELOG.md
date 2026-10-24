# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-24

### Added

- `tapeFetch`, `withTape` and `installTape`: record LLM API calls once, replay them in tests.
- Streaming responses recorded chunk by chunk, with optional realistic replay timing.
- Clear failure when a request no longer matches a recording, showing what changed.
- Secrets stripped from saved files.

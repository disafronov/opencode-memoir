## [1.1.6](https://github.com/disafronov/opencode-memoir/compare/v1.1.5...v1.1.6) (2026-06-17)

## [1.1.5](https://github.com/disafronov/opencode-memoir/compare/v1.1.4...v1.1.5) (2026-06-16)

### Bug Fixes

* add retry limit for taxonomy fetch ([c7bdf23](https://github.com/disafronov/opencode-memoir/commit/c7bdf233cef75099afd51056cc392be6032f94c1))
* add TTL expiration to noGitCache ([bdea287](https://github.com/disafronov/opencode-memoir/commit/bdea287095b3ba02321eea02f7589832181ab2df))
* log errors in dispose hook instead of swallowing ([5469f4e](https://github.com/disafronov/opencode-memoir/commit/5469f4eab2dc7826122c2e13f131f1a4a2e71b51))
* **security:** sanitize secrets in memoir:remember command ([9f124ff](https://github.com/disafronov/opencode-memoir/commit/9f124ff1636dde59b4cdcea5fd71051ddbe63abf))
* **security:** scrub process.env for spawned child process ([bf90935](https://github.com/disafronov/opencode-memoir/commit/bf90935effeab054f5edb92af160a53e97686c11))

## [1.1.4](https://github.com/disafronov/opencode-memoir/compare/v1.1.3...v1.1.4) (2026-06-16)

## [1.1.3](https://github.com/disafronov/opencode-memoir/compare/v1.1.2...v1.1.3) (2026-06-15)

### Bug Fixes

* remove dead CLI retry in runMemoir and use cached storeRoot in command hooks ([399ce39](https://github.com/disafronov/opencode-memoir/commit/399ce39191bd4295dfcee3362fc20ea7b9cb7cff))

## [1.1.2](https://github.com/disafronov/opencode-memoir/compare/v1.1.1...v1.1.2) (2026-06-14)

## [1.1.1](https://github.com/disafronov/opencode-memoir/compare/v1.1.0...v1.1.1) (2026-06-14)

### Bug Fixes

* add .catch() to fire-and-forget async IIFE in event hook ([9f80b20](https://github.com/disafronov/opencode-memoir/commit/9f80b206f47133ba545f79330f3975cc63ae1a72))
* do not count failed diffs as unmerged branches ([bef5b74](https://github.com/disafronov/opencode-memoir/commit/bef5b7496cea9b3c767fdca1c64c3f7049f31829))
* return error string from statusJson instead of throwing ([62c4145](https://github.com/disafronov/opencode-memoir/commit/62c4145b41789b61084775f87df839bb31bf31b9))
* wrap dispose hook and ensureStore creation in try/catch ([daae5fd](https://github.com/disafronov/opencode-memoir/commit/daae5fd1596be62066f0d78527e3aa0c0f7120d1))

## [1.1.0](https://github.com/disafronov/opencode-memoir/compare/v1.0.8...v1.1.0) (2026-06-14)

### Features

* expand SECRET_PATTERN with AWS, connection string, and PEM key detection ([5fa7de0](https://github.com/disafronov/opencode-memoir/commit/5fa7de00d57905ff8c197c67c02a2b5c65028cb1))

### Bug Fixes

* wire expanded SECRET_PATTERN from utils.ts into recall-gate.ts ([1020abf](https://github.com/disafronov/opencode-memoir/commit/1020abf76f5b9fc2a00daa81d53895c8c1db5004))

## [1.0.7](https://github.com/disafronov/opencode-memoir/compare/v1.0.6...v1.0.7) (2026-06-11)

### Bug Fixes

* prepublishOnly smoke check + remove double build in CI ([483cb1e](https://github.com/disafronov/opencode-memoir/commit/483cb1ebc131c0d7e1506e25bf6ad677c4726d8c))

## [1.0.6](https://github.com/disafronov/opencode-memoir/compare/v1.0.5...v1.0.6) (2026-06-11)

### Bug Fixes

* bundle plugin into single file with esbuild for OpenCode compatibility ([9ede303](https://github.com/disafronov/opencode-memoir/commit/9ede303c604be4010c7756966a7d6aafc57e1d42))

## [1.0.5](https://github.com/disafronov/opencode-memoir/compare/v1.0.4...v1.0.5) (2026-06-11)

### Bug Fixes

* change plugin export to named export for OpenCode 1.17+ compatibility ([a6e2f12](https://github.com/disafronov/opencode-memoir/commit/a6e2f1226bb98f098de58d648a8355bff28d8547))

## [1.0.4](https://github.com/disafronov/opencode-memoir/compare/v1.0.3...v1.0.4) (2026-06-11)

### Bug Fixes

* update exports field for CJS compatibility in plugin loading ([bd6741b](https://github.com/disafronov/opencode-memoir/commit/bd6741bed4e32864042142b88963d2f339e37008))

## [1.0.3](https://github.com/disafronov/opencode-memoir/compare/v1.0.2...v1.0.3) (2026-06-11)

### Bug Fixes

* move npm upgrade before npm ci in publish workflow ([265373c](https://github.com/disafronov/opencode-memoir/commit/265373cafcefeb0844534c0e6708eeebbbec49f5))

## [1.0.2](https://github.com/disafronov/opencode-memoir/compare/v1.0.1...v1.0.2) (2026-06-11)

### Bug Fixes

* upgrade npm to latest for OIDC support in publish workflow ([0ac7604](https://github.com/disafronov/opencode-memoir/commit/0ac7604202eada3114dce47f97ed829a6b06f9e3))

## [1.0.1](https://github.com/disafronov/opencode-memoir/compare/v1.0.0...v1.0.1) (2026-06-11)

### Bug Fixes

* version ([a4234f6](https://github.com/disafronov/opencode-memoir/commit/a4234f65d970b161da5307a5747a9cc341be79ef))

## 1.0.0 (2026-06-11)

### Features

* initial plugin release ([eaeb047](https://github.com/disafronov/opencode-memoir/commit/eaeb047f2d8d862c4550db8ea41fd1a9fe22f15c))

## 1.0.0 (2026-06-11)

### Features

* initial plugin release ([eaeb047](https://github.com/disafronov/opencode-memoir/commit/eaeb047f2d8d862c4550db8ea41fd1a9fe22f15c))

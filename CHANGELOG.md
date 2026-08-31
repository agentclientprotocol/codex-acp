# Changelog

## [1.7.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.6.2...v1.7.0) (2026-08-27)


### Features

* add ACP v1 permission presentation ([#405](https://github.com/agentclientprotocol/codex-acp/issues/405)) ([8ff9e67](https://github.com/agentclientprotocol/codex-acp/commit/8ff9e67f79335345ce53b3157b3d690c191ea027))
* add native ACP subagent sessions ([#419](https://github.com/agentclientprotocol/codex-acp/issues/419)) ([6067b7f](https://github.com/agentclientprotocol/codex-acp/commit/6067b7f48fe37db82b6ddb9d596a4a4d8cb8a2e4))
* expose permission mode kinds ([#430](https://github.com/agentclientprotocol/codex-acp/issues/430)) ([50f69e5](https://github.com/agentclientprotocol/codex-acp/commit/50f69e57ca761ccafd2ca29de7fb591068277516))


### Bug Fixes

* report AIR file changes from audit turns ([a2152e2](https://github.com/agentclientprotocol/codex-acp/commit/a2152e2d337291ca2f8dd7f9cc8b68a2355ce955))
* send elicitation complete event for device authentication ([#421](https://github.com/agentclientprotocol/codex-acp/issues/421)) ([6b01a28](https://github.com/agentclientprotocol/codex-acp/commit/6b01a28c4706762a9663914845c51cd605cde339))
* suppress late session updates after close ([#418](https://github.com/agentclientprotocol/codex-acp/issues/418)) ([ae048a6](https://github.com/agentclientprotocol/codex-acp/commit/ae048a66e485bae5184cb87ae75fcfa1549b69d5))

## [1.6.2](https://github.com/agentclientprotocol/codex-acp/compare/v1.6.1...v1.6.2) (2026-08-19)


### Bug Fixes

* right-size the apt timeouts so a slow mirror still finishes ([86e0772](https://github.com/agentclientprotocol/codex-acp/commit/86e0772204a07d6fc4a8853c523ceb5006431f88))

## [1.6.1](https://github.com/agentclientprotocol/codex-acp/compare/v1.6.0...v1.6.1) (2026-08-19)


### Bug Fixes

* kill stalled apt from outside and serialize the unit suite ([51e011f](https://github.com/agentclientprotocol/codex-acp/commit/51e011fef27b812b238bf29c2a815f8ad149fa87))

## [1.6.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.5.1...v1.6.0) (2026-08-19)


### Features

* harden release pipeline against hangs and e2e flakes ([#413](https://github.com/agentclientprotocol/codex-acp/issues/413)) ([39af81c](https://github.com/agentclientprotocol/codex-acp/commit/39af81c29b79a85f878db096f9cb593b6d1c7429))

## [1.5.1](https://github.com/agentclientprotocol/codex-acp/compare/v1.5.0...v1.5.1) (2026-08-19)


### Bug Fixes

* update codex to 0.148.0 ([#410](https://github.com/agentclientprotocol/codex-acp/issues/410)) ([3616954](https://github.com/agentclientprotocol/codex-acp/commit/3616954dc0e24af83b512adb618d7acbc5b98de5))

## [1.5.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.4.0...v1.5.0) (2026-08-17)


### Features

* switch providers for loaded Codex sessions ([#404](https://github.com/agentclientprotocol/codex-acp/issues/404)) ([47b57da](https://github.com/agentclientprotocol/codex-acp/commit/47b57da5641a04df9aeeedc254a3aef53a9497da))

## [1.4.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.3.0...v1.4.0) (2026-08-16)


### Features

* report changed files to AIR ([#403](https://github.com/agentclientprotocol/codex-acp/issues/403)) ([e305394](https://github.com/agentclientprotocol/codex-acp/commit/e305394d3f001f21e600597f41a3bee3d4530762))

## [1.3.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.2.0...v1.3.0) (2026-08-14)


### Features

* add versioned context compaction metadata ([#396](https://github.com/agentclientprotocol/codex-acp/issues/396)) ([c4a9311](https://github.com/agentclientprotocol/codex-acp/commit/c4a9311f60a638e3a4b03a475afff1d7678e594f))
* align typed session failures with AIR protocol ([#393](https://github.com/agentclientprotocol/codex-acp/issues/393)) ([e4fb92f](https://github.com/agentclientprotocol/codex-acp/commit/e4fb92fffd8b8b9db9b40591ccbdb375c9f3f525))


### Bug Fixes

* Restore native provider state after overrides ([#400](https://github.com/agentclientprotocol/codex-acp/issues/400)) ([90ed600](https://github.com/agentclientprotocol/codex-acp/commit/90ed60077a928a02ce795a35c90c2ed3a8af381e))

## [1.2.0](https://github.com/agentclientprotocol/codex-acp/compare/v1.1.14...v1.2.0) (2026-08-11)


### Features

* expose typed session failures for AIR ([#383](https://github.com/agentclientprotocol/codex-acp/issues/383)) ([54987e1](https://github.com/agentclientprotocol/codex-acp/commit/54987e1c4a4f878af9afad96ec8b6b0b48c7045e))


### Bug Fixes

* normalize cwd filters for Windows sessions ([#377](https://github.com/agentclientprotocol/codex-acp/issues/377)) ([145ebba](https://github.com/agentclientprotocol/codex-acp/commit/145ebba5d2030b4aa6d19cbb89d190b7b498d454))

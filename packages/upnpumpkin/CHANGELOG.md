# Changelog

## [0.0.4](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.3...upnpumpkin-v0.0.4) (2026-10-06)


### Features

* **config:** support migrated field values ([b519ebe](https://github.com/filiphsps/pumpkin-plugins/commit/b519ebe84bfa1d2c6685807b44d85a4d3d0860bb))
* **testing:** add workspace coverage reports ([8db42a8](https://github.com/filiphsps/pumpkin-plugins/commit/8db42a870f5bc2526890f3144b80308dc9bab006))


### Bug Fixes

* **build:** preserve artifact backup on rollback failure ([0f30c46](https://github.com/filiphsps/pumpkin-plugins/commit/0f30c4625a7a66c6e3442a648ca5c1aabbbecf44))
* **build:** retain type backup on rollback failure ([4bbeea0](https://github.com/filiphsps/pumpkin-plugins/commit/4bbeea03110d06372df608fc46e008ca991aee3a))
* **config:** parse full-range TOML integers ([7027d76](https://github.com/filiphsps/pumpkin-plugins/commit/7027d76f1f5adce59e29e62973008eedfcbe914f))

## [0.0.3](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.2...upnpumpkin-v0.0.3) (2026-10-05)


### Features

* **docs:** show package licenses in README tables ([3ab78c3](https://github.com/filiphsps/pumpkin-plugins/commit/3ab78c3cf678600c248422afa818c93d7f94b771))
* **plugin-kit:** add Pumpkin console color helper ([2a650a3](https://github.com/filiphsps/pumpkin-plugins/commit/2a650a365ea6ae26d4a2f94337d0b6c9031aeff3))
* **plugin-kit:** centralize plugin lifecycle and updates ([03cf470](https://github.com/filiphsps/pumpkin-plugins/commit/03cf470818b18069830ef6104b04d5e1576b9541))
* **plugin-kit:** color plugin lifecycle log values ([630700f](https://github.com/filiphsps/pumpkin-plugins/commit/630700fe68c5c2064900c8deb914e086487fd4ac))
* **update-check:** add async Pumpkin Market checker ([7b67c53](https://github.com/filiphsps/pumpkin-plugins/commit/7b67c53c590bcc9e4daa7cb06883ac1477ce4dc7))
* **upnpumpkin:** color config and port request logs ([83b3a66](https://github.com/filiphsps/pumpkin-plugins/commit/83b3a66674f449739bc7b4088176b5f42b852f1e))


### Bug Fixes

* **bedrock-addon-manager:** skip IPC release during unload ([59b89e5](https://github.com/filiphsps/pumpkin-plugins/commit/59b89e539ef264499eebe0e9c6e5fb142f5c266c))
* **build:** ignore empty cache directory overrides ([3431b84](https://github.com/filiphsps/pumpkin-plugins/commit/3431b84104f116d321341bf92092b7c583f5a67c))
* **build:** publish components safely ([cc486c6](https://github.com/filiphsps/pumpkin-plugins/commit/cc486c6a2fdf8951a7674b058727c13c5846f285))
* **build:** reject null bytes in build paths ([a6efcf0](https://github.com/filiphsps/pumpkin-plugins/commit/a6efcf0cf9413a1ab052e8b400f0b63265d28a0b))
* **build:** reject unsupported command arguments ([74dea6b](https://github.com/filiphsps/pumpkin-plugins/commit/74dea6b6026456ce81750ef4e0464ba08156003c))
* **build:** replace stale generated type declarations ([ead7c8a](https://github.com/filiphsps/pumpkin-plugins/commit/ead7c8a6f7843142711af44702fb74e2787144e3))
* **build:** report package config read errors ([3aaf4b6](https://github.com/filiphsps/pumpkin-plugins/commit/3aaf4b6731409cbc76e6426918273fd8c4df16e1))
* **build:** require wasm output paths ([dffeb1b](https://github.com/filiphsps/pumpkin-plugins/commit/dffeb1b6d9feeb0aa9de955e2c27ceb73abb8c17))
* **build:** reset incomplete WIT copies before retry ([2ce981b](https://github.com/filiphsps/pumpkin-plugins/commit/2ce981b774b463db4d04c717a9457fb01e795974))
* **build:** validate plugin build config ([3a77136](https://github.com/filiphsps/pumpkin-plugins/commit/3a77136121f79c58e115f5ac66249cca5e3cc44b))
* **build:** validate required build fields early ([6791b89](https://github.com/filiphsps/pumpkin-plugins/commit/6791b89f1f3fdbb3e0187e4cabf5113e14ec88c4))
* **plugin-kit:** accept null optional resources during cleanup ([0c893d8](https://github.com/filiphsps/pumpkin-plugins/commit/0c893d83170dbc2637f2e6c66135d814833e5726))
* **plugin-kit:** avoid duplicate plugin load confirmation ([ed8191a](https://github.com/filiphsps/pumpkin-plugins/commit/ed8191ae4159612bfd5c6594b5500c7d30e92370))
* **plugin-kit:** generate host declarations for typecheck ([d3441a4](https://github.com/filiphsps/pumpkin-plugins/commit/d3441a4ec11e59a431798d71b826a0c5e8f817e9))
* **plugin-kit:** log plugin loads only after setup succeeds ([d8d5fb2](https://github.com/filiphsps/pumpkin-plugins/commit/d8d5fb221c9c626c41a73f43fd47c6a869dd1c95))
* **plugin-kit:** preserve files and clean up filesystem failures ([88a6a20](https://github.com/filiphsps/pumpkin-plugins/commit/88a6a20ebd0f6010c7546b9cd39aec654098cac8))
* **plugin-kit:** release scheduled handlers and prevent id collisions ([19927d7](https://github.com/filiphsps/pumpkin-plugins/commit/19927d7e2e3984cab188ffd0df0fe1f08364f8e6))
* **plugin-kit:** validate command handlers before allocating nodes ([2fd5bbb](https://github.com/filiphsps/pumpkin-plugins/commit/2fd5bbb8213bec67b3b3267b580e2e60b3933edf))
* **runtime:** tolerate missing WASI resource disposers ([110fca6](https://github.com/filiphsps/pumpkin-plugins/commit/110fca6094c4c88f99a2ffc4f7ff663aad838eea))
* **update-check:** unify HTTP polling and resource cleanup ([2909148](https://github.com/filiphsps/pumpkin-plugins/commit/2909148fceb4bfc7176cbf739565b647c7dfffe4))
* **update-check:** validate Market responses and semantic versions ([a424e66](https://github.com/filiphsps/pumpkin-plugins/commit/a424e664e5b3579312be7f95799ef4331af641f2))

## [0.0.2](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.1...upnpumpkin-v0.0.2) (2026-10-05)


### Features

* **plugin-kit:** support delayed server callbacks ([08efcf6](https://github.com/filiphsps/pumpkin-plugins/commit/08efcf6f363dfb7a27943c55daa62bf3a06c3745))

## 0.0.1 (2026-10-04)


### Bug Fixes

* **upnpumpkin:** isolate the WASI socket adapter ([7bc81b5](https://github.com/filiphsps/pumpkin-plugins/commit/7bc81b5de494b9f4e3eb10de61122cbeedf1a67b))
* **upnpumpkin:** limit port requests per plugin ([bbb8174](https://github.com/filiphsps/pumpkin-plugins/commit/bbb81744832b6b782bfcbfe29b915d67f11b2daa))
* **upnpumpkin:** only turn off asking for ports, not giving them back ([904489d](https://github.com/filiphsps/pumpkin-plugins/commit/904489d7a15445fc028c9af872aa24ad9f9f6138))

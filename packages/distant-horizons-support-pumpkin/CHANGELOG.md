# Changelog

## [0.0.10](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.9...distant-horizons-support-pumpkin-v0.0.10) (2026-10-08)


### Features

* **dh:** add per-world 3d biome sampling ([722a3ec](https://github.com/filiphsps/pumpkin-plugins/commit/722a3ec9041292164df2ee1f98b681779c27eeee))


### Bug Fixes

* **dh:** invalidate cached sections on growth and spread ([204218e](https://github.com/filiphsps/pumpkin-plugins/commit/204218e53921704eb672019eba5474c0c44e42d6))
* **dh:** omit client dimension text from debug logs ([068f010](https://github.com/filiphsps/pumpkin-plugins/commit/068f01012ff8740d5fb442e20eed19652f838ef7))


### Performance Improvements

* **dh:** reuse heightmap values within columns ([9563af7](https://github.com/filiphsps/pumpkin-plugins/commit/9563af708fd0cf0374fdecd62511356f010bf722))

## [0.0.9](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.8...distant-horizons-support-pumpkin-v0.0.9) (2026-10-07)


### Features

* **dh:** add selected cache recovery command ([65a9bce](https://github.com/filiphsps/pumpkin-plugins/commit/65a9bce4bc481a314ec973b660b58ec5a6d01586))
* **dh:** back up selected cache entries before removal ([e02f7a8](https://github.com/filiphsps/pumpkin-plugins/commit/e02f7a837382f319b02815ada404fac3c30b66fc))
* **dh:** recover one selected cached section ([3c246d1](https://github.com/filiphsps/pumpkin-plugins/commit/3c246d1c5b08e4ceaeaad34067e3a880799219bc))


### Bug Fixes

* **dh:** clip forced LOD generation to world bounds ([6af8d54](https://github.com/filiphsps/pumpkin-plugins/commit/6af8d543309e49954ee73ed00b548cdef488409d))
* **dh:** fairly pace and bound response queues ([26a1a77](https://github.com/filiphsps/pumpkin-plugins/commit/26a1a77c6ea34f9eeaf98446d3419a44a00df911))
* **dh:** keep active transfers within receiver timeout ([e6341a7](https://github.com/filiphsps/pumpkin-plugins/commit/e6341a74dfa15bda5fb3f9144e658a821b2b4149))
* **dh:** normalize nullable host chunk handles ([88c832e](https://github.com/filiphsps/pumpkin-plugins/commit/88c832e9858ddd5ecc7ae1123d6a0bd0e49b88f0))
* **dh:** preserve complete session configuration ([eb33ab8](https://github.com/filiphsps/pumpkin-plugins/commit/eb33ab8477f22612140646d14b3203e1feae5972))
* **dh:** reject unavailable requests while capture pauses ([90e63ce](https://github.com/filiphsps/pumpkin-plugins/commit/90e63ceb88f5dff27cb0a30e1ddd7aa227c96231))
* **dh:** size fragments for the receiver timeout ([53342b6](https://github.com/filiphsps/pumpkin-plugins/commit/53342b62bca495c83e9b43a4cd527fe590b06383))
* **dh:** validate DH level identities ([758371c](https://github.com/filiphsps/pumpkin-plugins/commit/758371c251c079efe553b7c3617d6e8f406cee22))
* **terrain:** treat nullable chunks as absent ([936eb0b](https://github.com/filiphsps/pumpkin-plugins/commit/936eb0b24466ed837caa54fb147b7cb3af0c66e3))


### Performance Improvements

* **dh:** index persisted LOD cache entries ([47e41e8](https://github.com/filiphsps/pumpkin-plugins/commit/47e41e8ecbf7a9e5b8ff1e9d30c927557b40edb9))

## [0.0.8](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.7...distant-horizons-support-pumpkin-v0.0.8) (2026-10-07)


### Features

* **commands:** support positional argument variants ([689de6c](https://github.com/filiphsps/pumpkin-plugins/commit/689de6c52d011449a93ad007409be114e72f7e06))
* **dh:** add bounded force-capture section planning ([dd6710d](https://github.com/filiphsps/pumpkin-plugins/commit/dd6710dc710143c898cfc838adbb4e01320093b2))
* **dh:** add force generation commands ([652851c](https://github.com/filiphsps/pumpkin-plugins/commit/652851c46cfeaf3d01e5dfba6983228347f89a58))
* **dh:** add forced LOD capture worker ([e645f1f](https://github.com/filiphsps/pumpkin-plugins/commit/e645f1fbea096e76b055242c9e24b85fc1e62cca))
* **dh:** format status as separate chat lines ([425d492](https://github.com/filiphsps/pumpkin-plugins/commit/425d492d79ef45f07ad2c534377e902d5b4b0210))
* **dh:** log forced LOD generation locations ([e101f5a](https://github.com/filiphsps/pumpkin-plugins/commit/e101f5af11d27db97adb11dc6d303a66e5ee0446))
* **dh:** prioritize forced capture in sessions ([54e7022](https://github.com/filiphsps/pumpkin-plugins/commit/54e70225c3df2fca29d35a30b15afd46b2a3dcd0))
* **dh:** trace session LOD requests and sends ([a6bb814](https://github.com/filiphsps/pumpkin-plugins/commit/a6bb8148c6e9d7897855d1fd52c2bef2a147a527))
* **dh:** use positional map and generate commands ([ad4d506](https://github.com/filiphsps/pumpkin-plugins/commit/ad4d506816fbf5e7628b28974b67055c54bce1bc))
* **docs:** collapse generated config files in readmes ([a05d1aa](https://github.com/filiphsps/pumpkin-plugins/commit/a05d1aabdfbd22508deb985b4e20b97a0dde6ad0))
* **minecraft-colors:** add ANSI terminal formatting ([bb6eb16](https://github.com/filiphsps/pumpkin-plugins/commit/bb6eb162ff291855286923f42013ffa9bca005ca))
* **minecraft-colors:** add more named colors ([8e05b09](https://github.com/filiphsps/pumpkin-plugins/commit/8e05b0917c62766e9faaa528649740e1f399bfe8))
* **minecraft-colors:** add semantic color presets ([72e3839](https://github.com/filiphsps/pumpkin-plugins/commit/72e3839eee71be8bf5398715b17a761065f8837d))
* **minecraft-colors:** add string formatting helpers ([b99a342](https://github.com/filiphsps/pumpkin-plugins/commit/b99a3424a264b77ca2394f9d05752c705635341e))


### Bug Fixes

* **dev:** skip market checks and add no-reload mode ([f457446](https://github.com/filiphsps/pumpkin-plugins/commit/f457446d8de405594cf8cfdb73b9534f86f2e02b))
* **dh:** advertise separate request rates ([06b6e4e](https://github.com/filiphsps/pumpkin-plugins/commit/06b6e4e30e29e0c67dd3ce7d41b5dac292b0c6aa))
* **dh:** cap map output to chat width ([01565e9](https://github.com/filiphsps/pumpkin-plugins/commit/01565e942fa8a891c52eed8f054cdca5bc481d3e))
* **dh:** clarify forced capture status budget ([84a2ffa](https://github.com/filiphsps/pumpkin-plugins/commit/84a2ffa72cdfeb3f0a0013bdebfc20aea3b8f387))
* **dh:** report missing player context cleanly ([272f901](https://github.com/filiphsps/pumpkin-plugins/commit/272f901fccfb544734aec53cfbdfe2f1b2d83c12))
* **dh:** retain forced jobs across DH session closes ([7402113](https://github.com/filiphsps/pumpkin-plugins/commit/7402113d182a319a46707162942a8478d3e8c1b7))
* **dh:** skip cached sections in large captures ([c7a8588](https://github.com/filiphsps/pumpkin-plugins/commit/c7a8588240f8a818be12cd33a9469158d14c8d36))


### Performance Improvements

* **dh:** raise transfer and cache limits ([5afbcc3](https://github.com/filiphsps/pumpkin-plugins/commit/5afbcc39b5ff7742f2b547681a81f5bcbab8b627))
* **dh:** serve cached LODs before refresh ([39919ab](https://github.com/filiphsps/pumpkin-plugins/commit/39919ab17fda619f0cba7f2ec9fd6a6281fefd09))

## [0.0.7](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.6...distant-horizons-support-pumpkin-v0.0.7) (2026-10-07)


### Features

* **dh:** adapt capture work to server load ([397397b](https://github.com/filiphsps/pumpkin-plugins/commit/397397b5bda510fe87cfc1bc0bb6f8367fc93284))
* **dh:** add LOD map commands ([5bba589](https://github.com/filiphsps/pumpkin-plugins/commit/5bba5894d3da583f416a8d03e0c7659c53a32920))
* **dh:** render cached LOD section maps ([9265715](https://github.com/filiphsps/pumpkin-plugins/commit/9265715fb5570aec2fe4a6227a50bb2fa381eb96))
* **docs:** support typed command arguments ([ee0b90f](https://github.com/filiphsps/pumpkin-plugins/commit/ee0b90fe42eb788246dea3cd549d8c53a428842a))
* **plugin-kit:** support typed command arguments ([54544fc](https://github.com/filiphsps/pumpkin-plugins/commit/54544fc3e40ef68dd9d453ffea3fbb61a65c4580))
* **terrain:** add adaptive work budget ([d975d30](https://github.com/filiphsps/pumpkin-plugins/commit/d975d30ec88b75b948d1ee2a70b55af5e68ca19e))

## [0.0.6](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.5...distant-horizons-support-pumpkin-v0.0.6) (2026-10-07)


### Features

* **terrain:** add shared terrain capture package ([16abc95](https://github.com/filiphsps/pumpkin-plugins/commit/16abc95313118c77b88f6046b3cc00943f378911))


### Bug Fixes

* **dh:** avoid stale chunk handles during LOD capture ([37d2a25](https://github.com/filiphsps/pumpkin-plugins/commit/37d2a25855db83b63ca3dace9b54739795525f5b))

## [0.0.5](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.3...distant-horizons-support-pumpkin-v0.0.5) (2026-10-07)


### chore

* prepare Distant Horizons 0.0.5 recovery release ([fb3712e](https://github.com/filiphsps/pumpkin-plugins/commit/fb3712ed8e34dfcbf34b636d64c45ff43f71de41))


### Features

* **docs:** add generated documentation site ([545c749](https://github.com/filiphsps/pumpkin-plugins/commit/545c74944f65e38fb927fcde588fd17848298cf8))
* **docs:** add grouped responsive navigation ([1fbf8b5](https://github.com/filiphsps/pumpkin-plugins/commit/1fbf8b586393b28132e3eedaf8543429ef9d8544))
* **docs:** publish plugin icons in navigation ([73655b5](https://github.com/filiphsps/pumpkin-plugins/commit/73655b5ea4b73e107eb4ca13b47bdea07070b727))

## [0.0.4](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.3...distant-horizons-support-pumpkin-v0.0.4) (2026-10-07)


### Features

* **docs:** add generated documentation site ([545c749](https://github.com/filiphsps/pumpkin-plugins/commit/545c74944f65e38fb927fcde588fd17848298cf8))
* **docs:** add grouped responsive navigation ([1fbf8b5](https://github.com/filiphsps/pumpkin-plugins/commit/1fbf8b586393b28132e3eedaf8543429ef9d8544))
* **docs:** publish plugin icons in navigation ([73655b5](https://github.com/filiphsps/pumpkin-plugins/commit/73655b5ea4b73e107eb4ca13b47bdea07070b727))

## [0.0.3](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.2...distant-horizons-support-pumpkin-v0.0.3) (2026-10-07)


### Features

* **actions:** add signing action and generated catalog ([43e941c](https://github.com/filiphsps/pumpkin-plugins/commit/43e941ce09f5f5d3457f87f3cd7ad88bdaea4da4))
* **plugin-kit:** support hierarchical command permissions ([854f5cc](https://github.com/filiphsps/pumpkin-plugins/commit/854f5cc2233559bcaa34b2ecb0a19bec88a9f774))


### Bug Fixes

* **distant-horizons:** split command permissions ([b7d359a](https://github.com/filiphsps/pumpkin-plugins/commit/b7d359ae0253440fa7ce93abe63e834d79750ff6))

## [0.0.2](https://github.com/filiphsps/pumpkin-plugins/compare/distant-horizons-support-pumpkin-v0.0.1...distant-horizons-support-pumpkin-v0.0.2) (2026-10-06)


### Features

* **distant-horizons:** add cache commands ([a2b2706](https://github.com/filiphsps/pumpkin-plugins/commit/a2b2706edff0b8c5596c9846ffcfa53aaf8818b1))
* **distant-horizons:** split cache tiers ([46c3a52](https://github.com/filiphsps/pumpkin-plugins/commit/46c3a521d05b6d43d2f1be5b2e138b54c887d913))
* **testing:** add workspace coverage reports ([8db42a8](https://github.com/filiphsps/pumpkin-plugins/commit/8db42a870f5bc2526890f3144b80308dc9bab006))


### Bug Fixes

* **build:** preserve artifact backup on rollback failure ([0f30c46](https://github.com/filiphsps/pumpkin-plugins/commit/0f30c4625a7a66c6e3442a648ca5c1aabbbecf44))
* **build:** retain type backup on rollback failure ([4bbeea0](https://github.com/filiphsps/pumpkin-plugins/commit/4bbeea03110d06372df608fc46e008ca991aee3a))
* **distant-horizons:** handle negative limits ([4345e01](https://github.com/filiphsps/pumpkin-plugins/commit/4345e01f059c883f19a5a9d1c0b57fce7857a70f))
* **lint:** clear warnings from checks ([42fe3f3](https://github.com/filiphsps/pumpkin-plugins/commit/42fe3f3d95f9ca4dbe00d4645eeb98ab33435b34))


### Performance Improvements

* **distant-horizons-support:** speed up cached LOD transfers ([8810a58](https://github.com/filiphsps/pumpkin-plugins/commit/8810a58b968c5fc3dde273902a5d203530205965))

## 0.0.1 (2026-10-05)


### Features

* **apple-skin-pumpkin:** sync AppleSkin clients' hunger values ([9a4ada0](https://github.com/filiphsps/pumpkin-plugins/commit/9a4ada0a114ab2d1dfe4d7d887e9fdbdb1638cbb))
* **distant-horizons:** build terrain LODs in bounded steps ([3b67955](https://github.com/filiphsps/pumpkin-plugins/commit/3b6795554625e9e6987aff6b8157b08cf324141e))
* **distant-horizons:** configure request and terrain limits ([9b8f425](https://github.com/filiphsps/pumpkin-plugins/commit/9b8f4251aee058c3bb937aa6390d0d820f6f1774))
* **distant-horizons:** implement protocol 16 message codec ([c07eae1](https://github.com/filiphsps/pumpkin-plugins/commit/c07eae163aaa782e315a90c159f2d261659da9bf))
* **distant-horizons:** persist and validate bounded LOD caches ([9a7e56d](https://github.com/filiphsps/pumpkin-plugins/commit/9a7e56dbfb5c4558911328ffc1985399b11b2b1e))
* **distant-horizons:** register plugin events and document terrain limits ([8cb9bec](https://github.com/filiphsps/pumpkin-plugins/commit/8cb9bec1a2022b6d02b1c115063c79feffe76843))
* **distant-horizons:** scaffold unofficial GPL-licensed plugin ([ea9ca4e](https://github.com/filiphsps/pumpkin-plugins/commit/ea9ca4e2e5d3bf679f51e8190ba1ff0f0b2280cf))
* **distant-horizons:** serve bounded loaded and cached terrain requests ([e062a36](https://github.com/filiphsps/pumpkin-plugins/commit/e062a36e5d5ab4be22a2a5a4d943c298f975e16b))
* **docs:** show package licenses in README tables ([3ab78c3](https://github.com/filiphsps/pumpkin-plugins/commit/3ab78c3cf678600c248422afa818c93d7f94b771))
* **docs:** type command handlers by sender ([8edeaf1](https://github.com/filiphsps/pumpkin-plugins/commit/8edeaf1745064558f7badcefe7ed2e0370e17b74))
* **plugin-kit:** add Pumpkin console color helper ([2a650a3](https://github.com/filiphsps/pumpkin-plugins/commit/2a650a365ea6ae26d4a2f94337d0b6c9031aeff3))
* **plugin-kit:** centralize plugin lifecycle and updates ([03cf470](https://github.com/filiphsps/pumpkin-plugins/commit/03cf470818b18069830ef6104b04d5e1576b9541))
* **plugin-kit:** color plugin lifecycle log values ([630700f](https://github.com/filiphsps/pumpkin-plugins/commit/630700fe68c5c2064900c8deb914e086487fd4ac))
* **plugin-kit:** configure command access defaults ([d6112a6](https://github.com/filiphsps/pumpkin-plugins/commit/d6112a67cd7de550c0ebdec77234b6e5d780676a))
* **plugin-kit:** normalize registry identifiers ([e340889](https://github.com/filiphsps/pumpkin-plugins/commit/e340889b796dd0b09950c764a41f12dd4a5e21f6))
* **plugin-kit:** support delayed server callbacks ([08efcf6](https://github.com/filiphsps/pumpkin-plugins/commit/08efcf6f363dfb7a27943c55daa62bf3a06c3745))
* **update-check:** add async Pumpkin Market checker ([7b67c53](https://github.com/filiphsps/pumpkin-plugins/commit/7b67c53c590bcc9e4daa7cb06883ac1477ce4dc7))


### Bug Fixes

* **build:** atomically cache WASI definitions ([859091f](https://github.com/filiphsps/pumpkin-plugins/commit/859091fea7d15ba79fcf6b70e5eb8d34d70addc5))
* **build:** ignore empty cache directory overrides ([3431b84](https://github.com/filiphsps/pumpkin-plugins/commit/3431b84104f116d321341bf92092b7c583f5a67c))
* **build:** keep WASI staging out of shared cache ([c6b5da7](https://github.com/filiphsps/pumpkin-plugins/commit/c6b5da7128df9f2d011838c3e505381cea1a0e57))
* **build:** prepare WIT atomically ([d0b50e1](https://github.com/filiphsps/pumpkin-plugins/commit/d0b50e1f7a9f27c34ff6d0a8f4f9d025c70591d5))
* **build:** publish components safely ([cc486c6](https://github.com/filiphsps/pumpkin-plugins/commit/cc486c6a2fdf8951a7674b058727c13c5846f285))
* **build:** reject null bytes in build paths ([a6efcf0](https://github.com/filiphsps/pumpkin-plugins/commit/a6efcf0cf9413a1ab052e8b400f0b63265d28a0b))
* **build:** reject unsupported command arguments ([74dea6b](https://github.com/filiphsps/pumpkin-plugins/commit/74dea6b6026456ce81750ef4e0464ba08156003c))
* **build:** replace stale generated type declarations ([ead7c8a](https://github.com/filiphsps/pumpkin-plugins/commit/ead7c8a6f7843142711af44702fb74e2787144e3))
* **build:** report package config read errors ([3aaf4b6](https://github.com/filiphsps/pumpkin-plugins/commit/3aaf4b6731409cbc76e6426918273fd8c4df16e1))
* **build:** require wasm output paths ([dffeb1b](https://github.com/filiphsps/pumpkin-plugins/commit/dffeb1b6d9feeb0aa9de955e2c27ceb73abb8c17))
* **build:** reset incomplete WIT copies before retry ([2ce981b](https://github.com/filiphsps/pumpkin-plugins/commit/2ce981b774b463db4d04c717a9457fb01e795974))
* **build:** retain validated WASI path ([56cf35c](https://github.com/filiphsps/pumpkin-plugins/commit/56cf35ce07b5361a5380d69ca2138f5b606200a5))
* **build:** scope typecheck outputs to plugins ([83c477d](https://github.com/filiphsps/pumpkin-plugins/commit/83c477d5e2e0540109623226fa01234dd453eb9b))
* **build:** validate plugin build config ([3a77136](https://github.com/filiphsps/pumpkin-plugins/commit/3a77136121f79c58e115f5ac66249cca5e3cc44b))
* **build:** validate required build fields early ([6791b89](https://github.com/filiphsps/pumpkin-plugins/commit/6791b89f1f3fdbb3e0187e4cabf5113e14ec88c4))
* **distant-horizons:** avoid slow captures and report queue progress ([2f36536](https://github.com/filiphsps/pumpkin-plugins/commit/2f36536f223414e4e6bcaa72cdd7a4a853ec520c))
* **distant-horizons:** bound terrain segment memory ([ea31c27](https://github.com/filiphsps/pumpkin-plugins/commit/ea31c27a26d0449d5c26834abb2af3fc91a16b94))
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

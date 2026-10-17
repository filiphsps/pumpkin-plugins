# Changelog

## [0.1.0](https://github.com/filiphsps/pumpkin-plugins/compare/waypoints-v0.0.4...waypoints-v0.1.0) (2026-10-17)


### ⚠ BREAKING CHANGES

* **runtime:** switch to `static-hermes`

### Features

* **build:** add opt-in Hermes TypeScript parsing ([ee3c10d](https://github.com/filiphsps/pumpkin-plugins/commit/ee3c10de8b3a7f7959aeeb47bbe61cd16283a8d1))
* **build:** add parse-ts build command ([bc072db](https://github.com/filiphsps/pumpkin-plugins/commit/bc072dbadfa806c49f401c14d642f6f9ce1e01a1))
* **build:** add release and follow links to update notice ([79d982b](https://github.com/filiphsps/pumpkin-plugins/commit/79d982b79a215bbc977e29731d7ea301d34ff59e))
* **build:** add typed standalone plugin builder ([39ff68e](https://github.com/filiphsps/pumpkin-plugins/commit/39ff68e5d963f5ba344dd6e6d989807e934becfe))
* **build:** build plugins with Static Hermes ([bff13b5](https://github.com/filiphsps/pumpkin-plugins/commit/bff13b57430f76ef9134b5543b4f1096cbd5d499))
* **build:** configure plugin runtime engine ([2c5c812](https://github.com/filiphsps/pumpkin-plugins/commit/2c5c812a6cd2c572385eed5be571702adc05413c))
* **build:** enforce production wasm size limit ([f084e02](https://github.com/filiphsps/pumpkin-plugins/commit/f084e02733f1d0100f78d7fb7131fae51da2ccaf))
* **build:** expose capability interface lookup ([cc70f9c](https://github.com/filiphsps/pumpkin-plugins/commit/cc70f9c6c69040b5ab4276e86a6247cbb71fb17d))
* **build:** notify about available updates ([50c7cc0](https://github.com/filiphsps/pumpkin-plugins/commit/50c7cc0f98198362d54e670e9eec763aef36a2aa))
* **build:** show Static Hermes selections in verbose logs ([f5e0f8d](https://github.com/filiphsps/pumpkin-plugins/commit/f5e0f8d2e642e8b7fa9fbcfbd783c318a0470516))
* **build:** show TypeScript parser mode ([6e7c60b](https://github.com/filiphsps/pumpkin-plugins/commit/6e7c60b0fa57f15f26f16ef0d70be77801846910))
* **docs:** add reusable document generation and source discovery ([33cab22](https://github.com/filiphsps/pumpkin-plugins/commit/33cab2216fd60efd9d52611fa885d5a630ea78d6))
* **pumpkin-api:** add pinned first-party host API ([88d58ea](https://github.com/filiphsps/pumpkin-plugins/commit/88d58ea26e9d38d3183f50c441486de37c6d665f))
* **pumpkin-api:** validate compatibility matrices with schema ([12b48b9](https://github.com/filiphsps/pumpkin-plugins/commit/12b48b963295a13bb24d3f6f819d42838de64961))
* **runtime:** add standalone Static Hermes package ([f9b24e3](https://github.com/filiphsps/pumpkin-plugins/commit/f9b24e3b5a190a54090a87c6f1141ff075dfaeb0))
* **runtime:** bundle plugins for Static Hermes ([2105469](https://github.com/filiphsps/pumpkin-plugins/commit/2105469a07b8f90f964dd9f10008017fbdaaa01f))
* **runtime:** switch to `static-hermes` ([fafe44f](https://github.com/filiphsps/pumpkin-plugins/commit/fafe44fcf3c894e38bde43050128cbff522d530e))
* **static-hermes-runtime:** replace legacy scripts with typed CLI ([2545271](https://github.com/filiphsps/pumpkin-plugins/commit/2545271153cc663a62b63a9822b17fe8b24e3dc1))
* **static-hermes-runtime:** support opt-in TypeScript bundles ([0358ed2](https://github.com/filiphsps/pumpkin-plugins/commit/0358ed276ce1975483a6f37cbfdfd44c72110478))
* **static-hermes-runtime:** support portable packaged builds ([e999bfd](https://github.com/filiphsps/pumpkin-plugins/commit/e999bfd4a02714c250ba85b6c7e1b8104cffb9a4))
* **static-hermes:** add Hades GC selection ([e6f6455](https://github.com/filiphsps/pumpkin-plugins/commit/e6f64550857c52eb45549717ea81b729e66f3073))
* **static-hermes:** generate WIT adapters and make runtime default ([000242f](https://github.com/filiphsps/pumpkin-plugins/commit/000242fe6c6b255625096f09a9d902ef949233bf))
* **wasi:** share capability metadata across tooling ([bbe0f2f](https://github.com/filiphsps/pumpkin-plugins/commit/bbe0f2f093273132e8fd2101233cada29af270e7))
* **waypoints:** add PumpkinPIE placeholder contract ([96d6fda](https://github.com/filiphsps/pumpkin-plugins/commit/96d6fda2f72286059e7eff1c1680d70fe0b7422d))
* **waypoints:** wire placeholders into plugin lifecycle ([5040a35](https://github.com/filiphsps/pumpkin-plugins/commit/5040a356bd19fdd06b6f653e428bd3922fcac089))


### Bug Fixes

* align workspace dependency sections with imports ([86aa0e2](https://github.com/filiphsps/pumpkin-plugins/commit/86aa0e2d392d621e0b09c39c6320ff8736be4272))
* **bench:** streamline runtime comparison output ([5c6b1ad](https://github.com/filiphsps/pumpkin-plugins/commit/5c6b1ad9a1138b438d39a55cc3932409aec2323e))
* **build:** analyze consumers without tsconfig ([a42e939](https://github.com/filiphsps/pumpkin-plugins/commit/a42e939f9510ee59a44f9720cae3fc6e9d48d248))
* **build:** avoid duplicate WIT output ([aaad9b5](https://github.com/filiphsps/pumpkin-plugins/commit/aaad9b51f6cde3e0eaf9805bd8f93d87007827b2))
* **build:** clean abandoned staging directories ([667b8d6](https://github.com/filiphsps/pumpkin-plugins/commit/667b8d67004992d5300d7958fe006c439a186e38))
* **build:** define NODE_ENV for plugin bundles ([562bf66](https://github.com/filiphsps/pumpkin-plugins/commit/562bf66f2400edfd017c4571057dbb07b15e134f))
* **build:** flush CLI errors before exiting ([2da29c9](https://github.com/filiphsps/pumpkin-plugins/commit/2da29c9d5f55553761827a1cd0d0481d7e007733))
* **build:** normalize package-relative paths ([d2942ca](https://github.com/filiphsps/pumpkin-plugins/commit/d2942ca1cc65b19ed72ada31b3c08b4b2b18f70d))
* **build:** publish isolated WIT snapshots and resolve API aliases ([7aa0f66](https://github.com/filiphsps/pumpkin-plugins/commit/7aa0f66ca0545014f1b8aad9e4ba3ffcc36965f0))
* **build:** resolve aliased WIT constructors during adapter analysis ([54f9f53](https://github.com/filiphsps/pumpkin-plugins/commit/54f9f53b04844eb2ce55f9319c3c8b9d775fa917))
* **build:** validate and serialize WASI WIT cache writes ([44994cf](https://github.com/filiphsps/pumpkin-plugins/commit/44994cf21a2058d1398a830b984afc65e622915d))
* **build:** warn on oversized external components ([0ec0559](https://github.com/filiphsps/pumpkin-plugins/commit/0ec0559c53bf95e81855954ab06d9815238bb3be))
* **docs:** avoid regex backtracking in table cells ([a1ff2e4](https://github.com/filiphsps/pumpkin-plugins/commit/a1ff2e4c27710028d7c8f78e8a2825f0e23c7dfa))
* **docs:** contain generated targets and normalize metadata ([d41718d](https://github.com/filiphsps/pumpkin-plugins/commit/d41718d7149e0531b4070471a66a8c985f67a20f))
* incomplete string escaping or encoding ([18cead0](https://github.com/filiphsps/pumpkin-plugins/commit/18cead0dac369a367da770bb022c0d0de603d898))
* lint ([3ba41d0](https://github.com/filiphsps/pumpkin-plugins/commit/3ba41d0a1fe211861dca972bd3c7474e96aaeeed))
* **plugin-kit:** ignore task ids from other plugins ([c296825](https://github.com/filiphsps/pumpkin-plugins/commit/c296825de37023156a5b7c17ad0ca72508fce06f))
* **pumpkin-api:** release callbacks on failed registration and unload ([1517db4](https://github.com/filiphsps/pumpkin-plugins/commit/1517db4d7cf7dd4dd115d5f1324dc65d11f27303))
* **pumpkin-pie-api:** cap unavailable retries at five minutes ([92b8a2f](https://github.com/filiphsps/pumpkin-plugins/commit/92b8a2f9ff818cffe4294c0e8e358029f4c8a349))
* **runtime:** dispatch callbacks and release WIT resources ([d935e60](https://github.com/filiphsps/pumpkin-plugins/commit/d935e60dbf2139da6b8d3735472e037492a47216))
* **static-hermes-runtime:** apply patches reliably on Windows ([c6a7b73](https://github.com/filiphsps/pumpkin-plugins/commit/c6a7b73e15ce0a363bc980af00b395527113a4cd))
* **static-hermes-runtime:** clean up failed Hermes source clones ([6faa733](https://github.com/filiphsps/pumpkin-plugins/commit/6faa733994d27d6bd53b53ed8079f36660cccbf1))
* **static-hermes-runtime:** guard WIT memory during conversion ([01ab7b0](https://github.com/filiphsps/pumpkin-plugins/commit/01ab7b0451d02cfda0021f83dfe9296e7f2ce0ed))
* **static-hermes-runtime:** harden WIT code generation and component builds ([2a49fe7](https://github.com/filiphsps/pumpkin-plugins/commit/2a49fe71cc93c374dbdd8edc6a6b03cf57c9db21))
* **static-hermes-runtime:** preserve event results and resources ([64e4e4b](https://github.com/filiphsps/pumpkin-plugins/commit/64e4e4bf00d3330e0e1f13ece548b5cdb1cf091c))
* **static-hermes-runtime:** preserve LF in pinned source checkout ([330aff0](https://github.com/filiphsps/pumpkin-plugins/commit/330aff08c0ec301cc3fbc2d2b268448f914009c2))
* **static-hermes-runtime:** protect shared build locks ([c52a12a](https://github.com/filiphsps/pumpkin-plugins/commit/c52a12a09ff23be66eb315c1d3a5fa2e8a92de4e))
* **static-hermes-runtime:** serialize Hermes preparation stages ([458200d](https://github.com/filiphsps/pumpkin-plugins/commit/458200d19b555cd109a1ef1c373e161d40d3aeee))
* **static-hermes-runtime:** serialize shared Hermes cache mutations ([b5ce293](https://github.com/filiphsps/pumpkin-plugins/commit/b5ce2930db7e235037e7042a41a611474027c6f7))
* **static-hermes-runtime:** use MSVC-compatible host flags ([f00a9f8](https://github.com/filiphsps/pumpkin-plugins/commit/f00a9f8c587ae97bb839f30f0b6be4a18f45ee5f))
* **static-hermes-runtime:** verify pinned toolchain releases and repair caches ([b56cb51](https://github.com/filiphsps/pumpkin-plugins/commit/b56cb51aacbadf2126ff8a5bbc2486292831b37b))
* **static-hermes:** prune adapters for static event registrations ([a07538a](https://github.com/filiphsps/pumpkin-plugins/commit/a07538a53fb61ed7fd9539737cc75130982d5c04))
* **static-hermes:** respect transferred resource ownership ([44a9ceb](https://github.com/filiphsps/pumpkin-plugins/commit/44a9cebbd58c5e31d51851ea7cb7ce0bcd990ed1))
* **tooling:** harden WIT and runtime integration ([54469c3](https://github.com/filiphsps/pumpkin-plugins/commit/54469c39daaae1d180dd4abfd64cf362f0c291dd))
* **update-check:** recognize WASI stream end-of-body ([059c7a1](https://github.com/filiphsps/pumpkin-plugins/commit/059c7a11401e3e34ee25dd9d8f9635f2051c6487))
* **waypoints:** preserve waypoint data on malformed input ([000a3b2](https://github.com/filiphsps/pumpkin-plugins/commit/000a3b29bddaa22a1514b7a48af7491a4a829bff))


### Performance Improvements

* **build:** enable explicit tree shaking ([388553d](https://github.com/filiphsps/pumpkin-plugins/commit/388553d61f654770d9f7630ae7a2bb9fe4872d7a))

## [0.0.4](https://github.com/filiphsps/pumpkin-plugins/compare/waypoints-v0.0.3...waypoints-v0.0.4) (2026-10-11)


### Features

* **waypoints:** autocomplete reset properties ([32ee65b](https://github.com/filiphsps/pumpkin-plugins/commit/32ee65baaf9d09e1c153b32600599d2d904e6c6a))


### Bug Fixes

* **build:** verify pinned runtime provenance ([04c7590](https://github.com/filiphsps/pumpkin-plugins/commit/04c75909f351abb2bbecd10d7c38ca721753fb1f))
* **ci:** verify host-specific runtime builds ([825676e](https://github.com/filiphsps/pumpkin-plugins/commit/825676e1fac8934e8ea422c6f77254acd1213b46))
* **waypoints:** normalize UUIDs at mutation boundaries ([45b24d5](https://github.com/filiphsps/pumpkin-plugins/commit/45b24d5543f5871c83bcd5948f80fe90c8385f45))
* **waypoints:** reject canonical UUID duplicates before migration ([ec48e08](https://github.com/filiphsps/pumpkin-plugins/commit/ec48e088bb785ad16c28afd687335ab0d96347b8))
* **waypoints:** reorder reset arguments ([437ad2b](https://github.com/filiphsps/pumpkin-plugins/commit/437ad2b0b60596933fb260f91a09efb59c83deaa))

## [0.0.3](https://github.com/filiphsps/pumpkin-plugins/compare/waypoints-v0.0.2...waypoints-v0.0.3) (2026-10-10)


### Features

* **waypoints:** suggest online players for access grants ([fa3114f](https://github.com/filiphsps/pumpkin-plugins/commit/fa3114f42e5dadb4a5e19b54fe82c242e327ee39))

## [0.0.2](https://github.com/filiphsps/pumpkin-plugins/compare/waypoints-v0.0.1...waypoints-v0.0.2) (2026-10-09)


### Bug Fixes

* **waypoints:** specify Bedrock support ([33a36bd](https://github.com/filiphsps/pumpkin-plugins/commit/33a36bdb09ad7350b8c204070ec4194a439f3165))

## 0.0.1 (2026-10-09)


### Features

* **actions:** add signing action and generated catalog ([43e941c](https://github.com/filiphsps/pumpkin-plugins/commit/43e941ce09f5f5d3457f87f3cd7ad88bdaea4da4))
* **apple-skin-pumpkin:** sync AppleSkin clients' hunger values ([9a4ada0](https://github.com/filiphsps/pumpkin-plugins/commit/9a4ada0a114ab2d1dfe4d7d887e9fdbdb1638cbb))
* **commands:** support positional argument variants ([689de6c](https://github.com/filiphsps/pumpkin-plugins/commit/689de6c52d011449a93ad007409be114e72f7e06))
* **docs:** add generated documentation site ([545c749](https://github.com/filiphsps/pumpkin-plugins/commit/545c74944f65e38fb927fcde588fd17848298cf8))
* **docs:** add grouped responsive navigation ([1fbf8b5](https://github.com/filiphsps/pumpkin-plugins/commit/1fbf8b586393b28132e3eedaf8543429ef9d8544))
* **docs:** collapse generated config files in readmes ([a05d1aa](https://github.com/filiphsps/pumpkin-plugins/commit/a05d1aabdfbd22508deb985b4e20b97a0dde6ad0))
* **docs:** show package licenses in README tables ([3ab78c3](https://github.com/filiphsps/pumpkin-plugins/commit/3ab78c3cf678600c248422afa818c93d7f94b771))
* **docs:** support typed command arguments ([ee0b90f](https://github.com/filiphsps/pumpkin-plugins/commit/ee0b90fe42eb788246dea3cd549d8c53a428842a))
* **docs:** type command handlers by sender ([8edeaf1](https://github.com/filiphsps/pumpkin-plugins/commit/8edeaf1745064558f7badcefe7ed2e0370e17b74))
* **plugin-kit:** add Pumpkin console color helper ([2a650a3](https://github.com/filiphsps/pumpkin-plugins/commit/2a650a365ea6ae26d4a2f94337d0b6c9031aeff3))
* **plugin-kit:** centralize plugin lifecycle and updates ([03cf470](https://github.com/filiphsps/pumpkin-plugins/commit/03cf470818b18069830ef6104b04d5e1576b9541))
* **plugin-kit:** color plugin lifecycle log values ([630700f](https://github.com/filiphsps/pumpkin-plugins/commit/630700fe68c5c2064900c8deb914e086487fd4ac))
* **plugin-kit:** configure command access defaults ([d6112a6](https://github.com/filiphsps/pumpkin-plugins/commit/d6112a67cd7de550c0ebdec77234b6e5d780676a))
* **plugin-kit:** normalize registry identifiers ([e340889](https://github.com/filiphsps/pumpkin-plugins/commit/e340889b796dd0b09950c764a41f12dd4a5e21f6))
* **plugin-kit:** support delayed server callbacks ([08efcf6](https://github.com/filiphsps/pumpkin-plugins/commit/08efcf6f363dfb7a27943c55daa62bf3a06c3745))
* **plugin-kit:** support double and player selector arguments ([bfbf5e9](https://github.com/filiphsps/pumpkin-plugins/commit/bfbf5e92957fa2d884778fed05436c1f576c76e0))
* **plugin-kit:** support dynamic command suggestions ([678396f](https://github.com/filiphsps/pumpkin-plugins/commit/678396fa657faef06152f32240bdb4dbab54290f))
* **plugin-kit:** support hierarchical command permissions ([854f5cc](https://github.com/filiphsps/pumpkin-plugins/commit/854f5cc2233559bcaa34b2ecb0a19bec88a9f774))
* **plugin-kit:** support typed command arguments ([54544fc](https://github.com/filiphsps/pumpkin-plugins/commit/54544fc3e40ef68dd9d453ffea3fbb61a65c4580))
* **testing:** add workspace coverage reports ([8db42a8](https://github.com/filiphsps/pumpkin-plugins/commit/8db42a870f5bc2526890f3144b80308dc9bab006))
* **update-check:** add async Pumpkin Market checker ([7b67c53](https://github.com/filiphsps/pumpkin-plugins/commit/7b67c53c590bcc9e4daa7cb06883ac1477ce4dc7))
* **waypoints:** add commands and locator adapters ([1c77ed6](https://github.com/filiphsps/pumpkin-plugins/commit/1c77ed6ebdc20f9bdcac0ddf05bc191ff9edaa4a))
* **waypoints:** add disk reload command ([bc3de9a](https://github.com/filiphsps/pumpkin-plugins/commit/bc3de9aba6a41962e77b8b221100a40ee700edd7))
* **waypoints:** add readable display styling and opacity updates ([dedbef0](https://github.com/filiphsps/pumpkin-plugins/commit/dedbef0cc94e04a7a35e91edea84022cd2052a03))
* **waypoints:** add shared waypoint HUD and access rules ([54f39f1](https://github.com/filiphsps/pumpkin-plugins/commit/54f39f1d01ce916cffd64b7f6af79c651d77d829))
* **waypoints:** add versioned store and access policy ([4bc9a97](https://github.com/filiphsps/pumpkin-plugins/commit/4bc9a976da85b5a8e9b8eda8f4cbaa279875370e))
* **waypoints:** declutter and stabilize HUD presentation ([433532b](https://github.com/filiphsps/pumpkin-plugins/commit/433532b07cb917efa4f3d1c70f903f29be736b46))
* **waypoints:** scaffold plugin package ([fd9d03a](https://github.com/filiphsps/pumpkin-plugins/commit/fd9d03a273b7fc8d5b4737331ae3a7fac566fc63))
* **waypoints:** suggest accessible waypoint names ([d6f1145](https://github.com/filiphsps/pumpkin-plugins/commit/d6f1145e92298495fa6099ca9b1671d3adce546c))
* **waypoints:** support scalable HUD text displays ([56b2ba2](https://github.com/filiphsps/pumpkin-plugins/commit/56b2ba24d6279becc334007fcf53c555e30fe2cd))


### Bug Fixes

* **build:** atomically cache WASI definitions ([859091f](https://github.com/filiphsps/pumpkin-plugins/commit/859091fea7d15ba79fcf6b70e5eb8d34d70addc5))
* **build:** ignore empty cache directory overrides ([3431b84](https://github.com/filiphsps/pumpkin-plugins/commit/3431b84104f116d321341bf92092b7c583f5a67c))
* **build:** keep WASI staging out of shared cache ([c6b5da7](https://github.com/filiphsps/pumpkin-plugins/commit/c6b5da7128df9f2d011838c3e505381cea1a0e57))
* **build:** prepare WIT atomically ([d0b50e1](https://github.com/filiphsps/pumpkin-plugins/commit/d0b50e1f7a9f27c34ff6d0a8f4f9d025c70591d5))
* **build:** preserve artifact backup on rollback failure ([0f30c46](https://github.com/filiphsps/pumpkin-plugins/commit/0f30c4625a7a66c6e3442a648ca5c1aabbbecf44))
* **build:** publish components safely ([cc486c6](https://github.com/filiphsps/pumpkin-plugins/commit/cc486c6a2fdf8951a7674b058727c13c5846f285))
* **build:** reject null bytes in build paths ([a6efcf0](https://github.com/filiphsps/pumpkin-plugins/commit/a6efcf0cf9413a1ab052e8b400f0b63265d28a0b))
* **build:** reject unsupported command arguments ([74dea6b](https://github.com/filiphsps/pumpkin-plugins/commit/74dea6b6026456ce81750ef4e0464ba08156003c))
* **build:** replace stale generated type declarations ([ead7c8a](https://github.com/filiphsps/pumpkin-plugins/commit/ead7c8a6f7843142711af44702fb74e2787144e3))
* **build:** report package config read errors ([3aaf4b6](https://github.com/filiphsps/pumpkin-plugins/commit/3aaf4b6731409cbc76e6426918273fd8c4df16e1))
* **build:** require wasm output paths ([dffeb1b](https://github.com/filiphsps/pumpkin-plugins/commit/dffeb1b6d9feeb0aa9de955e2c27ceb73abb8c17))
* **build:** reset incomplete WIT copies before retry ([2ce981b](https://github.com/filiphsps/pumpkin-plugins/commit/2ce981b774b463db4d04c717a9457fb01e795974))
* **build:** retain type backup on rollback failure ([4bbeea0](https://github.com/filiphsps/pumpkin-plugins/commit/4bbeea03110d06372df608fc46e008ca991aee3a))
* **build:** retain validated WASI path ([56cf35c](https://github.com/filiphsps/pumpkin-plugins/commit/56cf35ce07b5361a5380d69ca2138f5b606200a5))
* **build:** scope typecheck outputs to plugins ([83c477d](https://github.com/filiphsps/pumpkin-plugins/commit/83c477d5e2e0540109623226fa01234dd453eb9b))
* **build:** validate plugin build config ([3a77136](https://github.com/filiphsps/pumpkin-plugins/commit/3a77136121f79c58e115f5ac66249cca5e3cc44b))
* **build:** validate required build fields early ([6791b89](https://github.com/filiphsps/pumpkin-plugins/commit/6791b89f1f3fdbb3e0187e4cabf5113e14ec88c4))
* **ci:** resolve waypoint documentation checks ([418b523](https://github.com/filiphsps/pumpkin-plugins/commit/418b5236f6429907494e8e78fbcb0cf04ae6eb19))
* **dev:** skip market checks and add no-reload mode ([f457446](https://github.com/filiphsps/pumpkin-plugins/commit/f457446d8de405594cf8cfdb73b9534f86f2e02b))
* **plugin-kit:** accept null optional resources during cleanup ([0c893d8](https://github.com/filiphsps/pumpkin-plugins/commit/0c893d83170dbc2637f2e6c66135d814833e5726))
* **plugin-kit:** avoid duplicate plugin load confirmation ([ed8191a](https://github.com/filiphsps/pumpkin-plugins/commit/ed8191ae4159612bfd5c6594b5500c7d30e92370))
* **plugin-kit:** generate host declarations for typecheck ([d3441a4](https://github.com/filiphsps/pumpkin-plugins/commit/d3441a4ec11e59a431798d71b826a0c5e8f817e9))
* **plugin-kit:** log plugin loads only after setup succeeds ([d8d5fb2](https://github.com/filiphsps/pumpkin-plugins/commit/d8d5fb221c9c626c41a73f43fd47c6a869dd1c95))
* **plugin-kit:** preserve files and clean up filesystem failures ([88a6a20](https://github.com/filiphsps/pumpkin-plugins/commit/88a6a20ebd0f6010c7546b9cd39aec654098cac8))
* **plugin-kit:** release scheduled handlers and prevent id collisions ([19927d7](https://github.com/filiphsps/pumpkin-plugins/commit/19927d7e2e3984cab188ffd0df0fe1f08364f8e6))
* **plugin-kit:** validate command handlers before allocating nodes ([2fd5bbb](https://github.com/filiphsps/pumpkin-plugins/commit/2fd5bbb8213bec67b3b3267b580e2e60b3933edf))
* **runtime:** preserve WIT 64-bit values as bigint ([6979f1d](https://github.com/filiphsps/pumpkin-plugins/commit/6979f1ddab17f67919a2b0a89e47bc3ee19b5dd7))
* **runtime:** release imported Wasm resources ([36a638c](https://github.com/filiphsps/pumpkin-plugins/commit/36a638c0b56658470a71c788df166edc491e2c89))
* **runtime:** tolerate missing WASI resource disposers ([110fca6](https://github.com/filiphsps/pumpkin-plugins/commit/110fca6094c4c88f99a2ffc4f7ff663aad838eea))
* **update-check:** unify HTTP polling and resource cleanup ([2909148](https://github.com/filiphsps/pumpkin-plugins/commit/2909148fceb4bfc7176cbf739565b647c7dfffe4))
* **update-check:** validate Market responses and semantic versions ([a424e66](https://github.com/filiphsps/pumpkin-plugins/commit/a424e664e5b3579312be7f95799ef4331af641f2))
* **waypoints:** accept vanilla item icon IDs ([50ac695](https://github.com/filiphsps/pumpkin-plugins/commit/50ac695384849354a4f92458b4de6d2371b6bc4b))
* **waypoints:** ease close-range waypoint transitions ([9e8c0ec](https://github.com/filiphsps/pumpkin-plugins/commit/9e8c0eca87689323fff9bd7cb3ed8a3e6b89f742))
* **waypoints:** ease projection depth into world anchors ([5e35aff](https://github.com/filiphsps/pumpkin-plugins/commit/5e35aff499f9752c47683449d45d00bd4c88a0b7))
* **waypoints:** encode atlas icons for Java clients ([5bcf09e](https://github.com/filiphsps/pumpkin-plugins/commit/5bcf09ef169e6dba38811ac8133f4ca8dbcee964))
* **waypoints:** keep nearby HUD markers above ground ([bc45d93](https://github.com/filiphsps/pumpkin-plugins/commit/bc45d93081cf298a1e2280faf7d06d2d2b66f8b1))
* **waypoints:** pretty print waypoint storage ([3e60838](https://github.com/filiphsps/pumpkin-plugins/commit/3e60838be3decd9b2ed2d20860faa749ec1a973a))
* **waypoints:** put HUD distance beside label ([6f7f976](https://github.com/filiphsps/pumpkin-plugins/commit/6f7f9760870e0371218b4b130c83be0d8e883519))
* **waypoints:** recover native item argument values ([15a31b2](https://github.com/filiphsps/pumpkin-plugins/commit/15a31b2ae86b2f0caac60f5db03fffea42baf141))
* **waypoints:** render configured icons below HUD labels ([8414615](https://github.com/filiphsps/pumpkin-plugins/commit/84146159878d350fb6382829923a319213940706))
* **waypoints:** reset visual history after position jumps ([0c33376](https://github.com/filiphsps/pumpkin-plugins/commit/0c33376a4becb08d6585916b2261aef42ee69015))
* **waypoints:** schedule HUD refresh outside event handlers ([dca502f](https://github.com/filiphsps/pumpkin-plugins/commit/dca502f8a22d7b2032633481ae1ed700d1bf5d49))
* **waypoints:** send precise HUD movement updates ([f16aba8](https://github.com/filiphsps/pumpkin-plugins/commit/f16aba82465f4b33cb364c610a754e3ec1b6f29f))
* **waypoints:** separate overlapping HUD labels ([605d171](https://github.com/filiphsps/pumpkin-plugins/commit/605d1712631103814c6dd0659634eb86b70b9f7b))
* **waypoints:** skip unavailable Java player handles ([072b975](https://github.com/filiphsps/pumpkin-plugins/commit/072b9755dbf0cf44f3a5ae7a164339bc8d6ae941))
* **waypoints:** stabilize directional HUD placement ([16dba05](https://github.com/filiphsps/pumpkin-plugins/commit/16dba05882ac750310834ad0da88e5bc415aa3a4))
* **waypoints:** stabilize HUD visibility and movement ([c918079](https://github.com/filiphsps/pumpkin-plugins/commit/c918079586a1a0622e0f46c7f47d8919fa4493c0))
* **waypoints:** stabilize stationary HUD camera ([2db53a8](https://github.com/filiphsps/pumpkin-plugins/commit/2db53a8aa21ae61a51b7d65fe17ab12fdf4c2bf2))

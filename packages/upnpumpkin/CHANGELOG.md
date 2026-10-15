# Changelog

## [0.1.0](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.8...upnpumpkin-v0.1.0) (2026-10-15)


### ⚠ BREAKING CHANGES

* **runtime:** switch to `static-hermes`

### Features

* add VS Code extension support ([2ea3984](https://github.com/filiphsps/pumpkin-plugins/commit/2ea39842a917d1cac6ddc149619d54bc5267f8b9))
* **build:** add opt-in Hermes TypeScript parsing ([ee3c10d](https://github.com/filiphsps/pumpkin-plugins/commit/ee3c10de8b3a7f7959aeeb47bbe61cd16283a8d1))
* **build:** add parse-ts build command ([bc072db](https://github.com/filiphsps/pumpkin-plugins/commit/bc072dbadfa806c49f401c14d642f6f9ce1e01a1))
* **build:** add typed standalone plugin builder ([39ff68e](https://github.com/filiphsps/pumpkin-plugins/commit/39ff68e5d963f5ba344dd6e6d989807e934becfe))
* **build:** build plugins with Static Hermes ([bff13b5](https://github.com/filiphsps/pumpkin-plugins/commit/bff13b57430f76ef9134b5543b4f1096cbd5d499))
* **build:** configure plugin runtime engine ([2c5c812](https://github.com/filiphsps/pumpkin-plugins/commit/2c5c812a6cd2c572385eed5be571702adc05413c))
* **build:** configure public npm publishing ([9b2efab](https://github.com/filiphsps/pumpkin-plugins/commit/9b2efab13cbb399bec7eba10a758b96baae4dd2b))
* **build:** enforce production wasm size limit ([f084e02](https://github.com/filiphsps/pumpkin-plugins/commit/f084e02733f1d0100f78d7fb7131fae51da2ccaf))
* **build:** notify about available updates ([50c7cc0](https://github.com/filiphsps/pumpkin-plugins/commit/50c7cc0f98198362d54e670e9eec763aef36a2aa))
* **build:** show Static Hermes selections in verbose logs ([f5e0f8d](https://github.com/filiphsps/pumpkin-plugins/commit/f5e0f8d2e642e8b7fa9fbcfbd783c318a0470516))
* **build:** show TypeScript parser mode ([6e7c60b](https://github.com/filiphsps/pumpkin-plugins/commit/6e7c60b0fa57f15f26f16ef0d70be77801846910))
* **docs:** add reusable document generation and source discovery ([33cab22](https://github.com/filiphsps/pumpkin-plugins/commit/33cab2216fd60efd9d52611fa885d5a630ea78d6))
* **docs:** group site pages by source structure ([2a476f8](https://github.com/filiphsps/pumpkin-plugins/commit/2a476f820f8db2b11379764e8da5c871908fdd3e))
* **pumpkin-api:** add pinned first-party host API ([88d58ea](https://github.com/filiphsps/pumpkin-plugins/commit/88d58ea26e9d38d3183f50c441486de37c6d665f))
* **pumpkin-api:** validate compatibility matrices with schema ([12b48b9](https://github.com/filiphsps/pumpkin-plugins/commit/12b48b963295a13bb24d3f6f819d42838de64961))
* **release:** register public tools as components ([44d8b0c](https://github.com/filiphsps/pumpkin-plugins/commit/44d8b0c79f2875e668641e9b22a4673bd20aa209))
* **runtime:** add standalone Static Hermes package ([f9b24e3](https://github.com/filiphsps/pumpkin-plugins/commit/f9b24e3b5a190a54090a87c6f1141ff075dfaeb0))
* **runtime:** add typed Hermes host API shim ([1acf97b](https://github.com/filiphsps/pumpkin-plugins/commit/1acf97bb06f9dd56eee172539054f5e4e90b017d))
* **runtime:** bundle plugins for Static Hermes ([2105469](https://github.com/filiphsps/pumpkin-plugins/commit/2105469a07b8f90f964dd9f10008017fbdaaa01f))
* **runtime:** switch to `static-hermes` ([fafe44f](https://github.com/filiphsps/pumpkin-plugins/commit/fafe44fcf3c894e38bde43050128cbff522d530e))
* **static-hermes-runtime:** replace legacy scripts with typed CLI ([2545271](https://github.com/filiphsps/pumpkin-plugins/commit/2545271153cc663a62b63a9822b17fe8b24e3dc1))
* **static-hermes-runtime:** support opt-in TypeScript bundles ([0358ed2](https://github.com/filiphsps/pumpkin-plugins/commit/0358ed276ce1975483a6f37cbfdfd44c72110478))
* **static-hermes-runtime:** support portable packaged builds ([e999bfd](https://github.com/filiphsps/pumpkin-plugins/commit/e999bfd4a02714c250ba85b6c7e1b8104cffb9a4))
* **static-hermes:** add Hades GC selection ([e6f6455](https://github.com/filiphsps/pumpkin-plugins/commit/e6f64550857c52eb45549717ea81b729e66f3073))
* **static-hermes:** expand plugin workload benchmarks ([9f8f528](https://github.com/filiphsps/pumpkin-plugins/commit/9f8f528daf89d94979b2dc021c05c22303a9613c))
* **static-hermes:** generate WIT adapters and make runtime default ([000242f](https://github.com/filiphsps/pumpkin-plugins/commit/000242fe6c6b255625096f09a9d902ef949233bf))
* **tool-publishing:** register remaining public tools ([2884552](https://github.com/filiphsps/pumpkin-plugins/commit/2884552bcc0c60dea8c7b00bd51c082291ed8d33))


### Bug Fixes

* align workspace dependency sections with imports ([86aa0e2](https://github.com/filiphsps/pumpkin-plugins/commit/86aa0e2d392d621e0b09c39c6320ff8736be4272))
* **bench:** streamline runtime comparison output ([5c6b1ad](https://github.com/filiphsps/pumpkin-plugins/commit/5c6b1ad9a1138b438d39a55cc3932409aec2323e))
* **build:** avoid duplicate WIT output ([aaad9b5](https://github.com/filiphsps/pumpkin-plugins/commit/aaad9b51f6cde3e0eaf9805bd8f93d87007827b2))
* **build:** clean abandoned staging directories ([667b8d6](https://github.com/filiphsps/pumpkin-plugins/commit/667b8d67004992d5300d7958fe006c439a186e38))
* **build:** define NODE_ENV for plugin bundles ([562bf66](https://github.com/filiphsps/pumpkin-plugins/commit/562bf66f2400edfd017c4571057dbb07b15e134f))
* **build:** flush CLI errors before exiting ([2da29c9](https://github.com/filiphsps/pumpkin-plugins/commit/2da29c9d5f55553761827a1cd0d0481d7e007733))
* **build:** normalize package-relative paths ([d2942ca](https://github.com/filiphsps/pumpkin-plugins/commit/d2942ca1cc65b19ed72ada31b3c08b4b2b18f70d))
* **build:** prepare Static Hermes once per workspace build ([39da283](https://github.com/filiphsps/pumpkin-plugins/commit/39da28396c688fb85a5d7ca8ccd522ed879cec9d))
* **build:** publish isolated WIT snapshots and resolve API aliases ([7aa0f66](https://github.com/filiphsps/pumpkin-plugins/commit/7aa0f66ca0545014f1b8aad9e4ba3ffcc36965f0))
* **build:** resolve aliased WIT constructors during adapter analysis ([54f9f53](https://github.com/filiphsps/pumpkin-plugins/commit/54f9f53b04844eb2ce55f9319c3c8b9d775fa917))
* **build:** validate and serialize WASI WIT cache writes ([44994cf](https://github.com/filiphsps/pumpkin-plugins/commit/44994cf21a2058d1398a830b984afc65e622915d))
* **ci:** preserve lf shebangs in packed tools ([9e6197f](https://github.com/filiphsps/pumpkin-plugins/commit/9e6197f6a110942ed12837e316ee241cded07109))
* **config:** validate defaults and isolate config values ([ece475f](https://github.com/filiphsps/pumpkin-plugins/commit/ece475fa28fbeef465d340056c355904858010d4))
* **docs:** avoid regex backtracking in table cells ([a1ff2e4](https://github.com/filiphsps/pumpkin-plugins/commit/a1ff2e4c27710028d7c8f78e8a2825f0e23c7dfa))
* **docs:** contain generated targets and normalize metadata ([d41718d](https://github.com/filiphsps/pumpkin-plugins/commit/d41718d7149e0531b4070471a66a8c985f67a20f))
* incomplete string escaping or encoding ([18cead0](https://github.com/filiphsps/pumpkin-plugins/commit/18cead0dac369a367da770bb022c0d0de603d898))
* **plugin-kit:** ignore task ids from other plugins ([c296825](https://github.com/filiphsps/pumpkin-plugins/commit/c296825de37023156a5b7c17ad0ca72508fce06f))
* **port-mapping:** scan router URLs without backtracking ([65506d5](https://github.com/filiphsps/pumpkin-plugins/commit/65506d5eca1bfb46e14e3f800d0aa7631bb2a4a9))
* **port-mapping:** validate router endpoints and responses ([b89a3bb](https://github.com/filiphsps/pumpkin-plugins/commit/b89a3bbd0ba858ea9027e2f1dbecd1fd013602d2))
* **publishing:** narrow public tool package contents ([140d8d9](https://github.com/filiphsps/pumpkin-plugins/commit/140d8d9e0671cb785a829157c649223e2c5f776a))
* **pumpkin-api:** guard Git clone remote arguments ([c5bdfca](https://github.com/filiphsps/pumpkin-plugins/commit/c5bdfca57d6ae109e4c56de996602e81fc067f0a))
* **pumpkin-api:** include migration docs in typecheck ([5de85f9](https://github.com/filiphsps/pumpkin-plugins/commit/5de85f954be937e30fa31f3f12b293bf63ad681b))
* **pumpkin-api:** release callbacks on failed registration and unload ([1517db4](https://github.com/filiphsps/pumpkin-plugins/commit/1517db4d7cf7dd4dd115d5f1324dc65d11f27303))
* **pumpkin-api:** verify pinned WIT cache contents ([02432bf](https://github.com/filiphsps/pumpkin-plugins/commit/02432bf7682ce8c0c61ac15e89e73e1d110b9a33))
* **release:** enforce public tool Node engines ([94b3979](https://github.com/filiphsps/pumpkin-plugins/commit/94b3979c28b61b8c0fef4b7af19d09aaa44e36c6))
* **runtime:** dispatch callbacks and release WIT resources ([d935e60](https://github.com/filiphsps/pumpkin-plugins/commit/d935e60dbf2139da6b8d3735472e037492a47216))
* **schemas:** use master URLs for lockfile schemas ([808802d](https://github.com/filiphsps/pumpkin-plugins/commit/808802d79782624a30493c238ced20ad5521fb4e))
* **static-hermes-runtime:** apply patches reliably on Windows ([c6a7b73](https://github.com/filiphsps/pumpkin-plugins/commit/c6a7b73e15ce0a363bc980af00b395527113a4cd))
* **static-hermes-runtime:** clean up failed Hermes source clones ([6faa733](https://github.com/filiphsps/pumpkin-plugins/commit/6faa733994d27d6bd53b53ed8079f36660cccbf1))
* **static-hermes-runtime:** correct WASI memory compatibility ([9aa77ad](https://github.com/filiphsps/pumpkin-plugins/commit/9aa77adc26a4f6a1c0ee06d20ea6697c1361bfb6))
* **static-hermes-runtime:** guard WIT memory during conversion ([01ab7b0](https://github.com/filiphsps/pumpkin-plugins/commit/01ab7b0451d02cfda0021f83dfe9296e7f2ce0ed))
* **static-hermes-runtime:** handle Windows WASI configuration ([d7dc717](https://github.com/filiphsps/pumpkin-plugins/commit/d7dc71749f3237a02480dfd71d317f46191ddba3))
* **static-hermes-runtime:** harden WIT code generation and component builds ([2a49fe7](https://github.com/filiphsps/pumpkin-plugins/commit/2a49fe71cc93c374dbdd8edc6a6b03cf57c9db21))
* **static-hermes-runtime:** preserve event results and resources ([64e4e4b](https://github.com/filiphsps/pumpkin-plugins/commit/64e4e4bf00d3330e0e1f13ece548b5cdb1cf091c))
* **static-hermes-runtime:** preserve LF in pinned source checkout ([330aff0](https://github.com/filiphsps/pumpkin-plugins/commit/330aff08c0ec301cc3fbc2d2b268448f914009c2))
* **static-hermes-runtime:** protect shared build locks ([c52a12a](https://github.com/filiphsps/pumpkin-plugins/commit/c52a12a09ff23be66eb315c1d3a5fa2e8a92de4e))
* **static-hermes-runtime:** publish WASI SDK cache safely ([a3b8c19](https://github.com/filiphsps/pumpkin-plugins/commit/a3b8c19d996d945d21dc4527d39c12b8939b635b))
* **static-hermes-runtime:** serialize Hermes preparation stages ([458200d](https://github.com/filiphsps/pumpkin-plugins/commit/458200d19b555cd109a1ef1c373e161d40d3aeee))
* **static-hermes-runtime:** serialize shared Hermes cache mutations ([b5ce293](https://github.com/filiphsps/pumpkin-plugins/commit/b5ce2930db7e235037e7042a41a611474027c6f7))
* **static-hermes-runtime:** use MSVC-compatible host flags ([f00a9f8](https://github.com/filiphsps/pumpkin-plugins/commit/f00a9f8c587ae97bb839f30f0b6be4a18f45ee5f))
* **static-hermes-runtime:** verify pinned toolchain releases and repair caches ([b56cb51](https://github.com/filiphsps/pumpkin-plugins/commit/b56cb51aacbadf2126ff8a5bbc2486292831b37b))
* **static-hermes:** prune adapters for static event registrations ([a07538a](https://github.com/filiphsps/pumpkin-plugins/commit/a07538a53fb61ed7fd9539737cc75130982d5c04))
* **static-hermes:** respect transferred resource ownership ([44a9ceb](https://github.com/filiphsps/pumpkin-plugins/commit/44a9cebbd58c5e31d51851ea7cb7ce0bcd990ed1))
* **tooling:** harden WIT and runtime integration ([54469c3](https://github.com/filiphsps/pumpkin-plugins/commit/54469c39daaae1d180dd4abfd64cf362f0c291dd))
* tools/static-hermes-runtime/src/component/templates/runtime-shim.template ([670ade0](https://github.com/filiphsps/pumpkin-plugins/commit/670ade075b77253ecc03b1107cb01234a1b30ba6))
* **update-check:** recognize WASI stream end-of-body ([059c7a1](https://github.com/filiphsps/pumpkin-plugins/commit/059c7a11401e3e34ee25dd9d8f9635f2051c6487))
* **upnpumpkin:** harden network and protocol handling ([bc446d1](https://github.com/filiphsps/pumpkin-plugins/commit/bc446d18a62ca0316eb85a904868528436300e2e))


### Performance Improvements

* **build:** enable explicit tree shaking ([388553d](https://github.com/filiphsps/pumpkin-plugins/commit/388553d61f654770d9f7630ae7a2bb9fe4872d7a))
* **runtime:** make benchmark workloads actionable ([8acb186](https://github.com/filiphsps/pumpkin-plugins/commit/8acb18638af03a68fa33d84dfd51dba9a0c3a725))
* **static-hermes-runtime:** add ASCII string fast paths ([eeb14b2](https://github.com/filiphsps/pumpkin-plugins/commit/eeb14b2ae4aa09923ac1aafc2a4dbfa810a62ae3))
* **static-hermes-runtime:** add Hermes string fast paths ([1945269](https://github.com/filiphsps/pumpkin-plugins/commit/19452693d5d7ada6759f9c41b48ab80d71b228cf))
* **static-hermes-runtime:** add string fast paths ([369381a](https://github.com/filiphsps/pumpkin-plugins/commit/369381a972a6ca8f1b271f9f450c3cb5d04bbe35))

## [0.0.8](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.7...upnpumpkin-v0.0.8) (2026-10-11)


### Features

* **plugin-kit:** support double and player selector arguments ([bfbf5e9](https://github.com/filiphsps/pumpkin-plugins/commit/bfbf5e92957fa2d884778fed05436c1f576c76e0))
* **plugin-kit:** support dynamic command suggestions ([678396f](https://github.com/filiphsps/pumpkin-plugins/commit/678396fa657faef06152f32240bdb4dbab54290f))
* **waypoints:** add shared waypoint HUD and access rules ([54f39f1](https://github.com/filiphsps/pumpkin-plugins/commit/54f39f1d01ce916cffd64b7f6af79c651d77d829))


### Bug Fixes

* **build:** verify pinned runtime provenance ([04c7590](https://github.com/filiphsps/pumpkin-plugins/commit/04c75909f351abb2bbecd10d7c38ca721753fb1f))
* **ci:** verify host-specific runtime builds ([825676e](https://github.com/filiphsps/pumpkin-plugins/commit/825676e1fac8934e8ea422c6f77254acd1213b46))
* **port-mapping:** account for creation during shutdown ([08ff31f](https://github.com/filiphsps/pumpkin-plugins/commit/08ff31fe83b44cb8ca29762bb327b68c3ee96a2f))
* **port-mapping:** compensate confirmed late creations ([5a9c218](https://github.com/filiphsps/pumpkin-plugins/commit/5a9c2189655791e76e579e5d9616615eb7369031))
* **port-mapping:** enforce physical mapping identity ([0681c43](https://github.com/filiphsps/pumpkin-plugins/commit/0681c432449f1a2514ff4dc4eae4902c190ad996))
* **port-mapping:** maintain permanent router mappings ([b42745c](https://github.com/filiphsps/pumpkin-plugins/commit/b42745cb3cb6665579263060a25e23a919a3ddbe))
* **port-mapping:** reject invalid chunk length tokens ([c356e51](https://github.com/filiphsps/pumpkin-plugins/commit/c356e51c27e13de4b72d9cacb36b6407a097c53b))
* **port-mapping:** reject truncated framed responses ([fbf6719](https://github.com/filiphsps/pumpkin-plugins/commit/fbf6719e54839b026443deb255e84a3fd76cf60a))
* **port-mapping:** report listener port on public hosts ([ace727d](https://github.com/filiphsps/pumpkin-plugins/commit/ace727d168614b4417061acb39c19cbb9e0270bd))
* **port-mapping:** retain mappings for compatible owners ([ba86e79](https://github.com/filiphsps/pumpkin-plugins/commit/ba86e7984bc1428e484f606747011b56484afb47))
* **port-mapping:** validate chunk delimiters and trailers ([6c906fd](https://github.com/filiphsps/pumpkin-plugins/commit/6c906fd42948dfb388bd2f29e5b604a1eccbfe8b))
* **port-mapping:** validate SOAP action responses ([eaff6e8](https://github.com/filiphsps/pumpkin-plugins/commit/eaff6e8149b45729d7628b303df139d4602319ea))
* **runtime:** preserve WIT 64-bit values as bigint ([6979f1d](https://github.com/filiphsps/pumpkin-plugins/commit/6979f1ddab17f67919a2b0a89e47bc3ee19b5dd7))
* **runtime:** release imported Wasm resources ([36a638c](https://github.com/filiphsps/pumpkin-plugins/commit/36a638c0b56658470a71c788df166edc491e2c89))
* **upnpumpkin:** cancel cleanup at shutdown deadline ([7869985](https://github.com/filiphsps/pumpkin-plugins/commit/78699858dd137538affbb9c98a2a1b17ce5a36da))
* **upnpumpkin:** retain received UDP batches ([970b7e2](https://github.com/filiphsps/pumpkin-plugins/commit/970b7e29e67a4fcd39e9469880d5c0a47be3bef5))
* **upnpumpkin:** retire reloaded mappers across ticks ([feb34f5](https://github.com/filiphsps/pumpkin-plugins/commit/feb34f579f005e5fbd645684b26b1ad161792370))
* **waypoints:** recover native item argument values ([15a31b2](https://github.com/filiphsps/pumpkin-plugins/commit/15a31b2ae86b2f0caac60f5db03fffea42baf141))

## [0.0.7](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.6...upnpumpkin-v0.0.7) (2026-10-08)


### Features

* **commands:** support positional argument variants ([689de6c](https://github.com/filiphsps/pumpkin-plugins/commit/689de6c52d011449a93ad007409be114e72f7e06))
* **docs:** collapse generated config files in readmes ([a05d1aa](https://github.com/filiphsps/pumpkin-plugins/commit/a05d1aabdfbd22508deb985b4e20b97a0dde6ad0))
* **docs:** support typed command arguments ([ee0b90f](https://github.com/filiphsps/pumpkin-plugins/commit/ee0b90fe42eb788246dea3cd549d8c53a428842a))
* **minecraft-colors:** add ANSI terminal formatting ([bb6eb16](https://github.com/filiphsps/pumpkin-plugins/commit/bb6eb162ff291855286923f42013ffa9bca005ca))
* **minecraft-colors:** add more named colors ([8e05b09](https://github.com/filiphsps/pumpkin-plugins/commit/8e05b0917c62766e9faaa528649740e1f399bfe8))
* **minecraft-colors:** add semantic color presets ([72e3839](https://github.com/filiphsps/pumpkin-plugins/commit/72e3839eee71be8bf5398715b17a761065f8837d))
* **minecraft-colors:** add string formatting helpers ([b99a342](https://github.com/filiphsps/pumpkin-plugins/commit/b99a3424a264b77ca2394f9d05752c705635341e))
* **plugin-kit:** support typed command arguments ([54544fc](https://github.com/filiphsps/pumpkin-plugins/commit/54544fc3e40ef68dd9d453ffea3fbb61a65c4580))


### Bug Fixes

* **dev:** skip market checks and add no-reload mode ([f457446](https://github.com/filiphsps/pumpkin-plugins/commit/f457446d8de405594cf8cfdb73b9534f86f2e02b))

## [0.0.6](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.5...upnpumpkin-v0.0.6) (2026-10-07)


### Features

* **docs:** add generated documentation site ([545c749](https://github.com/filiphsps/pumpkin-plugins/commit/545c74944f65e38fb927fcde588fd17848298cf8))
* **docs:** add grouped responsive navigation ([1fbf8b5](https://github.com/filiphsps/pumpkin-plugins/commit/1fbf8b586393b28132e3eedaf8543429ef9d8544))
* **docs:** add integrated API references ([4309016](https://github.com/filiphsps/pumpkin-plugins/commit/4309016cd19a7328c7ac1dd7ea3df790573df73d))
* **docs:** publish plugin icons in navigation ([73655b5](https://github.com/filiphsps/pumpkin-plugins/commit/73655b5ea4b73e107eb4ca13b47bdea07070b727))
* **plugin-kit:** support hierarchical command permissions ([854f5cc](https://github.com/filiphsps/pumpkin-plugins/commit/854f5cc2233559bcaa34b2ecb0a19bec88a9f774))


### Bug Fixes

* **upnpumpkin:** split command permissions ([2dc1caf](https://github.com/filiphsps/pumpkin-plugins/commit/2dc1caf53e5ceea719ec75b89d9711a570e61538))

## [0.0.5](https://github.com/filiphsps/pumpkin-plugins/compare/upnpumpkin-v0.0.4...upnpumpkin-v0.0.5) (2026-10-06)


### Features

* **actions:** add signing action and generated catalog ([43e941c](https://github.com/filiphsps/pumpkin-plugins/commit/43e941ce09f5f5d3457f87f3cd7ad88bdaea4da4))

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

# Changelog

## [0.1.1](https://github.com/filiphsps/pumpkin-plugins/compare/static-hermes-runtime-v0.1.0...static-hermes-runtime-v0.1.1) (2026-10-17)


### Features

* **wasi:** share capability metadata across tooling ([bbe0f2f](https://github.com/filiphsps/pumpkin-plugins/commit/bbe0f2f093273132e8fd2101233cada29af270e7))

## 0.1.0 (2026-10-15)


### Features

* add VS Code extension support ([2ea3984](https://github.com/filiphsps/pumpkin-plugins/commit/2ea39842a917d1cac6ddc149619d54bc5267f8b9))
* **pumpkin-api:** add pinned first-party host API ([88d58ea](https://github.com/filiphsps/pumpkin-plugins/commit/88d58ea26e9d38d3183f50c441486de37c6d665f))
* **release:** register public tools as components ([44d8b0c](https://github.com/filiphsps/pumpkin-plugins/commit/44d8b0c79f2875e668641e9b22a4673bd20aa209))
* **runtime:** add standalone Static Hermes package ([f9b24e3](https://github.com/filiphsps/pumpkin-plugins/commit/f9b24e3b5a190a54090a87c6f1141ff075dfaeb0))
* **runtime:** add typed Hermes host API shim ([1acf97b](https://github.com/filiphsps/pumpkin-plugins/commit/1acf97bb06f9dd56eee172539054f5e4e90b017d))
* **runtime:** bundle plugins for Static Hermes ([2105469](https://github.com/filiphsps/pumpkin-plugins/commit/2105469a07b8f90f964dd9f10008017fbdaaa01f))
* **static-hermes-runtime:** replace legacy scripts with typed CLI ([2545271](https://github.com/filiphsps/pumpkin-plugins/commit/2545271153cc663a62b63a9822b17fe8b24e3dc1))
* **static-hermes-runtime:** support opt-in TypeScript bundles ([0358ed2](https://github.com/filiphsps/pumpkin-plugins/commit/0358ed276ce1975483a6f37cbfdfd44c72110478))
* **static-hermes-runtime:** support portable packaged builds ([e999bfd](https://github.com/filiphsps/pumpkin-plugins/commit/e999bfd4a02714c250ba85b6c7e1b8104cffb9a4))
* **static-hermes:** add Hades GC selection ([e6f6455](https://github.com/filiphsps/pumpkin-plugins/commit/e6f64550857c52eb45549717ea81b729e66f3073))
* **static-hermes:** expand plugin workload benchmarks ([9f8f528](https://github.com/filiphsps/pumpkin-plugins/commit/9f8f528daf89d94979b2dc021c05c22303a9613c))
* **static-hermes:** generate WIT adapters and make runtime default ([000242f](https://github.com/filiphsps/pumpkin-plugins/commit/000242fe6c6b255625096f09a9d902ef949233bf))
* **testing:** add workspace coverage reports ([8db42a8](https://github.com/filiphsps/pumpkin-plugins/commit/8db42a870f5bc2526890f3144b80308dc9bab006))
* **waypoints:** add shared waypoint HUD and access rules ([54f39f1](https://github.com/filiphsps/pumpkin-plugins/commit/54f39f1d01ce916cffd64b7f6af79c651d77d829))


### Bug Fixes

* **bench:** streamline runtime comparison output ([5c6b1ad](https://github.com/filiphsps/pumpkin-plugins/commit/5c6b1ad9a1138b438d39a55cc3932409aec2323e))
* **build:** prepare Static Hermes once per workspace build ([39da283](https://github.com/filiphsps/pumpkin-plugins/commit/39da28396c688fb85a5d7ca8ccd522ed879cec9d))
* **ci:** preserve lf shebangs in packed tools ([9e6197f](https://github.com/filiphsps/pumpkin-plugins/commit/9e6197f6a110942ed12837e316ee241cded07109))
* **publishing:** narrow public tool package contents ([140d8d9](https://github.com/filiphsps/pumpkin-plugins/commit/140d8d9e0671cb785a829157c649223e2c5f776a))
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
* **tooling:** harden WIT and runtime integration ([54469c3](https://github.com/filiphsps/pumpkin-plugins/commit/54469c39daaae1d180dd4abfd64cf362f0c291dd))
* tools/static-hermes-runtime/src/component/templates/runtime-shim.template ([670ade0](https://github.com/filiphsps/pumpkin-plugins/commit/670ade075b77253ecc03b1107cb01234a1b30ba6))


### Performance Improvements

* **runtime:** make benchmark workloads actionable ([8acb186](https://github.com/filiphsps/pumpkin-plugins/commit/8acb18638af03a68fa33d84dfd51dba9a0c3a725))
* **static-hermes-runtime:** add ASCII string fast paths ([eeb14b2](https://github.com/filiphsps/pumpkin-plugins/commit/eeb14b2ae4aa09923ac1aafc2a4dbfa810a62ae3))
* **static-hermes-runtime:** add Hermes string fast paths ([1945269](https://github.com/filiphsps/pumpkin-plugins/commit/19452693d5d7ada6759f9c41b48ab80d71b228cf))
* **static-hermes-runtime:** add string fast paths ([369381a](https://github.com/filiphsps/pumpkin-plugins/commit/369381a972a6ca8f1b271f9f450c3cb5d04bbe35))

# Maintaining the Hermes patch series

Use this guide when you move the Hermes pin, change a patch, or add or drop one. For WASI interfaces
and native adapters, see the [WASI maintenance guide](maintaining-wasi.md).

## Source files

| Concern | Source |
| --- | --- |
| Pinned Hermes repository, branch, and commit | [`hermes-source.lock.json`](../hermes-source.lock.json) |
| Patch series, applied in numeric order | [`hermes-patches/`](../hermes-patches) |
| WASI CMake toolchain | [`cmake/wasi-sdk-hermes-p2.cmake`](../cmake/wasi-sdk-hermes-p2.cmake) |
| Checkout, refresh, and clone of the pinned source | [`src/hermes/source.ts`](../src/hermes/source.ts) |
| Patch discovery, application, and verification | [`src/hermes/patch.ts`](../src/hermes/patch.ts) |
| CMake commands, build cache, and locks | [`src/hermes/build.ts`](../src/hermes/build.ts) |

## How the series is applied

`hermes prepare` checks out the pinned commit, applies every patch with `git apply`, then builds the
host compiler and the WASI archives. Patch numbers must start at `0001` and have no gaps. A change
in the checkout outside the files the series touches stops the run.

To find out what is already applied, the runtime replays the series one patch at a time on a
temporary Git index that starts at the pinned commit. It compares the managed files with the index
after each step. A checkout that holds the first patches gets only the rest, so a patch may build on
context from an earlier one. When the managed files match no step, or a patch does not apply,
`hermes prepare` clones the source again from the pin and applies the series to the fresh copy. The
build checks again that the whole series is present before it runs CMake.

The build cache fingerprint covers the pin, each patch file, the toolchain file, the toolchain
version locks, the compiler versions, and the CMake commands the build runs. Editing a patch rebuilds Hermes. Editing
TypeScript that does not change those commands does not.

## Patch format

Each patch is `git format-patch` output without the `From` and `Date` header lines. It opens with a
`Subject:` line and a short note: why the change exists, whether it was sent upstream, and when it
can be dropped. The diffstat and the diff follow. Text before the first `diff --git` line is ignored
by `git apply`, so the note costs nothing at build time.

Patches `0001` to `0004` make Hermes build for WASI preview 2. Patches `0005` onward are
performance changes to string builders and must not change results. Components run Hermes bytecode
in the interpreter, so a change only to `shermes` native output or the JIT has no effect on plugins.

## Move the pin or rebase the series

1. From the repository root, clone Hermes and check out the current pin:

   ```sh
   git clone --filter=blob:none --no-checkout https://github.com/facebook/hermes.git hermes
   git -C hermes fetch --depth 1 origin <current-commit>
   git -C hermes checkout --detach <current-commit>
   ```

2. Turn each patch into a commit. `--3way` stops on a conflict so you can fix it, `git add` the
   result, and continue the loop from that patch:

   ```sh
   cd hermes
   for patch in ../tools/static-hermes-runtime/hermes-patches/*.patch; do
       git apply --3way "$patch" || break
       git add -A
       sed -e '1s/^Subject: \[PATCH\] //' -e '/^---$/,$d' "$patch" | git commit --quiet -F -
   done
   ```

3. To move the pin, fetch the new commit and rebase the patch commits onto it with
   `git rebase --onto <new-commit> <current-commit>`. Edit a patch with an interactive rebase. Update
   its note when the reason or upstream status changes, and drop a patch whose change upstream now
   has.

4. Export the series and write it back without the `From` and `Date` lines. The first three lines of
   each exported file are those headers:

   ```sh
   git format-patch --quiet --zero-commit --no-signature -N -o ../hermes-series <new-commit>..HEAD
   ```

   Copy each file into `hermes-patches/` with `tail -n +4`, keeping the existing file names so
   history stays readable. Renumber only when you add or remove a patch.

5. Update `commit` (and `branch` if it moved) in `hermes-source.lock.json`.

## Checks

Build the patched host compiler and WASI archives from a clean cache:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime prepare-hermes
```

Then run the runtime's unit and real-server tests, and the integration tests of the plugins:

```sh
pnpm --filter @pumpkin-plugins/static-hermes-runtime test
pnpm --filter @pumpkin-plugins/static-hermes-runtime test:integration
pnpm test:integration
```

For a performance patch, compare the [engine benchmark](../../../docs/benchmarking.md)
before and after the change.

Patch `0007` adds a `JSLibTest` case. The WASI build does not compile Hermes unit tests, so run it
from a host build of the patched checkout:

```sh
cmake -S hermes -B hermes-tests -G Ninja -DHERMES_ENABLE_TEST_SUITE=ON
cmake --build hermes-tests --target HermesVMRuntimeTests
hermes-tests/unittests/VMRuntime/HermesVMRuntimeTests --gtest_filter='JSLibTest.*'
```

# Release History

*****************

## Release ONDEWO CSI Js Client 5.5.3

### Bug Fixes

* **5.5.0, 5.5.1 and 5.5.2 could not deserialize a single string field.**
  `api/ondewo_csi_api.js` is a self-contained browser bundle: it embeds the `google-protobuf`
  runtime installed when it was built. The proto compiler now emits
  `reader.readStringRequireUtf8()` (1907 call sites; 5.4.1 had zero), and that method does not
  exist in `google-protobuf` 3.21.4 -- which `src/package.json` pinned as `^3.21.4`, a range that
  can never resolve to the 4.x line where it was added. Every `deserializeBinary` on a message
  carrying a string threw `TypeError: reader.readStringRequireUtf8 is not a function`.
* The runtime pin is `^4.0.2` now and the bundle is rebuilt against it. No generated message code
  and no proto content changed.
* **A guard was added, because nothing in this repository could see the defect.** The `.proto`
  sources, the generated `_pb.js`, the auth suite and its 100% coverage gate were all correct --
  only the bundle's embedded runtime was wrong, so only a test that loads the SHIPPED BUNDLE and
  decodes a message could catch it. `tests/bundleStringRoundTrip.spec.js` evaluates the bundle in a
  `vm` with no `require` available and round-trips a string with multi-byte characters; it is
  verified falsifiable against the published 5.5.2 bundle, which fails it.

*****************

## Release ONDEWO CSI Js Client 5.5.2

### Bug Fixes

* **Release integrity: 5.5.1 published the Keycloak refresh fix to npm but its git tag did not
  contain it.** `make build` copies `auth/` into the published package, so the artifact carried the
  fix, while the release target's `git add` list named `api`, `Makefile`, `src`, `RELEASE.md`, the
  two package manifests and the submodules -- and not `auth/`. Building 5.5.1 from its tag therefore
  produced different code than installing 5.5.1 from npm. `auth/` is in that list now.
* The code is otherwise identical to 5.5.1: the same bounded, jittered backoff on the background
  token refresh. Nothing to change when upgrading; 5.5.2 exists so the tag and the artifact agree.

*****************

## Release ONDEWO CSI Js Client 5.5.1

### Bug Fixes

* A failed background token refresh no longer ends token renewal for the life of the process.
  `scheduleRefresh` ran only on the success path, so a single transient Keycloak failure left no timer
  armed: the access token then lapsed and every later call failed `UNAUTHENTICATED` until the
  application logged in again. The stale token keeps working until it expires, which is what made the
  defect silent.
* The failure path now re-arms with bounded exponential backoff and full jitter -- 5 s doubling to a
  300 s ceiling, with the actual wait drawn uniformly from `[base, ceiling]` -- rather than at the 1 s
  scheduling floor. The jitter is load-bearing at ondewo's fan-out: one client per call container means
  N clients whose refreshes fail in the same instant would otherwise retry in lockstep against a realm
  they all share.
* A successful refresh resets the backoff ladder, and the bounded-deadline and `stop()` guards still
  apply to every re-arm.
* An `onRefreshError` handler that throws no longer kills the refresh loop, and its error no longer
  escapes the timer callback as a process-fatal `unhandledRejection`.

*****************

## Release ONDEWO CSI Js Client 5.5.0

### Improvements

* Built against [ondewo-csi-api 5.5.0](https://github.com/ondewo/ondewo-csi-api/releases/tag/5.5.0), which tracks ondewo-nlu-api 7.1.0 (was 7.0.0) and ondewo-s2t-api 7.5.0 (was 7.4.0).
* `ondewo/csi/conversation.proto` is unchanged in that API release, so the CSI service surface is identical and this client stays wire-compatible with its predecessor. What grows is the vendored surface it re-exports: `speech-to-text.proto` gains the `VadMethod` and `TsdMethod` enums and the `Silero` and `WespeakerTsd` messages (voice-activity and turn-shift detection configuration), and `rag.proto` gains `RagCrawlerIncrementalConfig`.

*****************

## Release ONDEWO CSI Js Client 5.4.1

### Bug Fixes

* [[OND221-2830]](https://ondewo.atlassian.net/browse/OND221-2830) Regenerated with [ondewo-proto-compiler 5.13.0](https://github.com/ondewo/ondewo-proto-compiler/releases/tag/5.13.0).
* [[OND221-2830]](https://ondewo.atlassian.net/browse/OND221-2830) No change to how the auth helper is consumed: this package ships a webpack bundle rather than a public-api barrel, and the auth helper is a Node-only `undici` consumer that does not belong in a browser bundle. It ships as its own CommonJS entry and is imported directly (`require('<pkg>/auth/offlineTokenProvider')`).
* [[OND221-2830]](https://ondewo.atlassian.net/browse/OND221-2830) Tooling: `conventional-pre-commit` now runs before `giticket` at the commit-msg stage - with giticket first, its `[OND221-2830] fix: ...` rewrite was no longer valid Conventional Commits and every commit on a ticket branch failed. `README.md` is prettier-ignored where `.prettierrc` sets `useTabs` and markdownlint's MD010 de-tabs the same blocks, and the codegen `docker run` invocations no longer pass `-it`, which fails outside a TTY.

*****************

## Release ONDEWO CSI Js Client 5.4.0

### Improvements

* Tracking API Version [5.4.0](https://github.com/ondewo/ondewo-csi-api/releases/tag/5.4.0) ( [Documentation](https://ondewo.github.io/ondewo-csi-api/) )

*****************

## Release ONDEWO CSI Js Client 5.2.0

### Improvements

* Tracking API Version [5.2.0](https://github.com/ondewo/ondewo-csi-api/releases/tag/5.2.0) ( [Documentation](https://ondewo.github.io/ondewo-csi-api/) )

*****************

## Release ONDEWO CSI Js Client 5.1.0

### Improvements

* Tracking API Version [5.1.0](https://github.com/ondewo/ondewo-csi-api/releases/tag/5.1.0) ( [Documentation](https://ondewo.github.io/ondewo-csi-api/) )

*****************

## Release ONDEWO CSI Js Client 5.0.0

### Improvements

* Tracking API Version [5.0.0](https://github.com/ondewo/ondewo-csi-api/releases/tag/5.0.0) ( [Documentation](https://ondewo.github.io/ondewo-csi-api/) )

*****************

## Release ONDEWO CSI Js Client 3.0.0

### Improvements

* Tracking API Version [3.0.0](https://github.com/ondewo/ondewo-csi-api/releases/tag/3.0.0) ( [Documentation](https://ondewo.github.io/ondewo-csi-api/) )

*****************

## Release ONDEWO CSI Js Client 2.3.1

### Improvements

* Tracking API Version [2.3.1](https://github.com/ondewo/ondewo-csi-api/releases/tag/2.3.1) ( [Documentation](https://ondewo.github.io/ondewo-csi-api/) )
* [[OND211-2039]](https://ondewo.atlassian.net/browse/OND211-2039) - Implemented automated release for GitHub and NPM
* [[OND211-2039]](https://ondewo.atlassian.net/browse/OND211-2039) - Added pre-commit hooks and adjusted files to them

*****************

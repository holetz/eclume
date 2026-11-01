# Third-party notices

eclume is distributed under the [MIT License](LICENSE). It ships, links or downloads the
third-party components listed here, each under its own licence. This file is the result of the
licence audit of spec 256 (epic 230), done on 2026-11-01. It is a record of engineering findings,
not legal advice.

**Method.** No dependency was built or installed for the audit. Licences were read from lockfiles
and package metadata: the locally installed Python metadata for the server packages, the PyPI
release metadata at the locked version for the packages only the GPU worker installs, the
`license` field of each `package-lock.json`, and `cargo metadata --locked` for the Cargo
workspaces. Where a registry carries no licence field, the upstream repository was read and the
entry says so. Re-run the audit before each release; dependency licences drift.

Every licence family below that is not MIT requires, at distribution, that its copyright notice
and licence text accompany the binary or image. The texts are in the packages themselves (the
`LICENSE` files inside each wheel, `node_modules` package and crate) and in the upstream
repositories named in the lockfiles.

## 1. Python (uv): `uv.lock`

198 locked packages, of which 89 belong to the server environment and 109 are installed only in
the GPU worker image (`worker-gpu/Dockerfile`, `--extra gpu`: WhisperX, torch, pyannote and
their dependencies).

| Licence family (as reported) | Packages | Notes |
| --- | --- | --- |
| MIT (incl. MIT-0, MIT-CMU) | 73 | includes eclume's own workspace members, `ctranslate2`, `alembic`, `filelock`, `fonttools`, `cffi`, `pillow` |
| Apache-2.0 (incl. dual Apache/BSD and Apache AND MIT) | 47 | `asyncpg`, `boto3`, `opentelemetry-*`, `cryptography`, `aiohttp` |
| BSD-2/3-Clause | 46 | `torchvision`, `scikit-learn`, `numpy` (BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0), `whisperx` (BSD-2-Clause) |
| PSF-2.0 | 6 | `typing_extensions`, `matplotlib`, `pywin32`, `defusedxml` |
| MPL-2.0 (file-level copyleft) | 3 | `certifi`, `fqdn`, `tqdm` (MPL-2.0 AND MIT) |
| ISC | 1 | `isoduration` |
| LGPL-2.1-or-later | 1 | `zeroconf` (server): see section 8 |
| NVIDIA proprietary | 14 | `nvidia-*-cu12` wheels pulled by torch (GPU image only): see section 8 |
| No licence field on PyPI | 7 | `pyannote-audio`, `-core`, `-database`, `-metrics`, `-pipeline`, `pyannoteai-sdk`, `torchcodec`: see below |

A package with a compound expression is counted once, under the first family named.

The seven packages without a PyPI licence field were resolved against their upstream repositories:
`pyannote-audio` is MIT (Copyright (c) 2020 CNRS); the sibling `pyannote-*` and `pyannoteai-sdk`
packages are published by the same project and are to be confirmed per repository (recorded in
section 8); `torchcodec` is BSD-3-Clause (PyTorch project).

Workspace members (`eclume-server`, `eclume-worker`, `eclume-agent`, the engines) are eclume's own
code under MIT and are not third-party.

## 2. npm (web): `web/package-lock.json`

512 locked packages (runtime and development).

| Licence | Packages | Notes |
| --- | --- | --- |
| MIT | 407 | |
| ISC | 31 | |
| Apache-2.0 | 23 | |
| MPL-2.0 | 15 | runtime: `mediabunny`; the rest are development tools |
| BSD-3-Clause / BSD-2-Clause / BSD | 20 | |
| BlueOak-1.0.0 | 4 | development only |
| MIT-0, CC0-1.0, (MIT OR CC0-1.0), (MPL-2.0 OR Apache-2.0) | 5 | |
| OFL-1.1 | 2 | `@fontsource/archivo`, `@fontsource/ibm-plex-mono`: see section 6 |
| Python-2.0 / CC-BY-4.0 | 2 | development only (`argparse`, `caniuse-lite`) |
| No licence field | 2 | `decko`, `stickyfill`: development only, not shipped; confirm upstream (section 8) |
| **GPL-2.0-or-later** | 1 | `@ffmpeg/core`: runtime, shipped in the web build. **See section 8.** |

## 3. npm (mobile): `mobile/package-lock.json`

277 locked packages: 199 MIT, 33 Apache-2.0 (including `Apache-2.0 OR MIT` forms), 12 MPL-2.0
(development tools), 11 ISC, 11 BSD-2/3-Clause, 4 BlueOak-1.0.0, 2 MIT-0, 2 OFL-1.1 (the same two
`@fontsource` fonts), and 2 CC (`caniuse-lite` CC-BY-4.0 and `mdn-data` CC0-1.0, development
only). No copyleft runtime package.

## 4. npm (desktop): `desktop/package-lock.json`

12 locked packages, all `Apache-2.0 OR MIT`.

## 5. Cargo: `desktop/Cargo.lock` and `mobile/Cargo.lock`

`cargo metadata --locked` resolved 714 third-party crates for the desktop workspace and 503 for the
mobile workspace (workspace members are eclume's own code, or the vendored crates of section 6).
`cargo deny` was not installed on the audit workstation, so no automated policy was run;
`desktop/deny.toml` and `mobile/deny.toml` check advisories only.

| Licence family | Desktop | Mobile | Notes |
| --- | --- | --- | --- |
| MIT, Apache-2.0 or both (including `OR` and `/` forms) | 640 | 405 | the bulk of the graph |
| Unicode-3.0 | 18 | 18 | `icu_*` and `unicode-ident` data |
| Unlicense OR MIT | 12 | 11 | `walkdir`, `same-file`, `memchr` family |
| MPL-2.0 | 20 | 5 | desktop: `symphonia` decoders, `cssparser`, `selectors`; mobile: `cssparser`, `selectors`, `option-ext`. File-level copyleft, no modification by eclume |
| BSD-2/3-Clause (alone or in `OR`/`AND`) | 17 | 15 | `ogg`, `opusic-sys` (bundles libopus, BSD-3-Clause), `brotli`, `subtle`, `encoding_rs` |
| ISC, Zlib, BSL-1.0, CDLA-Permissive-2.0, 0BSD, CC0-1.0, MIT-0 | 20 | 15 | `ring` (Apache-2.0 AND ISC), `rustls-webpki`, `clipboard-win` (BSL-1.0), `webpki-roots` (CDLA-Permissive-2.0) |

No crate is licensed under GPL, AGPL or LGPL alone. `r-efi` lists `LGPL-2.1-or-later` only as one
alternative of an `OR` expression that also offers MIT, so the MIT option applies.

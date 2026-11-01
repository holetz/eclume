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
mobile workspace (workspace members are eclume's own code or the vendored crates of section 6, and are not counted).
`cargo deny` was not installed on the audit workstation, so no automated policy was run;
`desktop/deny.toml` and `mobile/deny.toml` check advisories only.

| Licence bucket | Desktop | Mobile | Notes |
| --- | --- | --- | --- |
| Only MIT and/or Apache-2.0 (including `OR`, `/` and LLVM-exception forms) | 595 | 418 | the bulk of the graph |
| Expression that offers MIT or Apache-2.0 beside other permissive terms (Zlib, Unlicense, 0BSD, BSD, ISC, CC0-1.0, MIT-0) | 63 | 49 | `ring` (Apache-2.0 AND ISC), `walkdir` (Unlicense/MIT), `miniz_oxide`, `brotli` |
| Unicode-3.0 | 19 | 19 | `icu_*` data and `unicode-ident` |
| MPL-2.0 | 20 | 5 | desktop: `symphonia` decoders, `cssparser`, `selectors`; mobile: `cssparser`, `selectors`, `option-ext`. File-level copyleft, unmodified by eclume |
| BSD-3-Clause | 6 | 5 | `ogg`, `opusic-sys` (bundles libopus), `subtle`, `alloc-no-stdlib` |
| ISC | 4 | 3 | `rustls-webpki`, `untrusted`, `libloading` |
| Zlib | 3 | 2 | `foldhash`, `zlib-rs` |
| BSL-1.0 | 2 | 0 | `clipboard-win`, `error-code` |
| CDLA-Permissive-2.0 | 2 | 2 | `webpki-roots`, `webpki-root-certs` |

No crate is licensed under GPL, AGPL or LGPL alone. `r-efi` lists `LGPL-2.1-or-later` only as one
alternative of an `OR` expression that also offers MIT, so the MIT option applies.

## 6. Vendored code, fonts and the noise model

### Vendored Anarlog crates (desktop)

Three crates under `desktop/crates/` are adapted from [Anarlog](https://github.com/fastrepl/anarlog)
(formerly Hyprnote), MIT, `Copyright (c) 2023-present Fastrepl, Inc.`. Each carries the full licence
text in its own `LICENSE`, and `VENDOR.md` records the pinned upstream commit and what changed.

| Crate | Upstream path | Files |
| --- | --- | --- |
| `eclume-audio-capture` | `crates/audio-capture` | `desktop/crates/audio-capture/LICENSE`, `VENDOR.md` |
| `eclume-resampler` | `crates/resampler` | `desktop/crates/resampler/LICENSE`, `VENDOR.md` |
| `eclume-detect` | `crates/detect` (adapted, not copied) | `desktop/crates/detect/LICENSE`, `VENDOR.md` |

### Fonts

`@fontsource/archivo` (Copyright 2020 The Archivo Project Authors) and `@fontsource/ibm-plex-mono`
(Copyright IBM Corp.) are licensed under the SIL Open Font License 1.1 and are bundled in the web
and mobile builds. The desktop UI ships the `woff2` files in `desktop/ui/fonts/` with the licence text
in `desktop/ui/fonts/OFL.txt`. The OFL allows bundling and redistribution with software provided the
copyright notices and licence text travel with the fonts and the fonts are not sold on their own.

### RNNoise model

`worker-gpu/Dockerfile` downloads `cb.rnnn` ("conjoined-burgers", 2018-08-28) from
[GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models), pinned by SHA-256, for the
`arnndn` pre-processing filter. The repository carries **no licence file** and GitHub detects none
(checked 2026-11-01): the model is not licensed for redistribution by an explicit grant. The RNNoise
code itself is BSD-3-Clause (Xiph.Org). The model is downloaded at image build and baked into the
image, not committed to this repository. See section 8.

### System packages in images

The worker image installs Debian `ffmpeg` with `apt-get` (decoding and the `arnndn` filter), run as
a separate process. Debian's `ffmpeg` is built with GPL-licensed components; eclume invokes it by
command line and does not link it. The images also contain the Debian base (`python:3.12-slim`),
and the compose files pull `pgvector/pgvector:pg16` (PostgreSQL licence), `redis:7-alpine`,
`pgsty/minio` and `caddy:2.11` (Apache-2.0) as separate containers. See section 8 for Redis and
MinIO.

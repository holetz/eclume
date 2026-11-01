# `project/` — this repository's manual

The operational reference of the repository itself: market solutions reused, the host runbook and
other facts about eclume as maintained code. Every page has `type: project`.

* [calibracao-voz.md](calibracao-voz.md) — how the voice-suggestion threshold was chosen: 33 real readers in diarized synthetic meetings, FPR and FNR per threshold, mode and speech, and the decision (centroid, 0.55, 10 s)
* [deploy-producao.md](deploy-producao.md) — eclume in production on the host: compose with Caddy on 8443, deploy through the Docker context, secrets, admin, CA on the clients, backup and restore
* [estacao-windows.md](estacao-windows.md) — the Windows station: SSH and the `gpu-host` context, `remote-run` without rsync, installing and signing into the app without a PAT, driving the window over CDP, log and Windows binaries cross-built on the host
* [fixtures-provenance.md](fixtures-provenance.md) — where each audio test fixture comes from, that none carries a real voice, and the licence check still open
* [host-setup.md](host-setup.md) — how to prepare the server `192.168.15.199` to receive the eclume and lumea containers
* [referencias.md](referencias.md) — market solutions evaluated and how eclume uses each one
* [worker-gpu.md](worker-gpu.md) — the GPU worker on the GTX 1660 SUPER: compute type, measured benchmark, image, model cache, Hugging Face token and operation

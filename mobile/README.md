# eclume — app móvel

O celular como microfone portátil do eclume: grava em Ogg/Opus mono 16 kHz com a tela bloqueada,
marca instantes com nota opcional e guarda as gravações longe do servidor. De volta ao Wi-Fi da
rede do servidor, sincroniza sozinho, com o mesmo upload retomável do desktop. O app não lê
transcrições.

- **Stack:** Tauri 2 mobile, Android primeiro (iOS fica para uma spec própria). A UI é React + TS
  sobre o DS do eclume; o núcleo Rust (`crates/core`) reaproveita os crates de gravação e sync do
  desktop (`../desktop/crates`).
- **Arquitetura e contratos:** [docs/standards/code/mobile-app.md](../docs/standards/code/mobile-app.md).
- **Comandos:** [docs/standards/code/monorepo.md](../docs/standards/code/monorepo.md#móvel--npm-e-workspace-cargo-em-mobile).
- **Ambiente Android no host:** `scripts/android-sdk.sh`
  ([docs/project/host-setup.md](../docs/project/host-setup.md)).

```bash
npm --prefix mobile ci
npm --prefix mobile test
remote-run . 'source ~/.config/eclume/android-env.sh && npm --prefix mobile ci && npm --prefix mobile run tauri -- android build --debug --apk --target x86_64'
```

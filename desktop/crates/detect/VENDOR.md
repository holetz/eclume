# eclume-detect — o que vem do Anarlog

- Origem: <https://github.com/fastrepl/anarlog>, `crates/detect`
- Commit fixado: `bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43`
- Licença: MIT — `Copyright (c) 2023-present Fastrepl, Inc.` (texto integral em `LICENSE`)

Este crate **não é uma cópia** do `detect`: é uma adaptação da parte que lê os sinais do SO. O
original traz `meeting_ax` (leitura da árvore de acessibilidade, ~8 mil linhas), `specta`,
`anlg-*`, um runtime tokio por detector e callbacks de eventos, que o eclume não usa. Aqui a coleta
devolve um retrato (`Snapshot`) consultado a cada segundo, e a classificação, o debounce e a
gravação automática são próprios, puros e testados com sinais mockados.

| Arquivo aqui | Origem | O que mudou |
|---|---|---|
| `src/platform/linux.rs` | `src/list/linux.rs` (`list_mic_using_apps`) | Mesma consulta de source-outputs não corked pelo mainloop padrão do Pulse, com o mesmo prazo; acrescenta a consulta das fontes para descartar quem lê um monitor (captura do áudio do sistema) e o `application.process.id` para tirar o próprio app; erros em `anyhow`. |
| `src/platform/macos.rs` | `src/list/macos.rs` (`list_mic_using_apps`) e `src/mic/macos/device.rs` (`is_mic_running`) | Mesma lista de processos Core Audio com `is_running_input` e o mesmo `DeviceIsRunningSomewhere` do dispositivo padrão, sem listeners nem resolução de bundle; o nome vem do `sysinfo` e o fallback por dispositivo acrescenta a lista de processos. |
| `src/platform/windows.rs` | — | Próprio do eclume: o original lista sessões WASAPI ativas; aqui a fonte é o `ConsentStore` do Capability Access Manager, que dá o executável sem abrir COM, mais os títulos de janela por `EnumWindows`. |
| `src/classify.rs`, `src/debounce.rs`, `src/auto.rs`, `src/platform/mod.rs` | — | Próprios do eclume. A lista de apps de reunião (`zoom`, `teams`, `teams-for-linux`, `webex`, `CiscoCollabHost`, `slack`) segue a do `src/app/linux.rs` original; `whatsapp` é acréscimo do eclume. |

Os arquivos adaptados levam no topo a linha de origem. Para atualizar, compare o arquivo de origem
num commit novo com o daqui, porte as correções e registre o SHA novo nesta página.

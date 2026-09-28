# eclume-audio-capture — o que vem do Anarlog

- Origem: <https://github.com/fastrepl/anarlog>, `crates/audio-actual`
- Commit fixado: `bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43`
- Licença: MIT — `Copyright (c) 2023-present Fastrepl, Inc.` (texto integral em `LICENSE`)

Este crate **não é uma cópia** do `audio-actual`: é uma adaptação. O grafo original puxa `aec`
(modelos ONNX de ~65 MB), `audio-sync`, `audio-device`, `rodio` e streams assíncronas, que o
eclume não usa. Foi mantida a lógica de dispositivo de cada plataforma e trocada a interface.

| Arquivo aqui | Origem | O que mudou |
|---|---|---|
| `src/system/linux.rs` | `src/speaker/linux.rs` | PipeWire seguindo o sink em uso, com fallback Pulse monitor, igual ao original; o anel assíncrono (`RingbufAsyncReader` + `AtomicWaker`) virou o `RingWriter` deste crate; downmix por média em vez de só o primeiro canal; `tracing` → `log`. Próprio do eclume: listagem dos sinks (`list_output_devices`, id = nome do nó) e captura do monitor de um sink escolhido (`target.object` no PipeWire, `<sink>.monitor` no Pulse), que cai no sink em uso se o escolhido sumiu. |
| `src/system/windows.rs` | `src/speaker/windows.rs` | WASAPI loopback seguindo o endpoint em uso, igual ao original; mesma troca de anel, downmix e log. Próprio do eclume: listagem dos endpoints ativos (id do endpoint) e loopback fixo num endpoint escolhido, sem seguir trocas; se ele sumiu, segue o em uso. |
| `src/system/macos.rs` | `src/speaker/macos.rs` | Core Audio process tap + aggregate device, igual ao original; mesma troca de anel e log. O tap global segue a saída em uso: a lista de saídas vem vazia e uma saída escolhida é ignorada com aviso. |
| `src/ring.rs` | `src/rt_ring.rs` (ideia) | Reescrito: um anel `ringbuf` com produtor no callback de áudio e leitura bloqueante com prazo. |
| `src/mic.rs` | — | Próprio do eclume: `cpal` direto no dispositivo de entrada padrão (o `mic.rs` original acopla AEC e o joiner). |

Os arquivos adaptados levam no topo a linha de origem. Para atualizar, compare o arquivo de origem
num commit novo com o daqui, porte as correções e registre o SHA novo nesta página.

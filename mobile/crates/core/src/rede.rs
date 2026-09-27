//! "Na rede do eclume": Wi-Fi não medido **e** o `GET /api/v1/server` respondendo, pela CA
//! fixada, com a mesma impressão digital. Uma máquina pura, testada sem rede: o plugin informa o
//! Wi-Fi, o núcleo roda a sonda e registra o resultado, e o estado sai daqui.
//!
//! Fora do Wi-Fi não medido, a sonda não roda e nenhum byte sai pelos dados móveis.

use std::time::Duration;

use eclume_sync::pin;
use eclume_sync::transport::Transport;
use eclume_sync::Devices;
use serde::Serialize;

use crate::config::Servidor;

/// O prazo da sonda.
pub const PRAZO_DA_SONDA: Duration = Duration::from_secs(3);
/// De quanto em quanto tempo a sonda repete com o app visível.
pub const INTERVALO_DA_SONDA_MS: i64 = 60_000;

/// O resultado de uma sonda do `/server`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sonda {
    /// Respondeu com a CA fixada.
    Ok,
    /// Não respondeu no prazo (outra rede Wi-Fi, servidor fora).
    SemResposta,
    /// Respondeu, mas a raiz não é mais a fixada (ou o TLS recusou a cadeia).
    CaMudou,
}

/// O andamento do sync, para a faixa "Sincronizando 1 de 2 · 64 % · 18 MB/s".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Andamento {
    pub i: u32,
    pub n: u32,
    pub pct: u8,
    pub bytes_s: u64,
}

/// O estado da rede, como a UI mostra.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "estado", rename_all = "snake_case")]
pub enum EstadoRede {
    /// "Fora da rede do eclume · N aguardando".
    Away,
    /// "Na rede do eclume · Sincronizar agora".
    OnNetwork,
    Syncing(Andamento),
    /// O servidor responde com outra CA: o sync para até a pessoa parear de novo.
    CaMismatch,
    /// O servidor recusou a credencial (401).
    SemCredencial,
}

/// A máquina de estados da rede.
#[derive(Clone, Debug, Default)]
pub struct Rede {
    wifi_nao_medido: bool,
    /// A última sonda (ms Unix, resultado), invalidada a cada mudança de rede.
    sonda: Option<(i64, Sonda)>,
    sincronizando: Option<Andamento>,
    sem_credencial: bool,
}

impl Rede {
    /// O plugin avisou uma mudança de rede. Devolve se o Wi-Fi não medido mudou (e a sonda deve
    /// rodar de novo).
    pub fn mudou_wifi(&mut self, nao_medido: bool) -> bool {
        let mudou = self.wifi_nao_medido != nao_medido;
        self.wifi_nao_medido = nao_medido;
        if mudou {
            self.sonda = None;
        }
        mudou
    }

    pub fn wifi_nao_medido(&self) -> bool {
        self.wifi_nao_medido
    }

    /// Se a sonda pode rodar agora: só no Wi-Fi não medido.
    pub fn pode_sondar(&self) -> bool {
        self.wifi_nao_medido && !self.sem_credencial
    }

    /// A sonda periódica: sem resultado ainda, ou vencida com o app visível.
    pub fn precisa_sondar(&self, agora_ms: i64, visivel: bool) -> bool {
        if !self.pode_sondar() {
            return false;
        }
        match self.sonda {
            None => true,
            Some((em, _)) => visivel && agora_ms - em >= INTERVALO_DA_SONDA_MS,
        }
    }

    pub fn registrar_sonda(&mut self, agora_ms: i64, sonda: Sonda) {
        self.sonda = Some((agora_ms, sonda));
    }

    pub fn perdeu_credencial(&mut self) {
        self.sem_credencial = true;
        self.sincronizando = None;
    }

    pub fn recuperou_credencial(&mut self) {
        self.sem_credencial = false;
        self.sonda = None;
    }

    pub fn sync_andando(&mut self, andamento: Andamento) {
        self.sincronizando = Some(andamento);
    }

    pub fn sync_terminou(&mut self) {
        self.sincronizando = None;
    }

    pub fn estado(&self) -> EstadoRede {
        if self.sem_credencial {
            return EstadoRede::SemCredencial;
        }
        if !self.wifi_nao_medido {
            return EstadoRede::Away;
        }
        match self.sonda {
            Some((_, Sonda::CaMudou)) => EstadoRede::CaMismatch,
            Some((_, Sonda::Ok)) => match self.sincronizando {
                Some(andamento) => EstadoRede::Syncing(andamento),
                None => EstadoRede::OnNetwork,
            },
            _ => EstadoRede::Away,
        }
    }

    /// Na rede do eclume: o sync pode subir.
    pub fn na_rede(&self) -> bool {
        matches!(
            self.estado(),
            EstadoRede::OnNetwork | EstadoRede::Syncing(_)
        )
    }
}

/// Roda a sonda: `GET /api/v1/server` pelo transporte fixado (com [`PRAZO_DA_SONDA`]) e confere
/// a impressão digital anunciada com a fixada.
pub fn sondar(transport: std::sync::Arc<dyn Transport>, servidor: &Servidor) -> Sonda {
    let info = Devices::new(transport, &servidor.url).and_then(|d| d.server_info());
    match info {
        Ok(info) => match pin::confirm(&info, &servidor.ca_sha256) {
            Ok(()) => Sonda::Ok,
            Err(_) => Sonda::CaMudou,
        },
        // Com a CA fixada, uma cadeia de outra raiz falha no TLS: é a CA que mudou, não a rede.
        Err(err) if erro_de_certificado(&err) => Sonda::CaMudou,
        Err(_) => Sonda::SemResposta,
    }
}

fn erro_de_certificado(err: &anyhow::Error) -> bool {
    let texto = format!("{err:#}").to_ascii_lowercase();
    texto.contains("unknownissuer") || texto.contains("certificate")
}

//! As estimativas e os limites da gravação: quanto tempo cabe no espaço livre, quanto a bateria
//! aguenta e quando avisar ou parar sozinho.

use serde::Serialize;

/// Abaixo disso, o Início avisa "Armazenamento quase cheio".
pub const AVISO_DE_ESPACO_S: u64 = 60 * 60;
/// Abaixo disso, gravando, o app para e salva sozinho.
pub const PARADA_POR_ESPACO_S: u64 = 5 * 60;
/// Bateria nesse nível ou abaixo, descarregando, mostra a faixa durante a gravação.
pub const AVISO_DE_BATERIA_PCT: u8 = 15;
/// A amostra mínima de queda da bateria para estimar.
pub const AMOSTRA_DE_BATERIA_MS: i64 = 10 * 60 * 1_000;

/// Segundos de gravação que cabem em `livre` bytes a `bitrate` bits/s.
pub fn segundos_que_cabem(livre: u64, bitrate: i32) -> u64 {
    let bytes_por_segundo = u64::try_from(bitrate.max(1)).unwrap_or(1) / 8;
    livre / bytes_por_segundo.max(1)
}

/// "cerca de 9 h", "cerca de 40 min", "menos de 1 min".
pub fn cerca_de(segundos: u64) -> String {
    let minutos = segundos / 60;
    if minutos < 1 {
        "menos de 1 min".into()
    } else if minutos < 60 {
        format!("cerca de {minutos} min")
    } else {
        format!("cerca de {} h", (minutos + 30) / 60)
    }
}

/// Uma leitura da bateria.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeituraDeBateria {
    pub em_ms: i64,
    pub pct: u8,
    pub carregando: bool,
}

/// A queda medida desde o início da gravação.
#[derive(Clone, Debug, Default)]
pub struct Bateria {
    inicio: Option<LeituraDeBateria>,
    ultima: Option<LeituraDeBateria>,
}

impl Bateria {
    /// Recomeça a medição (ao começar a gravar).
    pub fn recomecar(&mut self) {
        self.inicio = None;
    }

    pub fn registrar(&mut self, leitura: LeituraDeBateria) {
        // Carregar invalida a queda medida até ali.
        if leitura.carregando || self.inicio.is_none_or(|i| leitura.pct > i.pct) {
            self.inicio = (!leitura.carregando).then_some(leitura);
        }
        self.ultima = Some(leitura);
    }

    /// Minutos que a bateria ainda dá, pela queda medida; `None` antes de 10 min de amostra ou
    /// sem queda.
    pub fn minutos_restantes(&self) -> Option<u64> {
        let (inicio, ultima) = (self.inicio?, self.ultima?);
        let decorrido = ultima.em_ms - inicio.em_ms;
        let queda = inicio.pct.checked_sub(ultima.pct)?;
        if decorrido < AMOSTRA_DE_BATERIA_MS || queda == 0 || ultima.carregando {
            return None;
        }
        let ms_por_ponto = decorrido / i64::from(queda);
        u64::try_from(i64::from(ultima.pct) * ms_por_ponto / 60_000).ok()
    }

    pub fn ultima(&self) -> Option<LeituraDeBateria> {
        self.ultima
    }
}

/// Os avisos que a UI mostra.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Avisos {
    /// "Armazenamento quase cheio · Cerca de 40 min de gravação."
    pub armazenamento: Option<AvisoDeEspaco>,
    /// "Bateria em 12 %. Dá para cerca de 50 min."
    pub bateria: Option<AvisoDeBateria>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AvisoDeEspaco {
    pub restante: String,
    /// Bytes que "Excluir sincronizadas" libera.
    pub sincronizadas_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AvisoDeBateria {
    pub pct: u8,
    /// `None` antes de haver amostra para estimar.
    pub restante: Option<String>,
}

/// O aviso de espaço, se o que cabe está abaixo de uma hora.
pub fn aviso_de_espaco(
    livre: u64,
    bitrate: i32,
    sincronizadas_bytes: u64,
) -> Option<AvisoDeEspaco> {
    let segundos = segundos_que_cabem(livre, bitrate);
    (segundos < AVISO_DE_ESPACO_S).then(|| AvisoDeEspaco {
        restante: cerca_de(segundos),
        sincronizadas_bytes,
    })
}

/// O aviso de bateria, gravando: nível baixo e descarregando.
pub fn aviso_de_bateria(bateria: &Bateria) -> Option<AvisoDeBateria> {
    let ultima = bateria.ultima()?;
    (ultima.pct <= AVISO_DE_BATERIA_PCT && !ultima.carregando).then(|| AvisoDeBateria {
        pct: ultima.pct,
        restante: bateria.minutos_restantes().map(|m| cerca_de(m * 60)),
    })
}

/// Gravando, o espaço acabou: parar e salvar sozinho.
pub fn deve_parar_por_espaco(livre: u64, bitrate: i32) -> bool {
    segundos_que_cabem(livre, bitrate) < PARADA_POR_ESPACO_S
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1_000_000_000;

    #[test]
    fn horas_que_cabem_no_espaco_livre() {
        // 24 kbps = 3 000 B/s = 10,8 MB por hora.
        assert_eq!(segundos_que_cabem(108_000_000, 24_000), 36_000);
        assert_eq!(
            cerca_de(segundos_que_cabem(97_200_000, 24_000)),
            "cerca de 9 h"
        );
        assert_eq!(cerca_de(40 * 60), "cerca de 40 min");
        assert_eq!(cerca_de(30), "menos de 1 min");
    }

    #[test]
    fn avisos_e_parada_por_espaco() {
        assert_eq!(aviso_de_espaco(GB, 24_000, 0), None);
        let aviso = aviso_de_espaco(7_200_000, 24_000, 1_100_000_000).unwrap();
        assert_eq!(aviso.restante, "cerca de 40 min");
        assert_eq!(aviso.sincronizadas_bytes, 1_100_000_000);
        assert!(!deve_parar_por_espaco(7_200_000, 24_000));
        assert!(deve_parar_por_espaco(800_000, 24_000));
    }

    #[test]
    fn bateria_so_estima_com_dez_minutos_de_queda() {
        let mut bateria = Bateria::default();
        let leitura = |min: i64, pct: u8| LeituraDeBateria {
            em_ms: min * 60_000,
            pct,
            carregando: false,
        };
        bateria.registrar(leitura(0, 20));
        bateria.registrar(leitura(5, 18));
        assert_eq!(bateria.minutos_restantes(), None);
        assert_eq!(aviso_de_bateria(&bateria), None);
        // 20 → 12 % em 32 min: 4 min por ponto, 12 pontos = 48 min.
        bateria.registrar(leitura(32, 12));
        assert_eq!(bateria.minutos_restantes(), Some(48));
        let aviso = aviso_de_bateria(&bateria).unwrap();
        assert_eq!(
            (aviso.pct, aviso.restante.as_deref()),
            (12, Some("cerca de 48 min"))
        );

        // Na tomada, não há aviso nem estimativa.
        bateria.registrar(LeituraDeBateria {
            carregando: true,
            ..leitura(33, 12)
        });
        assert_eq!(aviso_de_bateria(&bateria), None);
        bateria.registrar(leitura(34, 12));
        assert_eq!(aviso_de_bateria(&bateria).unwrap().restante, None);
    }
}

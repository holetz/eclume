//! Debounce da detecção: a reunião só começa depois de alguns segundos contínuos de sinal e só
//! termina depois de um silêncio mais longo, para o mic que solta por instantes (troca de
//! dispositivo, reconexão) não abrir e fechar gravações.

use std::time::{Duration, Instant};

use eclume_recorder::{MeetingDetector, MeetingEvent};

use crate::classify::{classify, AppKey, SignalSource};

/// Quanto tempo o sinal precisa durar para começar ou faltar para terminar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DebounceConfig {
    pub start_after: Duration,
    pub end_after: Duration,
}

impl Default for DebounceConfig {
    fn default() -> Self {
        Self {
            start_after: Duration::from_secs(3),
            end_after: Duration::from_secs(15),
        }
    }
}

/// Transforma a classificação de cada instante em eventos de início e fim de reunião.
#[derive(Clone, Debug)]
pub struct Debouncer {
    config: DebounceConfig,
    /// Desde quando há detecção contínua, antes de a reunião começar.
    present_since: Option<Instant>,
    /// Desde quando falta detecção, com a reunião em curso.
    absent_since: Option<Instant>,
    active: Option<AppKey>,
}

impl Debouncer {
    pub fn new(config: DebounceConfig) -> Self {
        Self {
            config,
            present_since: None,
            absent_since: None,
            active: None,
        }
    }

    /// A reunião em curso, depois do debounce.
    pub fn active(&self) -> Option<AppKey> {
        self.active
    }

    /// Registra a classificação observada em `now`. O app anunciado no início é o da última
    /// observação; uma troca de app no meio da reunião não gera evento.
    pub fn observe(&mut self, now: Instant, detection: Option<AppKey>) -> Option<MeetingEvent> {
        match (self.active, detection) {
            (None, Some(app)) => {
                let since = *self.present_since.get_or_insert(now);
                if now.duration_since(since) < self.config.start_after {
                    return None;
                }
                self.present_since = None;
                self.active = Some(app);
                Some(MeetingEvent::Started {
                    app: app.as_str().to_string(),
                })
            }
            (None, None) => {
                self.present_since = None;
                None
            }
            (Some(_), Some(_)) => {
                self.absent_since = None;
                None
            }
            (Some(_), None) => {
                let since = *self.absent_since.get_or_insert(now);
                if now.duration_since(since) < self.config.end_after {
                    return None;
                }
                self.absent_since = None;
                self.active = None;
                Some(MeetingEvent::Ended)
            }
        }
    }
}

/// `MeetingDetector` sobre uma fonte de sinais: cada `poll` tira um retrato, classifica e passa
/// pelo debounce. O relógio é injetável para os testes.
pub struct DebouncedDetector<S> {
    source: S,
    debouncer: Debouncer,
    clock: Box<dyn FnMut() -> Instant + Send>,
}

impl<S: SignalSource> DebouncedDetector<S> {
    pub fn new(source: S, config: DebounceConfig) -> Self {
        Self::with_clock(source, config, Instant::now)
    }

    pub fn with_clock(
        source: S,
        config: DebounceConfig,
        clock: impl FnMut() -> Instant + Send + 'static,
    ) -> Self {
        Self {
            source,
            debouncer: Debouncer::new(config),
            clock: Box::new(clock),
        }
    }

    pub fn active(&self) -> Option<AppKey> {
        self.debouncer.active()
    }
}

impl<S: SignalSource> MeetingDetector for DebouncedDetector<S> {
    fn poll(&mut self) -> Option<MeetingEvent> {
        let now = (self.clock)();
        match self.source.snapshot() {
            Ok(snapshot) => self.debouncer.observe(now, classify(&snapshot)),
            // Sem sinal neste instante: não conta nem como presença nem como ausência.
            Err(err) => {
                log::warn!("falha ao ler os sinais de reunião: {err:#}");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::classify::{AudioClient, Snapshot};

    fn secs(start: Instant, s: u64) -> Instant {
        start + Duration::from_secs(s)
    }

    #[test]
    fn comeca_so_depois_do_sinal_continuo() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(DebounceConfig::default());
        assert_eq!(d.observe(t0, Some(AppKey::Teams)), None);
        assert_eq!(d.observe(secs(t0, 2), Some(AppKey::Teams)), None);
        // Um buraco zera a contagem.
        assert_eq!(d.observe(secs(t0, 2), None), None);
        assert_eq!(d.observe(secs(t0, 4), Some(AppKey::Teams)), None);
        assert_eq!(d.observe(secs(t0, 6), Some(AppKey::Teams)), None);
        assert_eq!(
            d.observe(secs(t0, 7), Some(AppKey::Teams)),
            Some(MeetingEvent::Started {
                app: "teams".into()
            })
        );
        assert_eq!(d.active(), Some(AppKey::Teams));
        assert_eq!(d.observe(secs(t0, 8), Some(AppKey::Teams)), None);
    }

    #[test]
    fn termina_so_depois_do_silencio_longo() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(DebounceConfig::default());
        d.observe(t0, Some(AppKey::Zoom));
        assert!(d.observe(secs(t0, 3), Some(AppKey::Zoom)).is_some());
        // O mic solta por 10 s e volta: a reunião continua.
        assert_eq!(d.observe(secs(t0, 10), None), None);
        assert_eq!(d.observe(secs(t0, 20), None), None);
        assert_eq!(d.observe(secs(t0, 21), Some(AppKey::Zoom)), None);
        assert_eq!(d.observe(secs(t0, 30), None), None);
        assert_eq!(d.observe(secs(t0, 44), None), None);
        assert_eq!(d.observe(secs(t0, 45), None), Some(MeetingEvent::Ended));
        assert_eq!(d.active(), None);
        assert_eq!(d.observe(secs(t0, 60), None), None);
    }

    #[test]
    fn troca_de_app_no_meio_nao_gera_evento_e_o_anuncio_e_o_ultimo() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(DebounceConfig::default());
        d.observe(t0, Some(AppKey::Navegador));
        assert_eq!(
            d.observe(secs(t0, 3), Some(AppKey::Meet)),
            Some(MeetingEvent::Started { app: "meet".into() })
        );
        assert_eq!(d.observe(secs(t0, 4), Some(AppKey::Navegador)), None);
        assert_eq!(d.active(), Some(AppKey::Meet));
    }

    struct Scripted(Vec<anyhow::Result<Snapshot>>);

    impl SignalSource for Scripted {
        fn snapshot(&mut self) -> anyhow::Result<Snapshot> {
            if self.0.is_empty() {
                Ok(Snapshot::default())
            } else {
                self.0.remove(0)
            }
        }
    }

    #[test]
    fn detector_classifica_cada_retrato_e_ignora_falha_de_leitura() {
        let teams = || {
            Ok(Snapshot {
                mic_users: vec![AudioClient::new("ms-teams", "Microsoft Teams")],
                ..Snapshot::default()
            })
        };
        let script = vec![
            teams(),
            Err(anyhow::anyhow!("pulse fora")),
            teams(),
            teams(),
        ];
        let t0 = Instant::now();
        let tick = Arc::new(Mutex::new(0_u64));
        let clock_tick = Arc::clone(&tick);
        let mut detector =
            DebouncedDetector::with_clock(Scripted(script), DebounceConfig::default(), move || {
                let mut n = clock_tick.lock().unwrap();
                let now = t0 + Duration::from_secs(*n);
                *n += 1;
                now
            });
        assert_eq!(detector.poll(), None); // t=0, começa a contar
        assert_eq!(detector.poll(), None); // t=1, falha: ignorada
        assert_eq!(detector.poll(), None); // t=2
        assert_eq!(
            detector.poll(),
            Some(MeetingEvent::Started {
                app: "teams".into()
            })
        ); // t=3
        assert_eq!(detector.active(), Some(AppKey::Teams));
    }
}

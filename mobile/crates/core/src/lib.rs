//! Núcleo do app móvel do eclume, independente do Tauri: o mesmo objeto atende a UI (pelos
//! comandos Tauri) e o sistema (pela ponte JNI do plugin Android), porque a Activity pode morrer e
//! voltar enquanto o serviço grava, e o WorkManager chama o sync sem Activity nenhuma. Arquitetura
//! em docs/standards/code/mobile-app.md.
//!
//! O [`Core`] vive num `OnceLock<Mutex<Core>>` do processo ([`iniciar`], [`global`]). O que fala
//! com a rede (a sonda, o sync, as leituras autenticadas) roda **fora** da trava: o núcleo prepara
//! o plano, a chamada corre sem ele e o resultado volta por um método curto, para a UI seguir
//! lendo o estado a cada 250 ms.

pub mod conexao;
pub mod config;
pub mod estimativas;
pub mod rede;
pub mod sessao;
pub mod sync;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use anyhow::{anyhow, Context, Result};
use eclume_recorder::session::RecorderConfig;
use eclume_recorder::{now_ms, AudioSource, Marker, Queue, QueuedRecording, Source, Status};
use eclume_sync::transport::REQUEST_TIMEOUT;
use serde::Serialize;

use crate::conexao::{Conexao, EstadoConexao, Transportes, TransportesReais};
use crate::config::{Config, Dirs, Qualidade, Servidor};
use crate::estimativas::{Avisos, Bateria, LeituraDeBateria};
use crate::rede::{EstadoRede, Rede, Sonda, PRAZO_DA_SONDA};
use crate::sessao::{EstadoSessao, Sessao};
use crate::sync::{Espera, Etapa, Medidor, NoServidor};

/// O prefixo do `client_version` e do user agent do app Android.
pub const CLIENT_PREFIX: &str = "eclume-android";

/// `eclume-android/<versão>`: o `capture.client_version` do upload e o user agent.
pub fn client_version(version: &str) -> String {
    format!("{CLIENT_PREFIX}/{version}")
}

/// Os idiomas que a folha "Gravação salva" oferece, além do padrão da conta.
const IDIOMAS: [(&str, &str); 4] = [
    ("auto", "Detectar automaticamente"),
    ("pt", "Português"),
    ("es", "Español"),
    ("en", "English"),
];

/// O nome de um idioma da lista curta (`pt-BR` vira `pt`); fora dela, o próprio código.
fn nome_do_idioma(idioma: &str) -> &str {
    let base = idioma.split('-').next().unwrap_or(idioma);
    IDIOMAS
        .iter()
        .find(|(valor, _)| *valor == base)
        .map_or(idioma, |(_, rotulo)| rotulo)
}

/// Uma opção do seletor de idioma da folha.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OpcaoDeIdioma {
    pub valor: String,
    pub rotulo: String,
}

/// A folha "Gravação salva", aberta depois de parar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Folha {
    pub id: String,
    /// Início da gravação, em ms Unix (o título sugerido).
    pub iniciada_em: i64,
    pub duracao_ms: i64,
    pub marcadores: usize,
}

/// Por que a gravação parou sem pedido; o serviço mostra o motivo na notificação "A gravação
/// parou".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MotivoDaParada {
    /// Menos de 5 min de gravação no espaço livre.
    SemEspaco,
    /// A fonte de áudio acabou (ou a gravação falhou) sozinha.
    FonteEncerrada,
}

impl MotivoDaParada {
    /// O texto curto do aviso.
    pub fn texto(self) -> &'static str {
        match self {
            Self::SemEspaco => "pouco espaço livre",
            Self::FonteEncerrada => "o microfone parou",
        }
    }
}

/// Tudo o que a UI desenha: ela é função deste estado.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EstadoApp {
    pub conexao: EstadoConexao,
    pub rede: EstadoRede,
    pub sessao: Option<EstadoSessao>,
    pub folha: Option<Folha>,
    /// Gravações que ainda não chegaram ao servidor.
    pub pendentes: u32,
    pub avisos: Avisos,
    /// "cerca de 9 h" de gravação no espaço livre.
    pub espaco_livre: Option<String>,
    pub versao: String,
}

/// Como uma gravação local aparece no "Neste celular".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Selo {
    Gravando,
    Aguardando,
    Sincronizando,
    Sincronizada,
    Interrompida,
    Falhou,
}

/// Uma gravação no celular.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GravacaoLocal {
    pub id: String,
    pub titulo: Option<String>,
    /// O título que o servidor deu à gravação (fila v5); a lista o mostra sem o título local.
    pub titulo_do_servidor: Option<String>,
    pub iniciada_em: i64,
    pub duracao_ms: Option<i64>,
    pub bytes: Option<i64>,
    pub marcadores: usize,
    pub selo: Selo,
    pub remote_id: Option<String>,
    /// O arquivo local já foi apagado (fica só no servidor).
    pub apagada: bool,
    pub tipo_de_agenda: Option<String>,
    pub ultimo_erro: Option<String>,
}

/// O detalhe de uma gravação: a linha, os marcadores, as etapas no servidor e a espera na fila (em
/// cache fora da rede).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DetalheLocal {
    pub gravacao: GravacaoLocal,
    pub caminho: Option<String>,
    pub marcadores: Vec<Marker>,
    pub etapas: Option<Vec<Etapa>>,
    pub espera: Option<Espera>,
    /// A página da gravação no eclume web (`/gravacoes/<id no servidor>`), depois de enviada.
    pub endereco_na_web: Option<String>,
}

/// As configurações que a tela Configurações edita.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Preferencias {
    pub sync_auto: bool,
    pub qualidade: Qualidade,
    pub excluir_sincronizadas: bool,
}

/// O que o sync precisa, montado sob a trava e usado fora dela.
pub struct PlanoDeSync {
    uploader: eclume_sync::HttpUploader,
    fila: Arc<Mutex<Queue>>,
    medidor: Arc<Medidor>,
    ocupado: Arc<AtomicBool>,
}

/// Uma leitura autenticada a fazer fora da trava.
pub struct PlanoDeLeitura {
    transporte: Arc<dyn eclume_sync::transport::Transport>,
    servidor: Servidor,
    token: String,
}

/// O núcleo do app.
pub struct Core {
    dirs: Dirs,
    versao: String,
    config: Config,
    conexao: Conexao,
    rede: Rede,
    sessao: Sessao,
    fila: Arc<Mutex<Queue>>,
    medidor: Arc<Medidor>,
    sincronizando: Arc<AtomicBool>,
    bateria: Bateria,
    espaco_livre: Option<u64>,
    visivel: bool,
    folha: Option<Folha>,
    etapas: HashMap<String, NoServidor>,
    /// A versão nova do `movel.json`, se houver.
    atualizacao: Option<sync::Manifesto>,
    /// O próximo `?since=` da leitura dos títulos do servidor, e quando ela rodou.
    titulos_desde: Option<String>,
    titulos_lidos_em: i64,
}

/// De quanto em quanto tempo, no máximo, os títulos do servidor são lidos no ciclo de rede.
pub const INTERVALO_DOS_TITULOS_MS: i64 = 60 * 1_000;

/// De quanto em quanto tempo o `movel.json` é lido, na rede do eclume.
pub const INTERVALO_DA_ATUALIZACAO_MS: i64 = 24 * 60 * 60 * 1_000;

impl Core {
    /// Abre o núcleo: config, fila e a recuperação do que uma queda deixou para trás.
    pub fn abrir(dirs: Dirs, versao: &str, transportes: Arc<dyn Transportes>) -> Result<Self> {
        std::fs::create_dir_all(&dirs.dados)
            .with_context(|| format!("falha ao criar {}", dirs.dados.display()))?;
        let config = Config::carregar(&dirs.config())?;
        let fila = Arc::new(Mutex::new(Queue::open(&dirs.fila())?));
        Sessao::recuperar(&fila)?;
        Ok(Self {
            conexao: Conexao::new(dirs.clone(), transportes),
            dirs,
            versao: versao.to_string(),
            config,
            rede: Rede::default(),
            sessao: Sessao::default(),
            fila,
            medidor: Arc::new(Medidor::default()),
            sincronizando: Arc::new(AtomicBool::new(false)),
            bateria: Bateria::default(),
            espaco_livre: None,
            visivel: true,
            folha: None,
            etapas: HashMap::new(),
            atualizacao: None,
            titulos_desde: None,
            titulos_lidos_em: 0,
        })
    }

    pub fn dirs(&self) -> &Dirs {
        &self.dirs
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn fila(&self) -> &Arc<Mutex<Queue>> {
        &self.fila
    }

    fn trancar_fila(&self) -> Result<MutexGuard<'_, Queue>> {
        self.fila
            .lock()
            .map_err(|_| anyhow!("a fila ficou envenenada por um pânico"))
    }

    /// O nome do aparelho (`Build.MODEL`), vindo do plugin na abertura.
    pub fn definir_aparelho(&mut self, nome: &str) -> Result<()> {
        let nome = nome.trim();
        if !nome.is_empty() && self.config.device_name != nome {
            self.config.device_name = nome.to_string();
            self.salvar_config()?;
        }
        Ok(())
    }

    fn salvar_config(&self) -> Result<()> {
        self.config.salvar(&self.dirs.config())
    }

    fn bitrate(&self) -> i32 {
        self.config.qualidade.bitrate()
    }

    pub fn estado(&self) -> Result<EstadoApp> {
        let mut rede = self.rede.clone();
        if self.sincronizando.load(Ordering::Acquire) {
            rede.sync_andando(self.medidor.andamento());
        }
        let pendentes = self.trancar_fila()?.counts()?.unsynced();
        let sincronizadas = if self.espaco_livre.is_some() {
            sync::bytes_sincronizados(&self.fila)?
        } else {
            0
        };
        let bitrate = self.bitrate();
        Ok(EstadoApp {
            conexao: self.conexao.estado(&self.config),
            rede: rede.estado(),
            sessao: self.sessao.estado(&self.fila)?,
            folha: self.folha.clone(),
            pendentes,
            avisos: Avisos {
                armazenamento: self
                    .espaco_livre
                    .and_then(|livre| estimativas::aviso_de_espaco(livre, bitrate, sincronizadas)),
                bateria: if self.sessao.gravando() {
                    estimativas::aviso_de_bateria(&self.bateria)
                } else {
                    None
                },
            },
            espaco_livre: self.espaco_livre.map(|livre| {
                estimativas::cerca_de(estimativas::segundos_que_cabem(livre, bitrate))
            }),
            versao: self.versao.clone(),
        })
    }

    // --- conexão --------------------------------------------------------------------------------

    pub fn conectar_descoberto(&mut self, url: &str, ca: Option<&str>) -> Result<()> {
        self.conexao.conectar_descoberto(url, ca)
    }

    pub fn conectar_endereco(&mut self, endereco: &str) -> Result<()> {
        self.conexao.conectar_endereco(endereco)
    }

    pub fn confiar_ca(&mut self) -> Result<()> {
        if self.conexao.confiar_ca(&mut self.config)? {
            self.rede.recuperou_credencial();
        }
        Ok(())
    }

    pub fn cancelar_ca(&mut self) {
        self.conexao.cancelar_ca();
    }

    pub fn entrar(&mut self, email: &str, senha: &str) -> Result<()> {
        self.conexao.entrar(&self.config, email, senha)?;
        self.rede.recuperou_credencial();
        Ok(())
    }

    pub fn parear(&mut self, texto_do_qr: &str) -> Result<()> {
        if self.conexao.parear(&mut self.config, texto_do_qr)? {
            self.rede.recuperou_credencial();
        }
        Ok(())
    }

    /// "Sair e esquecer o servidor". As gravações aguardando ficam e sobem no próximo servidor.
    pub fn sair(&mut self) -> Result<()> {
        self.conexao.sair(&mut self.config)?;
        let wifi = self.rede.wifi_nao_medido();
        self.rede = Rede::default();
        self.rede.mudou_wifi(wifi);
        self.etapas.clear();
        Ok(())
    }

    // --- rede e sync ----------------------------------------------------------------------------

    /// O plugin avisou o Wi-Fi não medido (o callback do sistema, na hora, ou a leitura do
    /// aparelho). Sem ele, o sync em curso para na próxima requisição. Devolve se a sonda deve
    /// rodar de novo.
    pub fn mudou_rede(&mut self, wifi_nao_medido: bool) -> bool {
        if !wifi_nao_medido {
            self.medidor.interromper();
        }
        let mudou = self.rede.mudou_wifi(wifi_nao_medido);
        if mudou {
            log::info!("Wi-Fi não medido: {wifi_nao_medido}");
        }
        mudou
    }

    /// Se a UI está visível (o laço do app desacelera com ela escondida).
    pub fn visivel(&self) -> bool {
        self.visivel
    }

    /// O microfone e o silêncio da gravação em curso, sem ler a fila (ver [`Sessao::sinais`]).
    pub fn sinais_da_sessao(&self) -> Option<(crate::sessao::EstadoMicrofone, bool)> {
        self.sessao.sinais()
    }

    pub fn definir_visivel(&mut self, visivel: bool) {
        self.visivel = visivel;
    }

    /// O servidor pareado, o token e o transporte fixado com o prazo dado; `None` sem conexão.
    fn leitura(&self, prazo: std::time::Duration) -> Result<Option<PlanoDeLeitura>> {
        let (Some(servidor), Some(token)) = (self.config.servidor.clone(), self.conexao.token()?)
        else {
            return Ok(None);
        };
        Ok(Some(PlanoDeLeitura {
            transporte: self.conexao.transporte(prazo)?,
            servidor,
            token,
        }))
    }

    /// A sonda a rodar (`forcar`: abrir o app, mudar de rede, parar, "Sincronizar agora").
    pub fn preparar_sonda(&self, agora_ms: i64, forcar: bool) -> Result<Option<PlanoDeLeitura>> {
        let deve = if forcar {
            self.rede.pode_sondar()
        } else {
            self.rede.precisa_sondar(agora_ms, self.visivel)
        };
        if !deve {
            return Ok(None);
        }
        self.leitura(PRAZO_DA_SONDA)
    }

    pub fn registrar_sonda(&mut self, agora_ms: i64, sonda: Sonda) {
        let antes = self.rede.estado();
        self.rede.registrar_sonda(agora_ms, sonda);
        if self.rede.estado() != antes {
            log::info!("sonda {sonda:?}: rede {:?}", self.rede.estado());
        }
    }

    /// O sistema parou o trabalho de sync (o `onStopped` do worker): o upload para na próxima
    /// requisição e a gravação volta à fila sem gastar tentativa.
    pub fn interromper_sync(&self) {
        self.medidor.interromper();
    }

    /// As gravações aguardando o sync e quantos bytes elas somam.
    pub fn pendentes(&self) -> Result<(u32, u64)> {
        let fila = self.trancar_fila()?;
        fila.retry_due(now_ms(), sync::MAX_TENTATIVAS)?;
        let pendentes = fila.by_status(Status::Pending)?;
        let bytes = pendentes
            .iter()
            .filter_map(|rec| rec.bytes)
            .map(|b| u64::try_from(b).unwrap_or(0))
            .sum();
        Ok((u32::try_from(pendentes.len()).unwrap_or(u32::MAX), bytes))
    }

    /// O sync a rodar: na rede do eclume, sem outro em curso, com algo pendente e (sem `agora`)
    /// com o sync automático ligado. Na rede, a interrupção anterior deixa de valer.
    pub fn preparar_sync(&self, agora: bool) -> Result<Option<PlanoDeSync>> {
        if !self.rede.na_rede()
            || (!agora && !self.config.sync_auto)
            || self.sincronizando.load(Ordering::Acquire)
        {
            return Ok(None);
        }
        {
            let fila = self.trancar_fila()?;
            if agora {
                // "Sincronizar agora" não espera o backoff das falhas.
                fila.retry_failed(sync::MAX_TENTATIVAS)?;
            }
            fila.retry_due(now_ms(), sync::MAX_TENTATIVAS)?;
            if fila.counts()?.pending == 0 {
                return Ok(None);
            }
        }
        let Some(leitura) = self.leitura(REQUEST_TIMEOUT)? else {
            return Ok(None);
        };
        let uploader = sync::uploader(
            leitura.transporte,
            Arc::clone(&self.medidor),
            &leitura.servidor,
            &leitura.token,
            Arc::clone(&self.fila),
            &client_version(&self.versao),
            &self.config.device_name,
        )?;
        self.sincronizando.store(true, Ordering::Release);
        // Sob a trava do núcleo: um "saiu da rede" depois daqui interrompe esta passada.
        self.medidor.retomar();
        Ok(Some(PlanoDeSync {
            uploader,
            fila: Arc::clone(&self.fila),
            medidor: Arc::clone(&self.medidor),
            ocupado: Arc::clone(&self.sincronizando),
        }))
    }

    /// Depois do sync: o 401 leva a Entrar, e a retenção apaga o que venceu.
    pub fn concluir_sync(&mut self, credencial_recusada: bool) -> Result<()> {
        if credencial_recusada {
            self.perdeu_credencial()?;
        }
        if self.config.excluir_sincronizadas {
            sync::reter(&self.fila, now_ms(), self.config.reter_dias)?;
        }
        Ok(())
    }

    /// O servidor recusou a credencial (401 em qualquer chamada autenticada): volta a Entrar.
    pub fn perdeu_credencial(&mut self) -> Result<()> {
        self.conexao.perdeu_credencial()?;
        self.rede.perdeu_credencial();
        Ok(())
    }

    pub fn preparar_tipos(&self) -> Result<Option<PlanoDeLeitura>> {
        if !self.rede.na_rede() {
            return Ok(None);
        }
        self.leitura(REQUEST_TIMEOUT)
    }

    pub fn guardar_idioma_da_conta(&mut self, idioma: String) -> Result<()> {
        if self.config.idioma_da_conta.as_deref() != Some(idioma.as_str()) {
            self.config.idioma_da_conta = Some(idioma);
            self.salvar_config()?;
        }
        Ok(())
    }

    /// As opções de idioma da folha "Gravação salva": o padrão da conta nomeado, Detectar e a
    /// lista curta. O valor vazio é o padrão (a gravação sobe sem idioma e vale o da conta).
    pub fn opcoes_de_idioma(&self) -> Vec<OpcaoDeIdioma> {
        let padrao = match self.config.idioma_da_conta.as_deref() {
            Some(idioma) => format!("Padrão da conta: {}", nome_do_idioma(idioma)),
            None => "Padrão da conta".to_string(),
        };
        std::iter::once(OpcaoDeIdioma {
            valor: String::new(),
            rotulo: padrao,
        })
        .chain(IDIOMAS.iter().map(|(valor, rotulo)| OpcaoDeIdioma {
            valor: (*valor).to_string(),
            rotulo: (*rotulo).to_string(),
        }))
        .collect()
    }

    pub fn guardar_tipos(&mut self, tipos: Vec<config::TipoDeAgenda>) -> Result<()> {
        if self.config.tipos_de_agenda != tipos {
            self.config.tipos_de_agenda = tipos;
            self.salvar_config()?;
        }
        Ok(())
    }

    // --- sessão ---------------------------------------------------------------------------------

    /// Começa a gravar a fonte dada (o microfone).
    pub fn gravar(&mut self, fonte: Box<dyn AudioSource>) -> Result<String> {
        let config = RecorderConfig {
            bitrate: self.bitrate(),
            source: Source::Mobile,
            ask_details: true,
            ..RecorderConfig::new(self.dirs.gravacoes())
        };
        self.bateria.recomecar();
        if let Some(leitura) = self.bateria.ultima() {
            self.bateria.registrar(LeituraDeBateria {
                em_ms: now_ms(),
                ..leitura
            });
        }
        let id = self.sessao.gravar(&config, &self.fila, fonte)?;
        self.folha = None;
        Ok(id)
    }

    pub fn pausar(&self) -> Result<()> {
        self.sessao.pausar()
    }

    pub fn continuar(&self) -> Result<()> {
        self.sessao.continuar()
    }

    pub fn marcar(&self, nota: Option<&str>) -> Result<Marker> {
        self.sessao.marcar(&self.fila, nota)
    }

    /// Vigia o microfone da gravação em curso (marcadores de queda e volta); o laço do app chama.
    pub fn vigiar(&mut self) -> Result<()> {
        self.sessao.vigiar(&self.fila)
    }

    /// O sistema silenciou (`true`) ou devolveu a captura, pelo `AudioRecordingCallback`.
    pub fn silenciar(&mut self, silenciada: bool) -> Result<()> {
        self.sessao.silenciar(&self.fila, silenciada)
    }

    pub fn anotar_marcador(&self, client_id: &str, nota: Option<&str>) -> Result<Marker> {
        Sessao::anotar(&self.fila, client_id, nota)
    }

    /// Para e abre a folha "Gravação salva".
    pub fn parar(&mut self) -> Result<QueuedRecording> {
        let gravacao = self.sessao.parar(&self.fila)?;
        let marcadores = self.trancar_fila()?.markers(&gravacao.id)?.len();
        self.folha = Some(Folha {
            id: gravacao.id.clone(),
            iniciada_em: gravacao.started_at,
            duracao_ms: gravacao.duration_ms.unwrap_or(0),
            marcadores,
        });
        Ok(gravacao)
    }

    /// O Android recusou o serviço em primeiro plano: para a gravação recém-aberta e a tira do
    /// celular (fila e disco), sem folha "Gravação salva", para não sobrar gravação desprotegida.
    pub fn desfazer_gravacao(&mut self) -> Result<()> {
        let gravacao = self.sessao.parar(&self.fila)?;
        self.folha = None;
        self.trancar_fila()?.discard(&gravacao.id)?;
        match std::fs::remove_file(&gravacao.path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => log::warn!("falha ao apagar {}: {err}", gravacao.path.display()),
        }
        Ok(())
    }

    /// "Salvar" ou "Pular" na folha.
    pub fn salvar(
        &mut self,
        id: &str,
        titulo: Option<&str>,
        tipo: Option<&str>,
        idioma: Option<&str>,
    ) -> Result<()> {
        Sessao::salvar(&self.fila, id, titulo, tipo, idioma)?;
        if self.folha.as_ref().is_some_and(|f| f.id == id) {
            self.folha = None;
        }
        Ok(())
    }

    /// A leitura periódica do aparelho (bateria e espaço livre).
    pub fn atualizar_aparelho(&mut self, pct: u8, carregando: bool, espaco_livre: u64) {
        self.bateria.registrar(LeituraDeBateria {
            em_ms: now_ms(),
            pct,
            carregando,
        });
        self.espaco_livre = Some(espaco_livre);
    }

    /// Os limites da gravação: fecha a que terminou sozinha e para a que ficou sem espaço.
    /// Devolve a gravação fechada e o motivo, para o chamador avisar.
    pub fn verificar_limites(&mut self) -> Result<Option<(QueuedRecording, MotivoDaParada)>> {
        if !self.sessao.gravando() {
            return Ok(None);
        }
        let motivo = if self
            .espaco_livre
            .is_some_and(|livre| estimativas::deve_parar_por_espaco(livre, self.bitrate()))
        {
            MotivoDaParada::SemEspaco
        } else if self.sessao.terminou_sozinha() {
            MotivoDaParada::FonteEncerrada
        } else {
            return Ok(None);
        };
        self.parar().map(|gravacao| Some((gravacao, motivo)))
    }

    // --- gravações locais -----------------------------------------------------------------------

    fn local(&self, fila: &Queue, rec: &QueuedRecording) -> Result<GravacaoLocal> {
        let selo = match rec.status {
            Status::Recording => Selo::Gravando,
            Status::Syncing => Selo::Sincronizando,
            Status::Synced => Selo::Sincronizada,
            Status::Failed => Selo::Falhou,
            Status::Pending if rec.interrupted => Selo::Interrompida,
            Status::Pending => Selo::Aguardando,
        };
        let tipo = rec.agenda_type_id.as_ref().and_then(|id| {
            self.config
                .tipos_de_agenda
                .iter()
                .find(|t| &t.id == id)
                .map(|t| t.nome.clone())
        });
        Ok(GravacaoLocal {
            id: rec.id.clone(),
            titulo: rec.title.clone(),
            titulo_do_servidor: rec.server_title.clone(),
            iniciada_em: rec.started_at,
            duracao_ms: rec.duration_ms,
            bytes: rec.bytes,
            marcadores: fila.markers(&rec.id)?.len(),
            selo,
            remote_id: rec.remote_id.clone(),
            apagada: rec.purged_at.is_some(),
            tipo_de_agenda: tipo,
            ultimo_erro: rec.last_error.clone(),
        })
    }

    /// "Neste celular": as gravações mais recentes primeiro.
    pub fn gravacoes(&self) -> Result<Vec<GravacaoLocal>> {
        let fila = self.trancar_fila()?;
        fila.list(200)?
            .iter()
            .map(|rec| self.local(&fila, rec))
            .collect()
    }

    pub fn gravacao(&self, id: &str) -> Result<DetalheLocal> {
        let fila = self.trancar_fila()?;
        let rec = fila
            .get(id)?
            .with_context(|| format!("gravação {id} não está no celular"))?;
        Ok(DetalheLocal {
            gravacao: self.local(&fila, &rec)?,
            caminho: (rec.purged_at.is_none() && rec.status != Status::Recording)
                .then(|| rec.path.to_string_lossy().into_owned()),
            marcadores: fila.markers(id)?,
            etapas: self.etapas.get(id).map(|no| no.etapas.clone()),
            espera: self.etapas.get(id).and_then(|no| no.espera.clone()),
            endereco_na_web: self.endereco_na_web(rec.remote_id.as_deref()),
        })
    }

    /// A página da gravação no eclume web, pelo endereço do servidor pareado.
    fn endereco_na_web(&self, remote_id: Option<&str>) -> Option<String> {
        let servidor = self.config.servidor.as_ref()?;
        Some(format!(
            "{}/gravacoes/{}",
            servidor.url.trim_end_matches('/'),
            remote_id?
        ))
    }

    /// A leitura das etapas de uma gravação sincronizada, na rede do eclume.
    pub fn preparar_etapas(&self, id: &str) -> Result<Option<(PlanoDeLeitura, String)>> {
        if !self.rede.na_rede() {
            return Ok(None);
        }
        let remoto = self.trancar_fila()?.get(id)?.and_then(|rec| rec.remote_id);
        let (Some(remoto), Some(plano)) = (remoto, self.leitura(REQUEST_TIMEOUT)?) else {
            return Ok(None);
        };
        Ok(Some((plano, remoto)))
    }

    pub fn guardar_etapas(&mut self, id: &str, etapas: NoServidor) -> Result<()> {
        if let Some(titulo) = &etapas.titulo {
            let fila = self.trancar_fila()?;
            if let Some(remoto) = fila.get(id)?.and_then(|rec| rec.remote_id) {
                fila.set_server_title(&remoto, titulo)?;
            }
        }
        self.etapas.insert(id.to_string(), etapas);
        Ok(())
    }

    /// A leitura dos títulos do servidor, na rede do eclume e no máximo a cada
    /// [`INTERVALO_DOS_TITULOS_MS`]. A primeira parte da enviada mais antiga ainda sem título (sem
    /// nenhuma, de agora); as seguintes, do `since` da anterior.
    pub fn preparar_titulos(&mut self, agora_ms: i64) -> Result<Option<(PlanoDeLeitura, String)>> {
        if !self.rede.na_rede() || agora_ms - self.titulos_lidos_em < INTERVALO_DOS_TITULOS_MS {
            return Ok(None);
        }
        let desde = match &self.titulos_desde {
            Some(desde) => desde.clone(),
            None => {
                let sem_titulo = self
                    .trancar_fila()?
                    .by_status(Status::Synced)?
                    .into_iter()
                    .filter(|rec| rec.server_title.is_none())
                    .filter_map(|rec| rec.synced_at)
                    .min();
                let inicio = sem_titulo.unwrap_or(agora_ms) - INTERVALO_DOS_TITULOS_MS;
                eclume_sync::api::rfc3339_from_ms(inicio).context("instante inválido")?
            }
        };
        let Some(plano) = self.leitura(REQUEST_TIMEOUT)? else {
            return Ok(None);
        };
        self.titulos_lidos_em = agora_ms;
        Ok(Some((plano, desde)))
    }

    /// Guarda os títulos lidos nas linhas enviadas daqui e o próximo `since`.
    pub fn guardar_titulos(&mut self, titulos: sync::Titulos, desde: String) -> Result<()> {
        let fila = self.trancar_fila()?;
        for (remoto, titulo) in &titulos.pares {
            fila.set_server_title(remoto, titulo)?;
        }
        drop(fila);
        self.titulos_desde = Some(titulos.proximo.unwrap_or(desde));
        Ok(())
    }

    /// "Excluir deste celular": só uma gravação que o servidor já confirmou.
    pub fn excluir_local(&self, id: &str) -> Result<()> {
        let fila = self.trancar_fila()?;
        let rec = fila
            .get(id)?
            .with_context(|| format!("gravação {id} não está no celular"))?;
        if rec.status != Status::Synced {
            anyhow::bail!("Só dá para excluir do celular depois de sincronizar");
        }
        if rec.purged_at.is_none() {
            sync::apagar_arquivo(&rec.path)?;
            fila.mark_purged(id, now_ms())?;
        }
        Ok(())
    }

    /// "Excluir sincronizadas": devolve os bytes liberados.
    pub fn excluir_sincronizadas(&self) -> Result<u64> {
        sync::excluir_sincronizadas(&self.fila).map(|(_, bytes)| bytes)
    }

    // --- atualização ---------------------------------------------------------------------------

    /// A leitura do `movel.json`: na rede do eclume, uma vez por dia (ou já, com `forcar`).
    pub fn preparar_atualizacao(&self, forcar: bool) -> Result<Option<PlanoDeLeitura>> {
        let vencida = self
            .config
            .atualizacao_verificada_em
            .is_none_or(|em| now_ms() - em >= INTERVALO_DA_ATUALIZACAO_MS);
        if !self.rede.na_rede() || !(forcar || vencida) {
            return Ok(None);
        }
        self.leitura(REQUEST_TIMEOUT)
    }

    /// Guarda o manifesto lido: só uma versão maior que a instalada vira atualização.
    pub fn guardar_manifesto(&mut self, manifesto: Option<sync::Manifesto>) -> Result<()> {
        self.atualizacao = manifesto.filter(|m| sync::mais_nova(&m.versao, &self.versao));
        self.config.atualizacao_verificada_em = Some(now_ms());
        self.salvar_config()
    }

    pub fn atualizacao(&self) -> Option<&sync::Manifesto> {
        self.atualizacao.as_ref()
    }

    /// Onde o APK baixado fica: o cache do app (`<dados do app>/cache`), que o `FileProvider`
    /// do Android expõe ao instalador.
    fn pasta_do_apk(&self) -> std::path::PathBuf {
        self.dirs
            .dados
            .parent()
            .unwrap_or(&self.dirs.dados)
            .join("cache")
    }

    /// O download da atualização a fazer fora da trava.
    pub fn preparar_download(&self) -> Result<PlanoDeDownload> {
        let manifesto = self
            .atualizacao
            .clone()
            .context("Nenhuma versão nova para baixar")?;
        let servidor = self
            .config
            .servidor
            .clone()
            .context("nenhum servidor pareado")?;
        Ok(PlanoDeDownload {
            transporte: self.conexao.baixador()?,
            servidor,
            manifesto,
            destino: self.pasta_do_apk(),
        })
    }

    // --- configurações --------------------------------------------------------------------------

    pub fn preferencias(&self) -> Preferencias {
        Preferencias {
            sync_auto: self.config.sync_auto,
            qualidade: self.config.qualidade,
            excluir_sincronizadas: self.config.excluir_sincronizadas,
        }
    }

    pub fn salvar_preferencias(&mut self, preferencias: &Preferencias) -> Result<()> {
        self.config.sync_auto = preferencias.sync_auto;
        self.config.qualidade = preferencias.qualidade;
        self.config.excluir_sincronizadas = preferencias.excluir_sincronizadas;
        self.salvar_config()
    }

    /// Bytes das gravações ainda no celular.
    pub fn uso_local(&self) -> Result<u64> {
        Ok(self
            .trancar_fila()?
            .list(10_000)?
            .iter()
            .filter(|rec| rec.purged_at.is_none())
            .filter_map(|rec| rec.bytes.and_then(|b| u64::try_from(b).ok()))
            .sum())
    }
}

impl PlanoDeLeitura {
    pub fn sondar(self) -> Sonda {
        rede::sondar(self.transporte, &self.servidor)
    }

    pub fn tipos(&self) -> Result<Vec<config::TipoDeAgenda>> {
        sync::buscar_tipos_de_agenda(self.transporte.as_ref(), &self.servidor, &self.token)
    }

    pub fn idioma_da_conta(&self) -> Result<String> {
        sync::buscar_idioma_da_conta(self.transporte.as_ref(), &self.servidor, &self.token)
    }

    pub fn titulos(&self, desde: &str) -> Result<sync::Titulos> {
        sync::buscar_titulos(self.transporte.as_ref(), &self.servidor, &self.token, desde)
    }

    pub fn etapas(&self, remote_id: &str) -> Result<NoServidor> {
        sync::buscar_etapas(
            self.transporte.as_ref(),
            &self.servidor,
            &self.token,
            remote_id,
        )
    }
}

/// O download do APK, montado sob a trava e feito fora dela.
pub struct PlanoDeDownload {
    transporte: Arc<dyn eclume_sync::transport::Transport>,
    servidor: Servidor,
    manifesto: sync::Manifesto,
    destino: std::path::PathBuf,
}

impl PlanoDeDownload {
    /// Baixa e confere o APK; devolve o caminho dele.
    pub fn executar(&self) -> Result<std::path::PathBuf> {
        sync::baixar_apk(
            self.transporte.as_ref(),
            &self.servidor,
            &self.manifesto,
            &self.destino,
        )
    }
}

impl PlanoDeSync {
    /// Roda o sync (bloqueia) e devolve se o servidor recusou a credencial.
    pub fn executar(self) -> Result<(eclume_recorder::SyncReport, bool)> {
        let resultado = sync::sincronizar(&self.fila, &self.uploader, &self.medidor);
        self.ocupado.store(false, Ordering::Release);
        Ok((resultado?, self.medidor.credencial_recusada()))
    }
}

// --- o núcleo do processo --------------------------------------------------------------------

static NUCLEO: OnceLock<Mutex<Core>> = OnceLock::new();
/// Serializa a abertura: a tela e o WorkManager abrindo juntos rodariam a recuperação duas vezes.
static ABRINDO: Mutex<()> = Mutex::new(());

/// Abre o núcleo do processo na primeira chamada; as seguintes devolvem o mesmo (a Activity que
/// volta, o WorkManager).
pub fn iniciar(dirs: Dirs, versao: &str) -> Result<&'static Mutex<Core>> {
    if let Some(nucleo) = NUCLEO.get() {
        return Ok(nucleo);
    }
    let _vez = ABRINDO
        .lock()
        .unwrap_or_else(|envenenada| envenenada.into_inner());
    if let Some(nucleo) = NUCLEO.get() {
        return Ok(nucleo);
    }
    let transportes = Arc::new(TransportesReais {
        user_agent: client_version(versao),
    });
    let core = Core::abrir(dirs, versao, transportes)?;
    Ok(NUCLEO.get_or_init(|| Mutex::new(core)))
}

/// O núcleo, se já foi aberto.
pub fn global() -> Option<&'static Mutex<Core>> {
    NUCLEO.get()
}

/// Trava o núcleo.
pub fn trancar(nucleo: &Mutex<Core>) -> Result<MutexGuard<'_, Core>> {
    nucleo
        .lock()
        .map_err(|_| anyhow!("o núcleo ficou envenenado por um pânico"))
}

/// O resultado de [`sondar`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sondagem {
    /// A sonda rodou agora (e não só o resultado anterior valeu).
    pub rodou: bool,
    pub na_rede: bool,
}

/// Roda a sonda (se cabe) fora da trava e registra o resultado.
pub fn sondar(nucleo: &Mutex<Core>, forcar: bool) -> Result<Sondagem> {
    let agora = now_ms();
    let plano = trancar(nucleo)?.preparar_sonda(agora, forcar)?;
    let rodou = plano.is_some();
    if let Some(plano) = plano {
        let sonda = plano.sondar();
        trancar(nucleo)?.registrar_sonda(agora, sonda);
    }
    Ok(Sondagem {
        rodou,
        na_rede: trancar(nucleo)?.rede.na_rede(),
    })
}

/// O que o `SyncWorker` precisa saber antes de subir: se está na rede do eclume e o que aguarda.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SondagemDoWorker {
    pub na_rede: bool,
    pub pendentes: u32,
    pub bytes: u64,
}

/// O resultado do ciclo do worker: o relatório do sync e se ele foi interrompido no meio.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RelatorioDoWorker {
    pub relatorio: eclume_recorder::SyncReport,
    pub interrompido: bool,
}

/// A sonda do `SyncWorker`, antes de decidir o primeiro plano: parte da rede não medida que o
/// WorkManager garante (o processo aberto só para ele não tem a tela que avisaria o Wi-Fi).
pub fn sondar_do_worker(nucleo: &Mutex<Core>) -> Result<SondagemDoWorker> {
    trancar(nucleo)?.mudou_rede(true);
    let na_rede = sondar(nucleo, false)?.na_rede;
    let (pendentes, bytes) = trancar(nucleo)?.pendentes()?;
    Ok(SondagemDoWorker {
        na_rede,
        pendentes,
        bytes,
    })
}

/// O ciclo do `SyncWorker`. O WorkManager só o roda em rede não medida (`UNMETERED`), e o processo
/// aberto só para ele não tem a tela que avisaria o Wi-Fi: sem isso, a sonda nunca rodaria.
pub fn ciclo_do_worker(nucleo: &Mutex<Core>) -> Result<Option<RelatorioDoWorker>> {
    trancar(nucleo)?.mudou_rede(true);
    let relatorio = ciclo(nucleo, false)?;
    let interrompido = trancar(nucleo)?.medidor.interrompido();
    Ok(relatorio.map(|relatorio| RelatorioDoWorker {
        relatorio,
        interrompido,
    }))
}

/// Um ciclo: sonda, atualiza os tipos de agenda e sincroniza (`agora`: "Sincronizar agora", que
/// sobe mesmo com o sync automático desligado). Bloqueia até o sync terminar.
pub fn ciclo(nucleo: &Mutex<Core>, agora: bool) -> Result<Option<eclume_recorder::SyncReport>> {
    let sondagem = sondar(nucleo, agora)?;
    if !sondagem.na_rede {
        return Ok(None);
    }
    // Os tipos de agenda mudam pouco: só são lidos quando a sonda roda.
    if sondagem.rodou {
        // O plano sai da trava antes da rede: no `if let` (edição 2021), o guard temporário
        // viveria o bloco inteiro, e a trava de novo lá dentro travaria para sempre.
        let plano = trancar(nucleo)?.preparar_tipos()?;
        if let Some(plano) = plano {
            match plano.tipos() {
                Ok(tipos) => trancar(nucleo)?.guardar_tipos(tipos)?,
                Err(err) => leitura_falhou(nucleo, &err)?,
            }
            // Servidor anterior à 2.20.0 não tem a rota: a folha fica com "Padrão da conta".
            match plano.idioma_da_conta() {
                Ok(idioma) => trancar(nucleo)?.guardar_idioma_da_conta(idioma)?,
                Err(err) => log::warn!("{err:#}"),
            }
        }
    }
    if let Err(err) = verificar_atualizacao(nucleo, false) {
        log::warn!("{err:#}");
    }
    let plano = trancar(nucleo)?.preparar_sync(agora)?;
    let relatorio = match plano {
        Some(plano) => {
            let (relatorio, recusada) = plano.executar()?;
            trancar(nucleo)?.concluir_sync(recusada)?;
            Some(relatorio)
        }
        None => None,
    };
    atualizar_titulos(nucleo)?;
    Ok(relatorio)
}

/// Lê os títulos do servidor (fora da trava) e os guarda na fila: a lista e o detalhe mostram o
/// título do servidor da gravação já processada.
pub fn atualizar_titulos(nucleo: &Mutex<Core>) -> Result<()> {
    let plano = trancar(nucleo)?.preparar_titulos(now_ms())?;
    if let Some((plano, desde)) = plano {
        match plano.titulos(&desde) {
            Ok(titulos) => trancar(nucleo)?.guardar_titulos(titulos, desde)?,
            Err(err) => leitura_falhou(nucleo, &err)?,
        }
    }
    Ok(())
}

/// Uma leitura autenticada que falhou: com 401, a credencial caiu; o resto só vai ao log.
fn leitura_falhou(nucleo: &Mutex<Core>, err: &anyhow::Error) -> Result<()> {
    log::warn!("{err:#}");
    if sync::recusou_credencial(err) {
        trancar(nucleo)?.perdeu_credencial()?;
    }
    Ok(())
}

/// Lê o `movel.json` (uma vez por dia, ou já com `forcar`) e devolve a versão nova, se houver.
pub fn verificar_atualizacao(
    nucleo: &Mutex<Core>,
    forcar: bool,
) -> Result<Option<sync::Manifesto>> {
    let plano = trancar(nucleo)?.preparar_atualizacao(forcar)?;
    if let Some(plano) = plano {
        let manifesto = sync::buscar_manifesto(plano.transporte.as_ref(), &plano.servidor)?;
        trancar(nucleo)?.guardar_manifesto(manifesto)?;
    }
    Ok(trancar(nucleo)?.atualizacao().cloned())
}

/// Baixa a atualização (fora da trava) e devolve o caminho do APK conferido.
pub fn baixar_atualizacao(nucleo: &Mutex<Core>) -> Result<std::path::PathBuf> {
    let plano = trancar(nucleo)?.preparar_download()?;
    plano.executar()
}

/// Atualiza as etapas no servidor de uma gravação (fora da trava) e devolve o detalhe.
pub fn detalhe(nucleo: &Mutex<Core>, id: &str) -> Result<DetalheLocal> {
    let plano = trancar(nucleo)?.preparar_etapas(id)?;
    if let Some((plano, remoto)) = plano {
        match plano.etapas(&remoto) {
            Ok(etapas) => trancar(nucleo)?.guardar_etapas(id, etapas)?,
            Err(err) => leitura_falhou(nucleo, &err)?,
        }
    }
    trancar(nucleo)?.gravacao(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versao_do_cliente_segue_o_contrato() {
        assert_eq!(client_version("0.1.0"), "eclume-android/0.1.0");
    }
}

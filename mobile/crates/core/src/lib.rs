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
use crate::sync::{Etapa, Medidor};

/// O prefixo do `client_version` e do user agent do app Android.
pub const CLIENT_PREFIX: &str = "eclume-android";

/// `eclume-android/<versão>`: o `capture.client_version` do upload e o user agent.
pub fn client_version(version: &str) -> String {
    format!("{CLIENT_PREFIX}/{version}")
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

/// O detalhe de uma gravação: a linha, os marcadores e as etapas no servidor (em cache fora da
/// rede).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DetalheLocal {
    pub gravacao: GravacaoLocal,
    pub caminho: Option<String>,
    pub marcadores: Vec<Marker>,
    pub etapas: Option<Vec<Etapa>>,
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
    etapas: HashMap<String, Vec<Etapa>>,
    /// A versão nova do `movel.json`, se houver.
    atualizacao: Option<sync::Manifesto>,
}

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

    /// O plugin avisou o Wi-Fi não medido. Devolve se a sonda deve rodar de novo.
    pub fn mudou_rede(&mut self, wifi_nao_medido: bool) -> bool {
        let mudou = self.rede.mudou_wifi(wifi_nao_medido);
        if mudou {
            log::info!("Wi-Fi não medido: {wifi_nao_medido}");
        }
        mudou
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

    /// O sync a rodar: na rede do eclume, sem outro em curso, com algo pendente e (sem `agora`)
    /// com o sync automático ligado.
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

    /// "Salvar" ou "Pular" na folha.
    pub fn salvar(&mut self, id: &str, titulo: Option<&str>, tipo: Option<&str>) -> Result<()> {
        Sessao::salvar(&self.fila, id, titulo, tipo)?;
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
    /// Devolve a gravação fechada, para o chamador avisar.
    pub fn verificar_limites(&mut self) -> Result<Option<QueuedRecording>> {
        let sem_espaco = self
            .espaco_livre
            .is_some_and(|livre| estimativas::deve_parar_por_espaco(livre, self.bitrate()));
        if self.sessao.gravando() && (sem_espaco || self.sessao.terminou_sozinha()) {
            return self.parar().map(Some);
        }
        Ok(None)
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
            etapas: self.etapas.get(id).cloned(),
        })
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

    pub fn guardar_etapas(&mut self, id: &str, etapas: Vec<Etapa>) {
        self.etapas.insert(id.to_string(), etapas);
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

    pub fn etapas(&self, remote_id: &str) -> Result<Vec<Etapa>> {
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

/// O ciclo do `SyncWorker`. O WorkManager só o roda em rede não medida (`UNMETERED`), e o processo
/// aberto só para ele não tem a tela que avisaria o Wi-Fi: sem isso, a sonda nunca rodaria.
pub fn ciclo_do_worker(nucleo: &Mutex<Core>) -> Result<Option<eclume_recorder::SyncReport>> {
    trancar(nucleo)?.mudou_rede(true);
    ciclo(nucleo, false)
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
        }
    }
    if let Err(err) = verificar_atualizacao(nucleo, false) {
        log::warn!("{err:#}");
    }
    let Some(plano) = trancar(nucleo)?.preparar_sync(agora)? else {
        return Ok(None);
    };
    let (relatorio, recusada) = plano.executar()?;
    trancar(nucleo)?.concluir_sync(recusada)?;
    Ok(Some(relatorio))
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
            Ok(etapas) => trancar(nucleo)?.guardar_etapas(id, etapas),
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

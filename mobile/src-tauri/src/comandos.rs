//! Os comandos que a UI chama (`invoke`). Cada um trava o núcleo só o tempo da operação local; o
//! que fala com a rede demorado (sonda, sync, etapas) roda fora da trava pelas funções do núcleo.

use eclume_mobile_core::config::TipoDeAgenda;
use eclume_mobile_core::{
    self as core, trancar, Core, DetalheLocal, EstadoApp, GravacaoLocal, Preferencias,
};
use eclume_recorder::Marker;
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use crate::eventos;

/// O prazo da folha "Gravação salva" (`DETAILS_WAIT_MS`), que segura o sync da gravação parada.
const PRAZO_DA_FOLHA: std::time::Duration =
    std::time::Duration::from_millis(eclume_recorder::queue::DETAILS_WAIT_MS.unsigned_abs());

/// O erro de um comando, em texto para a UI mostrar.
type Resultado<T> = Result<T, String>;

fn texto(err: anyhow::Error) -> String {
    format!("{err:#}")
}

fn nucleo() -> Resultado<&'static std::sync::Mutex<Core>> {
    core::global().ok_or_else(|| "o app ainda está abrindo".to_string())
}

/// Roda `f` no núcleo travado e avisa a UI do estado novo.
fn com_nucleo<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&mut Core) -> anyhow::Result<T>,
) -> Resultado<T> {
    let resultado = {
        let mut core = trancar(nucleo()?).map_err(texto)?;
        f(&mut core).map_err(texto)
    };
    eventos::avisar(app);
    resultado
}

/// Como [`com_nucleo`], numa thread de bloqueio: os comandos que falam com o servidor (baixar a CA,
/// `/server`, login, pareamento) não podem prender a thread principal (ANR) com um endereço mudo.
async fn com_nucleo_na_rede<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    f: impl FnOnce(&mut Core) -> anyhow::Result<T> + Send + 'static,
) -> Resultado<T> {
    tauri::async_runtime::spawn_blocking(move || com_nucleo(&app, f))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn estado() -> Resultado<EstadoApp> {
    trancar(nucleo()?).map_err(texto)?.estado().map_err(texto)
}

#[tauri::command]
pub async fn conectar_descoberto<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    ca: Option<String>,
) -> Resultado<()> {
    com_nucleo_na_rede(app, move |c| c.conectar_descoberto(&url, ca.as_deref())).await
}

#[tauri::command]
pub async fn conectar_endereco<R: Runtime>(app: AppHandle<R>, endereco: String) -> Resultado<()> {
    com_nucleo_na_rede(app, move |c| c.conectar_endereco(&endereco)).await
}

#[tauri::command]
pub async fn confiar_ca<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    com_nucleo_na_rede(app, Core::confiar_ca).await
}

#[tauri::command]
pub fn cancelar_ca<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    com_nucleo(&app, |c| {
        c.cancelar_ca();
        Ok(())
    })
}

#[tauri::command]
pub async fn entrar<R: Runtime>(app: AppHandle<R>, email: String, senha: String) -> Resultado<()> {
    com_nucleo_na_rede(app.clone(), move |c| c.entrar(&email, &senha)).await?;
    eventos::ciclo_em_segundo_plano(&app, true);
    Ok(())
}

#[tauri::command]
pub async fn parear<R: Runtime>(app: AppHandle<R>, texto: String) -> Resultado<()> {
    com_nucleo_na_rede(app.clone(), move |c| c.parear(&texto)).await?;
    eventos::ciclo_em_segundo_plano(&app, true);
    Ok(())
}

/// Gravar só confirma depois de o serviço entrar em primeiro plano: abrir o microfone e esperar o
/// Kotlin rodam numa thread de bloqueio (comando síncrono roda na thread principal). Se o Android
/// recusar o serviço, a gravação aberta é desfeita e a tela recebe o motivo.
#[tauri::command]
pub async fn gravar<R: Runtime>(app: AppHandle<R>) -> Resultado<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let fonte = crate::microfone().map_err(texto)?;
        let id = com_nucleo(&app, |c| c.gravar(fonte))?;
        if let Err(motivo) = crate::servico::iniciar(&app) {
            log::warn!("serviço de gravação recusado: {motivo}");
            com_nucleo(&app, Core::desfazer_gravacao)?;
            return Err(format!(
                "O Android não deixou gravar em segundo plano: {motivo}"
            ));
        }
        Ok(id)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn pausar<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    com_nucleo(&app, |c| c.pausar())?;
    crate::servico::atualizar(&app);
    Ok(())
}

#[tauri::command]
pub fn continuar<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    com_nucleo(&app, |c| c.continuar())?;
    crate::servico::atualizar(&app);
    Ok(())
}

#[tauri::command]
pub fn marcar<R: Runtime>(app: AppHandle<R>, nota: Option<String>) -> Resultado<Marker> {
    let marcador = com_nucleo(&app, |c| c.marcar(nota.as_deref()))?;
    crate::servico::atualizar(&app);
    Ok(marcador)
}

#[tauri::command]
pub fn anotar_marcador<R: Runtime>(
    app: AppHandle<R>,
    client_id: String,
    nota: Option<String>,
) -> Resultado<Marker> {
    com_nucleo(&app, |c| c.anotar_marcador(&client_id, nota.as_deref()))
}

#[tauri::command]
pub fn parar<R: Runtime>(app: AppHandle<R>) -> Resultado<String> {
    let gravacao = com_nucleo(&app, Core::parar)?;
    crate::servico::parar(&app);
    // A folha "Gravação salva" segura o sync até o prazo dela: o trabalho espera o mesmo prazo,
    // para a gravação subir com o app fechado mesmo com a folha esquecida aberta.
    crate::servico::agendar_sync(&app, PRAZO_DA_FOLHA);
    Ok(gravacao.id)
}

#[tauri::command]
pub fn salvar<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    titulo: Option<String>,
    tipo_de_agenda_id: Option<String>,
    idioma: Option<String>,
) -> Resultado<()> {
    com_nucleo(&app, |c| {
        c.salvar(
            &id,
            titulo.as_deref(),
            tipo_de_agenda_id.as_deref(),
            idioma.as_deref(),
        )
    })?;
    // Ao parar, a sonda roda de novo: a gravação pode subir já, ou com o app fechado pelo
    // trabalho de sync, no próximo Wi-Fi do eclume.
    eventos::ciclo_em_segundo_plano(&app, false);
    crate::servico::agendar_sync(&app, std::time::Duration::ZERO);
    Ok(())
}

#[tauri::command]
pub fn sincronizar_agora<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    eventos::ciclo_em_segundo_plano(&app, true);
    Ok(())
}

#[tauri::command]
pub fn gravacoes() -> Resultado<Vec<GravacaoLocal>> {
    trancar(nucleo()?)
        .map_err(texto)?
        .gravacoes()
        .map_err(texto)
}

#[tauri::command]
pub async fn gravacao(id: String) -> Resultado<DetalheLocal> {
    // Fora da thread principal: a leitura das etapas no servidor é de rede.
    tauri::async_runtime::spawn_blocking(move || core::detalhe(nucleo()?, &id).map_err(texto))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub fn excluir_local<R: Runtime>(app: AppHandle<R>, id: String) -> Resultado<()> {
    com_nucleo(&app, |c| c.excluir_local(&id))
}

#[tauri::command]
pub fn excluir_sincronizadas<R: Runtime>(app: AppHandle<R>) -> Resultado<u64> {
    com_nucleo(&app, |c| c.excluir_sincronizadas())
}

#[tauri::command]
pub fn tipos_de_agenda() -> Resultado<Vec<TipoDeAgenda>> {
    Ok(trancar(nucleo()?)
        .map_err(texto)?
        .config()
        .tipos_de_agenda
        .clone())
}

/// As opções de idioma da folha "Gravação salva", com o padrão da conta nomeado.
#[tauri::command]
pub fn idiomas() -> Resultado<Vec<eclume_mobile_core::OpcaoDeIdioma>> {
    Ok(trancar(nucleo()?).map_err(texto)?.opcoes_de_idioma())
}

/// O que a tela Configurações mostra.
#[derive(Clone, Debug, Serialize)]
pub struct Configuracoes {
    pub servidor: Option<String>,
    pub preferencias: Preferencias,
    pub reter_dias: u32,
    pub uso_bytes: u64,
    pub versao: String,
}

#[tauri::command]
pub fn configuracoes() -> Resultado<Configuracoes> {
    let core = trancar(nucleo()?).map_err(texto)?;
    Ok(Configuracoes {
        servidor: core.config().servidor.as_ref().map(|s| s.url.clone()),
        preferencias: core.preferencias(),
        reter_dias: core.config().reter_dias,
        uso_bytes: core.uso_local().map_err(texto)?,
        versao: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
pub fn salvar_configuracoes<R: Runtime>(
    app: AppHandle<R>,
    preferencias: Preferencias,
) -> Resultado<()> {
    com_nucleo(&app, |c| c.salvar_preferencias(&preferencias))
}

#[tauri::command]
pub fn sair<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    com_nucleo(&app, Core::sair)
}

/// A UI ficou visível ou foi para o segundo plano (a sonda periódica só roda visível).
#[tauri::command]
pub fn visibilidade<R: Runtime>(app: AppHandle<R>, visivel: bool) -> Resultado<()> {
    com_nucleo(&app, |c| {
        c.definir_visivel(visivel);
        Ok(())
    })?;
    if visivel {
        eventos::ciclo_em_segundo_plano(&app, false);
    }
    Ok(())
}

/// Uma versão nova no `movel.json`.
#[derive(Clone, Debug, Serialize)]
pub struct Atualizacao {
    pub versao: String,
    pub notas: Option<String>,
}

/// Lê o `movel.json` do servidor (pela CA fixada) e devolve a versão nova, se houver.
#[tauri::command]
pub async fn verificar_atualizacao() -> Resultado<Option<Atualizacao>> {
    tauri::async_runtime::spawn_blocking(|| {
        let manifesto = core::verificar_atualizacao(nucleo()?, true).map_err(texto)?;
        Ok(manifesto.map(|m| Atualizacao {
            versao: m.versao,
            notas: m.notas.filter(|n| !n.trim().is_empty()),
        }))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Baixa o APK da versão nova, confere o SHA-256 e abre o instalador do sistema.
#[tauri::command]
pub async fn atualizar<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_eclume_gravador::GravadorExt;

        let apk = core::baixar_atualizacao(nucleo()?).map_err(texto)?;
        let aberto = app
            .gravador()
            .abrir_instalador(&apk.to_string_lossy())
            .map_err(|err| err.to_string())?;
        if aberto {
            Ok(())
        } else {
            Err(
                "Permita instalar apps do eclume na tela que abriu e toque em atualizar de novo"
                    .into(),
            )
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// "Abrir na web": a página da gravação enviada no navegador do sistema, pelo endereço do
/// servidor pareado.
#[tauri::command]
pub fn abrir_na_web<R: Runtime>(app: AppHandle<R>, id: String) -> Resultado<()> {
    use tauri_plugin_eclume_gravador::GravadorExt;

    let url = trancar(nucleo()?)
        .map_err(texto)?
        .gravacao(&id)
        .map_err(texto)?
        .endereco_na_web
        .ok_or_else(|| "A gravação ainda não foi enviada ao servidor".to_string())?;
    app.gravador()
        .abrir_url(&url)
        .map_err(|err| err.to_string())
}

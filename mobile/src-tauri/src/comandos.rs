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

#[tauri::command]
pub fn estado() -> Resultado<EstadoApp> {
    trancar(nucleo()?).map_err(texto)?.estado().map_err(texto)
}

#[tauri::command]
pub fn conectar_descoberto<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    ca: Option<String>,
) -> Resultado<()> {
    com_nucleo(&app, |c| c.conectar_descoberto(&url, ca.as_deref()))
}

#[tauri::command]
pub fn conectar_endereco<R: Runtime>(app: AppHandle<R>, endereco: String) -> Resultado<()> {
    com_nucleo(&app, |c| c.conectar_endereco(&endereco))
}

#[tauri::command]
pub fn confiar_ca<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    com_nucleo(&app, Core::confiar_ca)
}

#[tauri::command]
pub fn cancelar_ca<R: Runtime>(app: AppHandle<R>) -> Resultado<()> {
    com_nucleo(&app, |c| {
        c.cancelar_ca();
        Ok(())
    })
}

#[tauri::command]
pub fn entrar<R: Runtime>(app: AppHandle<R>, email: String, senha: String) -> Resultado<()> {
    com_nucleo(&app, |c| c.entrar(&email, &senha))?;
    eventos::ciclo_em_segundo_plano(&app, true);
    Ok(())
}

#[tauri::command]
pub fn parear<R: Runtime>(app: AppHandle<R>, texto: String) -> Resultado<()> {
    com_nucleo(&app, |c| c.parear(&texto))?;
    eventos::ciclo_em_segundo_plano(&app, true);
    Ok(())
}

#[tauri::command]
pub fn gravar<R: Runtime>(app: AppHandle<R>) -> Resultado<String> {
    let fonte = crate::microfone().map_err(texto)?;
    let id = com_nucleo(&app, |c| c.gravar(fonte))?;
    crate::servico::iniciar(&app);
    Ok(id)
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
    Ok(gravacao.id)
}

#[tauri::command]
pub fn salvar<R: Runtime>(
    app: AppHandle<R>,
    id: String,
    titulo: Option<String>,
    tipo_de_agenda_id: Option<String>,
) -> Resultado<()> {
    com_nucleo(&app, |c| {
        c.salvar(&id, titulo.as_deref(), tipo_de_agenda_id.as_deref())
    })?;
    // Ao parar, a sonda roda de novo: a gravação pode subir já.
    eventos::ciclo_em_segundo_plano(&app, false);
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

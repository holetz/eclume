//! Abre as fontes reais de áudio (mic e sistema) para uma gravação, conforme a aba Áudio.

use anyhow::{bail, Context, Result};
use eclume_audio_capture::{AudioSource, MicSource, SystemSource};

/// As fontes abertas e as que faltaram (com o motivo).
pub struct OpenedSources {
    pub sources: Vec<Box<dyn AudioSource>>,
    pub missing: Vec<String>,
}

/// O que a aba Áudio escolheu.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioChoice {
    /// O microfone pelo nome; `None` é o padrão do sistema.
    pub mic: Option<String>,
    /// Gravar também o áudio do sistema (reuniões; a nota nunca grava).
    pub system_audio: bool,
}

/// Abre o microfone escolhido; o aviso de quando ele sumiu vai em `missing`.
fn open_chosen_mic(choice: &AudioChoice, missing: &mut Vec<String>) -> Result<MicSource> {
    let mic = MicSource::open_named(choice.mic.as_deref())?;
    if mic.fell_back() {
        missing.push(format!(
            "o microfone {} (usando o padrão do sistema)",
            choice.mic.as_deref().unwrap_or_default()
        ));
    }
    Ok(mic)
}

/// Abre só o microfone, para a nota por voz: o áudio do sistema traria música e notificações.
pub fn open_mic(choice: &AudioChoice) -> Result<OpenedSources> {
    let mut missing = Vec::new();
    let mic = open_chosen_mic(choice, &mut missing).context("falha ao abrir o microfone")?;
    Ok(OpenedSources {
        sources: vec![Box::new(mic)],
        missing,
    })
}

/// Abre o mic e, se escolhido, o áudio do sistema. Grava com o que abrir: uma fonte que falha
/// vira aviso, e só é erro quando nenhuma abre.
pub fn open_sources(choice: &AudioChoice) -> Result<OpenedSources> {
    let mut sources: Vec<Box<dyn AudioSource>> = Vec::with_capacity(2);
    let mut missing = Vec::new();

    match open_chosen_mic(choice, &mut missing) {
        Ok(mic) => sources.push(Box::new(mic)),
        Err(err) => missing.push(format!("mic: {err:#}")),
    }
    if choice.system_audio {
        match SystemSource::open() {
            Ok(system) => sources.push(Box::new(system)),
            Err(err) => missing.push(format!("áudio do sistema: {err:#}")),
        }
    }

    if sources.is_empty() {
        bail!("nenhuma fonte de áudio abriu ({})", missing.join("; "));
    }
    for reason in &missing {
        log::warn!("gravando sem {reason}");
    }
    Ok(OpenedSources { sources, missing })
}

//! Abre as fontes reais de áudio (mic e sistema) para uma gravação.

use anyhow::{bail, Context, Result};
use eclume_audio_capture::{AudioSource, MicSource, SystemSource};

/// As fontes abertas e as que faltaram (com o motivo).
pub struct OpenedSources {
    pub sources: Vec<Box<dyn AudioSource>>,
    pub missing: Vec<String>,
}

/// Abre só o microfone, para a nota por voz: o áudio do sistema traria música e notificações.
pub fn open_mic() -> Result<OpenedSources> {
    let mic = MicSource::open().context("falha ao abrir o microfone")?;
    Ok(OpenedSources {
        sources: vec![Box::new(mic)],
        missing: Vec::new(),
    })
}

/// Abre o mic e o áudio do sistema. Grava com o que abrir: uma fonte que falha vira aviso, e só
/// é erro quando nenhuma abre.
pub fn open_sources() -> Result<OpenedSources> {
    let mut sources: Vec<Box<dyn AudioSource>> = Vec::with_capacity(2);
    let mut missing = Vec::new();

    match MicSource::open() {
        Ok(mic) => sources.push(Box::new(mic)),
        Err(err) => missing.push(format!("mic: {err:#}")),
    }
    match SystemSource::open() {
        Ok(system) => sources.push(Box::new(system)),
        Err(err) => missing.push(format!("áudio do sistema: {err:#}")),
    }

    if sources.is_empty() {
        bail!("nenhuma fonte de áudio abriu ({})", missing.join("; "));
    }
    for reason in &missing {
        log::warn!("gravando sem {reason}");
    }
    Ok(OpenedSources { sources, missing })
}

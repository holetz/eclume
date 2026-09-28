//! Abre as fontes reais de áudio (mic e sistema) para uma gravação, conforme a aba Áudio.

use anyhow::{bail, Context, Result};
use eclume_audio_capture::{AudioSource, MicSource, SystemSource};

use crate::config::{Config, SOURCE_NONE, SYSTEM_FOLLOW};

/// As fontes abertas e as que faltaram (com o motivo).
pub struct OpenedSources {
    pub sources: Vec<Box<dyn AudioSource>>,
    pub missing: Vec<String>,
}

/// Uma fonte da aba Áudio.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SourceChoice {
    /// "Nenhum": a fonte fica de fora.
    Off,
    /// O padrão do sistema (mic) ou a saída em uso (sistema).
    #[default]
    Auto,
    /// Um dispositivo pelo nome (mic) ou pelo id (saída).
    Device(String),
}

impl SourceChoice {
    /// Um valor da config que não é o automático: `"none"` ou um dispositivo.
    fn chosen(value: &str) -> Self {
        match value {
            SOURCE_NONE => Self::Off,
            device => Self::Device(device.to_string()),
        }
    }

    /// O dispositivo escolhido; `None` no automático.
    pub fn device(&self) -> Option<&str> {
        match self {
            Self::Device(device) => Some(device),
            Self::Off | Self::Auto => None,
        }
    }
}

/// O que a aba Áudio escolheu.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioChoice {
    pub mic: SourceChoice,
    /// O áudio do sistema (reuniões; a nota nunca grava).
    pub system: SourceChoice,
}

impl AudioChoice {
    pub fn from_config(config: &Config) -> Self {
        Self {
            mic: config
                .mic
                .as_deref()
                .map_or(SourceChoice::Auto, SourceChoice::chosen),
            system: match config.system_source.as_str() {
                SYSTEM_FOLLOW => SourceChoice::Auto,
                source => SourceChoice::chosen(source),
            },
        }
    }
}

/// Abre o microfone escolhido (ligado); o aviso de quando ele sumiu vai em `missing`.
fn open_chosen_mic(mic: &SourceChoice, missing: &mut Vec<String>) -> Result<MicSource> {
    let source = MicSource::open_named(mic.device())?;
    if source.fell_back() {
        missing.push(format!(
            "o microfone {} (usando o padrão do sistema)",
            mic.device().unwrap_or_default()
        ));
    }
    Ok(source)
}

/// Abre a origem escolhida do áudio do sistema (ligada); a saída que sumiu vira aviso.
fn open_chosen_system(system: &SourceChoice, missing: &mut Vec<String>) -> Result<SystemSource> {
    let source = SystemSource::open_target(system.device())?;
    if source.fell_back() {
        missing.push(format!(
            "a saída {} (seguindo a saída em uso)",
            system.device().unwrap_or_default()
        ));
    }
    Ok(source)
}

/// Abre só o microfone, para a nota por voz: o áudio do sistema traria música e notificações.
pub fn open_mic(choice: &AudioChoice) -> Result<OpenedSources> {
    if choice.mic == SourceChoice::Off {
        bail!("A nota precisa de um microfone");
    }
    let mut missing = Vec::new();
    let mic = open_chosen_mic(&choice.mic, &mut missing).context("falha ao abrir o microfone")?;
    Ok(OpenedSources {
        sources: vec![Box::new(mic)],
        missing,
    })
}

/// Abre as fontes que não são "Nenhum". Grava com o que abrir: uma fonte que falha vira aviso, e
/// só é erro quando nenhuma abre.
pub fn open_sources(choice: &AudioChoice) -> Result<OpenedSources> {
    let mut sources: Vec<Box<dyn AudioSource>> = Vec::with_capacity(2);
    let mut missing = Vec::new();

    if choice.mic != SourceChoice::Off {
        match open_chosen_mic(&choice.mic, &mut missing) {
            Ok(mic) => sources.push(Box::new(mic)),
            Err(err) => missing.push(format!("mic: {err:#}")),
        }
    }
    if choice.system != SourceChoice::Off {
        match open_chosen_system(&choice.system, &mut missing) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escolha_de_audio_vem_da_config() {
        let mut config = Config::default();
        assert_eq!(AudioChoice::from_config(&config), AudioChoice::default());
        config.mic = Some(SOURCE_NONE.into());
        config.system_source = "alsa_output.usb".into();
        assert_eq!(
            AudioChoice::from_config(&config),
            AudioChoice {
                mic: SourceChoice::Off,
                system: SourceChoice::Device("alsa_output.usb".into()),
            }
        );
        config.mic = Some("Jabra Evolve2 65".into());
        config.system_source = SOURCE_NONE.into();
        let choice = AudioChoice::from_config(&config);
        assert_eq!(choice.mic.device(), Some("Jabra Evolve2 65"));
        assert_eq!(choice.system, SourceChoice::Off);
    }

    #[test]
    fn nota_sem_microfone_e_recusada() {
        let choice = AudioChoice {
            mic: SourceChoice::Off,
            system: SourceChoice::Auto,
        };
        let err = open_mic(&choice).err().unwrap();
        assert_eq!(format!("{err:#}"), "A nota precisa de um microfone");
    }
}

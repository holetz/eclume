//! Opens real audio sources (mic and system) for a recording, as set in the Audio tab.

use anyhow::{bail, Context, Result};
use eclume_audio_capture::{AudioSource, MicSource, SystemSource};

use crate::config::{Config, SOURCE_NONE, SYSTEM_FOLLOW};

/// Opened sources and missing ones (with the reason).
pub struct OpenedSources {
    pub sources: Vec<Box<dyn AudioSource>>,
    pub missing: Vec<String>,
}

/// A source from the Audio tab.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SourceChoice {
    /// "None": excludes the source.
    Off,
    /// The system default (mic) or the active output (system).
    #[default]
    Auto,
    /// A device by name (mic) or ID (output).
    Device(String),
}

impl SourceChoice {
    /// A config value other than automatic: `"none"` or a device.
    fn chosen(value: &str) -> Self {
        match value {
            SOURCE_NONE => Self::Off,
            device => Self::Device(device.to_string()),
        }
    }

    /// The chosen device; `None` for automatic.
    pub fn device(&self) -> Option<&str> {
        match self {
            Self::Device(device) => Some(device),
            Self::Off | Self::Auto => None,
        }
    }
}

/// The Audio tab selections.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AudioChoice {
    pub mic: SourceChoice,
    /// System audio (meetings; voice notes never record it).
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

/// Opens the chosen (enabled) microphone; a notice if it vanished goes in `missing`.
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

/// Opens the chosen (enabled) system audio source; a missing output becomes a notice.
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

/// The source monitored by the Audio tab level test.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestSource {
    Mic,
    System,
}

/// Opens the chosen source for the level test; "None" has nothing to test.
pub fn open_test_source(choice: &AudioChoice, test: TestSource) -> Result<Box<dyn AudioSource>> {
    match test {
        TestSource::Mic if choice.mic == SourceChoice::Off => bail!("Nenhum microfone escolhido"),
        TestSource::System if choice.system == SourceChoice::Off => {
            bail!("Nenhuma saída de áudio escolhida")
        }
        TestSource::Mic => Ok(Box::new(MicSource::open_named(choice.mic.device())?)),
        TestSource::System => Ok(Box::new(SystemSource::open_target(choice.system.device())?)),
    }
}

/// Opens only the microphone for a voice note: system audio would bring music and notifications.
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

/// Opens sources other than "None". Records whatever opens: a failed source becomes a notice,
/// and only fails if none opens.
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
        log::warn!("recording without {reason}");
    }
    Ok(OpenedSources { sources, missing })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_choice_comes_from_config() {
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
    fn source_test_with_none_is_rejected() {
        let choice = AudioChoice {
            mic: SourceChoice::Off,
            system: SourceChoice::Off,
        };
        let err = open_test_source(&choice, TestSource::Mic).err().unwrap();
        assert_eq!(err.to_string(), "Nenhum microfone escolhido");
        let err = open_test_source(&choice, TestSource::System).err().unwrap();
        assert_eq!(err.to_string(), "Nenhuma saída de áudio escolhida");
        let test: TestSource = serde_json::from_str(r#""system""#).unwrap();
        assert_eq!(test, TestSource::System);
    }

    #[test]
    fn voice_note_without_microphone_is_rejected() {
        let choice = AudioChoice {
            mic: SourceChoice::Off,
            system: SourceChoice::Auto,
        };
        let err = open_mic(&choice).err().unwrap();
        assert_eq!(format!("{err:#}"), "A nota precisa de um microfone");
    }
}

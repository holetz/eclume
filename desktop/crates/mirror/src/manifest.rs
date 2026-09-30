//! O manifesto `.eclume-sync.json` da raiz: o que o app escreveu, por gravação. É o que permite
//! mover e apagar só o que é dele. Começa com ponto, então o Obsidian não o mostra.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Nome do manifesto, na raiz da pasta sincronizada.
pub const FILE: &str = ".eclume-sync.json";

const VERSION: u32 = 1;

/// A versão do layout dos arquivos (pasta e nome). Sobe quando o desenho muda: um manifesto de
/// outra versão faz o próximo ciclo refazer tudo, e os arquivos do desenho antigo se vão.
pub const LAYOUT: u32 = 2;

/// O que foi escrito para uma gravação.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Versão do resumo espelhado, quando há `.md`.
    #[serde(default)]
    pub summary_version: Option<u64>,
    /// Revisão da transcrição espelhada, quando há `.jsonl`.
    #[serde(default)]
    pub transcript_revision: Option<u64>,
    /// Caminhos relativos à raiz, com `/`.
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    #[serde(default)]
    pub recordings: BTreeMap<String, Entry>,
    /// Gravações que falharam ao ler e esperam nova tentativa: o cursor avança mesmo com falha, e
    /// são elas, não a biblioteca inteira, que o ciclo seguinte repete.
    #[serde(default)]
    pub pending: BTreeSet<String>,
    /// Se as transcrições estavam ligadas quando os arquivos foram escritos; ausente é "não sei".
    /// Mudar a opção faz o ciclo seguinte refazer tudo (escreve ou tira os `.jsonl`).
    #[serde(default)]
    pub transcripts: Option<bool>,
    /// O layout com que os arquivos foram escritos; ausente (manifesto antigo) é `0`.
    #[serde(default)]
    pub layout: u32,
    /// O maior `updated_at` já espelhado: o `?since=` do próximo ciclo. Vive aqui, e não no
    /// estado do app, para que apagar a pasta (ou trocá-la) refaça tudo.
    #[serde(default)]
    pub since: Option<String>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self {
            version: VERSION,
            recordings: BTreeMap::new(),
            pending: BTreeSet::new(),
            transcripts: None,
            layout: 0,
            since: None,
        }
    }
}

impl Manifest {
    /// Lê o manifesto da raiz. Ausente ou ilegível vira um manifesto vazio (`true` no segundo
    /// valor quando estava ilegível): sem manifesto o app não apaga nada, só reescreve.
    pub fn load(root: &Path) -> (Self, bool) {
        match fs::read(root.join(FILE)) {
            Ok(bytes) => match serde_json::from_slice::<Manifest>(&bytes) {
                Ok(manifest) if manifest.version == VERSION => (manifest, false),
                _ => (Self::default(), true),
            },
            Err(_) => (Self::default(), false),
        }
    }

    /// Grava o manifesto por arquivo temporário e renomeação, para nunca deixá-lo pela metade.
    pub fn save(&self, root: &Path) -> Result<()> {
        let text = serde_json::to_string_pretty(self).context("serializar o manifesto")?;
        write_atomic(&root.join(FILE), text.as_bytes())
    }
}

/// Escreve `bytes` em `path` por um arquivo temporário vizinho (com ponto: o Obsidian o ignora).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, bytes).with_context(|| format!("escrever {}", tmp.display()))?;
    if let Err(error) = fs::rename(&tmp, path) {
        // No Windows a renomeação falha com o arquivo aberto (Obsidian, antivírus, OneDrive):
        // não deixa o temporário órfão.
        let _ = fs::remove_file(&tmp);
        return Err(error).with_context(|| format!("renomear para {}", path.display()));
    }
    Ok(())
}

/// SHA-256 em hexadecimal minúsculo.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Tmp;

    #[test]
    fn manifesto_vai_e_volta_do_disco() {
        let tmp = Tmp::new("manifest-roundtrip");
        let mut manifest = Manifest::default();
        manifest.recordings.insert(
            "r1".into(),
            Entry {
                summary_version: Some(2),
                transcript_revision: Some(1),
                files: vec!["Clientes/a.md".into()],
            },
        );
        manifest.save(tmp.path()).unwrap();
        let (loaded, recovered) = Manifest::load(tmp.path());
        assert!(!recovered);
        assert_eq!(loaded, manifest);
        assert!(!tmp.path().join(".eclume-sync.json.tmp").exists());
    }

    #[test]
    fn ausente_e_vazio_e_corrompido_e_vazio_marcado() {
        let tmp = Tmp::new("manifest-ausente");
        assert_eq!(Manifest::load(tmp.path()), (Manifest::default(), false));
        fs::write(tmp.path().join(FILE), b"{ isto nao e json").unwrap();
        assert_eq!(Manifest::load(tmp.path()), (Manifest::default(), true));
        fs::write(tmp.path().join(FILE), br#"{"version": 99}"#).unwrap();
        assert_eq!(Manifest::load(tmp.path()), (Manifest::default(), true));
    }

    #[test]
    fn sha256_conhecido() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}

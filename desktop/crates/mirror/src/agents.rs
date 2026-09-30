//! O `AGENTS.md` da raiz: explica a um agente (Claude Code, Codex ou outro) o que há na pasta e
//! como lê-la e pesquisá-la. É regerado a cada ciclo; um `AGENTS.md` do próprio usuário, sem o
//! marcador abaixo, nunca é sobrescrito.

use anyhow::Result;

use crate::manifest::sha256_hex;
use crate::reconcile::Mirror;

/// Nome do arquivo, na raiz.
pub const FILE: &str = "AGENTS.md";

/// Primeira linha do arquivo gerado: é o que distingue o do app de um escrito à mão.
pub const MARKER: &str =
    "<!-- Gerado pelo eclume desktop; regerado a cada sincronização. Não edite. -->";

/// O texto do `AGENTS.md`. Com `transcripts` falso, as instruções do JSONL saem.
pub fn markdown(transcripts: bool) -> String {
    let mut out = String::new();
    out.push_str(MARKER);
    out.push_str("\n\n# Pasta sincronizada do eclume\n\n");
    out.push_str(
        "Esta pasta é um **espelho somente de leitura** da biblioteca do eclume: o resumo atual de \
cada gravação em Markdown\
",
    );
    if transcripts {
        out.push_str(" e a transcrição em JSONL");
    }
    out.push_str(
        ". O servidor é a fonte: o app sobrescreve os arquivos abaixo a cada sincronização e \
apaga os que saíram do servidor. **Não edite** esses arquivos; para anotar, crie um arquivo seu \
(o app nunca toca no que não gerou).\n\n",
    );
    out.push_str("## Como está organizado\n\n");
    out.push_str(
        "- Uma **subpasta por Collection**, e dentro dela uma **subpasta por mês** (`AAAA-MM`). Uma \
gravação em várias Collections aparece em cada uma (cópias idênticas). Gravações sem Collection \
ficam em `sem-colecao/`.\n\
- Nome do arquivo: `AAAA-MM-DD_HHMM_<id8>.md`, ordenável por data e hora locais, em que `<id8>` \
são os 8 primeiros caracteres do id da gravação (a referência que o eclume web mostra). O título \
**não** está no nome: está na propriedade `title` (e em `aliases`), dentro do arquivo.\n",
    );
    if transcripts {
        out.push_str(
            "- A transcrição tem o mesmo nome-base, com a extensão `.jsonl`, na mesma subpasta.\n",
        );
    }
    out.push_str("- `.eclume-sync.json` é o controle do app: ignore-o.\n\n");
    out.push_str("## O resumo (`.md`)\n\n");
    out.push_str(
        "Começa com front matter YAML (propriedades no Obsidian): `recording_id`, `title`, `aliases`, \
`recorded_at`, `collections`, `agenda_type` (o tipo de agenda, como \"Reunião de equipe\"), \
`summary_version`",
    );
    if transcripts {
        out.push_str(" e `transcript` (o arquivo `.jsonl` da mesma gravação)");
    }
    out.push_str(". Depois vem o resumo em Markdown.\n\n");
    if transcripts {
        out.push_str("## A transcrição (`.jsonl`)\n\n");
        out.push_str(
            "Uma linha por objeto JSON. A primeira tem `\"type\":\"meta\"` (`id`, `recording_id`, \
`title`, `language`, `recorded_at`, `duration_ms`, `revision`, `speakers`); as demais têm \
`\"type\":\"segment\"` com `speaker` (o nome), `speaker_id`, `start_ms`, `end_ms` e `text`. \
Como o Obsidian não indexa `.jsonl`, as transcrições não aparecem na busca nem no grafo do vault.\n\n",
        );
    }
    out.push_str("## Como pesquisar\n\n```bash\n");
    out.push_str("# resumos que citam um termo\nrg -il \"orçamento\" --glob '*.md'\n\n");
    out.push_str("# tudo de uma Collection num mês\nls \"Clientes/2026-09/\"\n\n\
# achar pelo título (está no front matter, não no nome)\nrg -l '^title: .*orçamento' --glob '*.md'\n\n");
    out.push_str("# resumos de um tipo de agenda\nrg -l '^agenda_type: \"1:1\"' --glob '*.md'\n");
    if transcripts {
        out.push_str(
            "\n# quem falou o quê, num trecho\n\
jq -r 'select(.type==\"segment\") | \"\\(.speaker): \\(.text)\"' \"Clientes/2026-09/2026-09-18_1100_01928f3a.jsonl\"\n\n\
# transcrições que citam um termo\nrg -il \"prazo\" --glob '*.jsonl'\n",
        );
    }
    out.push_str("```\n\n");
    out.push_str(
        "Cada arquivo traz o `recording_id`: use-o para citar a fonte. Prefira ler o resumo antes \
da transcrição; a transcrição é o registro bruto e pode ser longa.\n",
    );
    out
}

impl Mirror {
    /// Escreve o `AGENTS.md` da raiz. Devolve `false` quando nada mudou ou quando há um
    /// `AGENTS.md` que não é do app (sem o marcador), que fica intacto.
    pub fn write_agents(&mut self, transcripts: bool) -> Result<bool> {
        let path = self.root.join(FILE);
        if let Ok(current) = std::fs::read_to_string(&path) {
            if !current.starts_with(MARKER) {
                return Ok(false);
            }
        }
        let text = markdown(transcripts);
        let written = self.write_file(FILE, text.as_bytes())?;
        self.manifest.agents_sha256 = Some(sha256_hex(text.as_bytes()));
        Ok(written)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Tmp;

    #[test]
    fn explica_layout_front_matter_e_busca() {
        let text = markdown(true);
        assert!(text.starts_with(MARKER));
        for esperado in [
            "subpasta por Collection",
            "sem-colecao/",
            "AAAA-MM-DD_HHMM_<id8>.md",
            "subpasta por mês",
            "`aliases`",
            "`recording_id`",
            "\"type\":\"meta\"",
            "não indexa `.jsonl`",
            "rg -il",
            "jq -r",
            ".eclume-sync.json",
        ] {
            assert!(text.contains(esperado), "faltou: {esperado}");
        }
    }

    #[test]
    fn sem_transcricoes_o_texto_nao_fala_de_jsonl() {
        let text = markdown(false);
        assert!(!text.contains("jsonl"));
        assert!(!text.contains("jq"));
        assert!(text.contains("resumo atual de cada gravação em Markdown."));
        assert!(text.contains("sem-colecao/"));
    }

    #[test]
    fn escreve_regera_e_nao_pisa_no_do_usuario() {
        let tmp = Tmp::new("agents");
        let mut mirror = Mirror::open(tmp.path()).unwrap();
        assert!(mirror.write_agents(true).unwrap());
        assert!(!mirror.write_agents(true).unwrap());
        // Mudar a opção regera o texto.
        assert!(mirror.write_agents(false).unwrap());
        assert!(!std::fs::read_to_string(tmp.path().join(FILE))
            .unwrap()
            .contains("jsonl"));

        std::fs::write(tmp.path().join(FILE), "# Meu AGENTS\n").unwrap();
        assert!(!mirror.write_agents(true).unwrap());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(FILE)).unwrap(),
            "# Meu AGENTS\n"
        );
    }
}

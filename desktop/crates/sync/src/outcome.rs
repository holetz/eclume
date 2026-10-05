//! O desfecho do processamento de uma gravação, lido da listagem por `?since=` (contrato 2.17.0):
//! resumo pronto, resumo que falhou, pronta sem resumo, transcrição que falhou ou, desde a 2.21.0,
//! a gravação parada à espera de o dono nomear os locutores (etapa `speakers` em `waiting`). A regra é a
//! mesma do web (`web/src/app/processingWatch.ts`), com os mesmos casos de teste; a marca d'água
//! garante que cada desfecho seja avisado uma vez, e nenhum anterior a ela.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::api::{cursor_from, LibraryRecording};

/// Folga da marca d'água e do `?since=`: cobre a transação que confirma depois de outra com
/// instante maior (o `now()` do servidor é o início da transação).
pub const MARGIN_SECS: i64 = 60;
/// Quanto tempo um desfecho avisado fica registrado: além disso, ele já está abaixo da marca.
const KEEP_DAYS: i64 = 7;
/// Motivos de etapa pulada que são ação da própria pessoa (ou anteriores ao pipeline): sem aviso.
const SILENT_REASONS: [&str; 3] = ["cancelled", "summary_deleted", "before_pipeline"];

/// Os desfechos avisáveis.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    SummaryReady,
    SummaryFailed,
    /// Pronta sem resumo: a etapa foi pulada (o motivo em [`Ended::reason`]).
    NoSummary,
    TranscriptionFailed,
    /// Parada à espera dos nomes dos locutores (a conta exige a marcação); o motivo em
    /// [`Ended::reason`].
    AwaitingSpeakers,
}

/// Um desfecho de uma gravação, com o instante em que aconteceu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub recording_id: String,
    pub title: String,
    pub outcome: Outcome,
    /// O motivo da etapa pulada, no vocabulário de `PipelineStep.reason`.
    pub reason: Option<String>,
    /// `finished_at` da etapa `summary`, da etapa `speakers` em espera ou do job.
    pub at: String,
}

/// O desfecho de um item da listagem, se o processamento dele terminou de um jeito avisável.
pub fn outcome_of(recording: &LibraryRecording) -> Option<Ended> {
    let ended = |outcome, reason: Option<&String>, at: &String| Ended {
        recording_id: recording.id.clone(),
        title: recording.title.clone(),
        outcome,
        reason: reason.cloned(),
        at: at.clone(),
    };
    if let Some(job) = &recording.job {
        if recording.status == "failed" && job.state == "failed" {
            return job
                .finished_at
                .as_ref()
                .map(|at| ended(Outcome::TranscriptionFailed, None, at));
        }
    }
    if let Some(speakers) = recording
        .pipeline
        .iter()
        .find(|step| step.step == "speakers" && step.state == "waiting")
    {
        if let Some(at) = &speakers.finished_at {
            return Some(ended(Outcome::AwaitingSpeakers, speakers.reason.as_ref(), at));
        }
    }
    let step = recording.summary_step()?;
    let at = step.finished_at.as_ref()?;
    let outcome = match step.state.as_str() {
        "done" => Outcome::SummaryReady,
        "failed" => Outcome::SummaryFailed,
        "skipped"
            if !step
                .reason
                .as_deref()
                .is_some_and(|r| SILENT_REASONS.contains(&r)) =>
        {
            Outcome::NoSummary
        }
        _ => return None,
    };
    Some(ended(outcome, step.reason.as_ref(), at))
}

/// O que o cliente lembra entre leituras: o próximo `?since=`, a marca d'água (desfechos com
/// instante até ela não avisam) e os desfechos já avisados acima dela (id → instante).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watermark {
    pub since: String,
    pub mark: String,
    #[serde(default)]
    pub notified: BTreeMap<String, String>,
}

impl Watermark {
    /// A primeira leitura: nada anterior a `now` é avisado.
    pub fn starting(now: DateTime<Utc>) -> Self {
        Self {
            since: format(now - Duration::seconds(MARGIN_SECS)),
            mark: format(now),
            notified: BTreeMap::new(),
        }
    }

    /// [`Watermark::starting`] a partir de milissegundos desde a época Unix.
    pub fn starting_ms(now_ms: i64) -> Self {
        Self::starting(DateTime::from_timestamp_millis(now_ms).unwrap_or_else(Utc::now))
    }

    /// Os desfechos novos da leitura `items` (feita com `?since=` = [`Watermark::since`]), que
    /// passam a contar como avisados; avança o `since` e a marca.
    pub fn take(&mut self, items: &[LibraryRecording]) -> Vec<Ended> {
        let mark = instant(&self.mark);
        let mut fresh = Vec::new();
        let mut latest = mark;
        for ended in items.iter().filter_map(outcome_of) {
            let Some(at) = instant(&ended.at) else {
                continue;
            };
            latest = latest.max(Some(at));
            let above = mark.is_none_or(|mark| at > mark);
            if above && self.notified.get(&ended.recording_id) != Some(&ended.at) {
                self.notified
                    .insert(ended.recording_id.clone(), ended.at.clone());
                fresh.push(ended);
            }
        }
        if let Some(latest) = latest {
            let advanced = latest - Duration::seconds(MARGIN_SECS);
            if mark.is_none_or(|mark| advanced > mark) {
                self.mark = format(advanced);
            }
        }
        if let Some(next) = cursor_from(items, MARGIN_SECS) {
            if instant(&next) > instant(&self.since) {
                self.since = next;
            }
        }
        if let Some(mark) = instant(&self.mark) {
            let keep = mark - Duration::days(KEEP_DAYS);
            self.notified
                .retain(|_, at| instant(at).is_some_and(|at| at > keep));
        }
        fresh
    }
}

fn instant(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

fn format(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{JobInfo, PipelineStepInfo};

    fn recording(
        id: &str,
        status: &str,
        summary: Option<(&str, Option<&str>, &str)>,
    ) -> LibraryRecording {
        LibraryRecording {
            id: id.into(),
            title: format!("Reunião {id}"),
            status: status.into(),
            recorded_at: None,
            created_at: None,
            updated_at: summary.map(|(_, _, at)| at.to_string()),
            collection_ids: vec![],
            transcript_id: None,
            agenda_type: None,
            pipeline: summary
                .map(|(state, reason, at)| PipelineStepInfo {
                    step: "summary".into(),
                    state: state.into(),
                    finished_at: (state != "active" && state != "pending").then(|| at.into()),
                    reason: reason.map(str::to_string),
                })
                .into_iter()
                .collect(),
            job: None,
        }
    }

    fn failed_job(id: &str, state: &str, at: &str) -> LibraryRecording {
        LibraryRecording {
            updated_at: Some(at.into()),
            job: Some(JobInfo {
                state: state.into(),
                finished_at: Some(at.into()),
            }),
            ..recording(id, "failed", None)
        }
    }

    const T: &str = "2026-10-01T12:00:00Z";

    #[test]
    fn os_quatro_desfechos_e_os_que_nao_avisam() {
        let outcome = |rec: &LibraryRecording| outcome_of(rec).map(|e| (e.outcome, e.reason));
        assert_eq!(
            outcome(&recording("a", "transcribed", Some(("done", None, T)))),
            Some((Outcome::SummaryReady, None))
        );
        assert_eq!(
            outcome(&recording("b", "transcribed", Some(("failed", None, T)))),
            Some((Outcome::SummaryFailed, None))
        );
        assert_eq!(
            outcome(&recording(
                "c",
                "transcribed",
                Some(("skipped", Some("no_provider"), T))
            )),
            Some((Outcome::NoSummary, Some("no_provider".into())))
        );
        assert_eq!(
            outcome(&failed_job("d", "failed", T)),
            Some((Outcome::TranscriptionFailed, None))
        );
        // Cancelar, apagar o resumo durante a geração e a gravação em curso não avisam.
        assert_eq!(outcome(&failed_job("e", "cancelled", T)), None);
        assert_eq!(
            outcome(&recording(
                "f",
                "transcribed",
                Some(("skipped", Some("summary_deleted"), T))
            )),
            None
        );
        assert_eq!(
            outcome(&recording(
                "g",
                "transcribed",
                Some(("skipped", Some("cancelled"), T))
            )),
            None
        );
        assert_eq!(
            outcome(&recording("h", "processing", Some(("active", None, T)))),
            None
        );
        assert_eq!(outcome(&recording("i", "processing", None)), None);
    }

    #[test]
    fn a_gravacao_parada_a_espera_dos_locutores_avisa() {
        let waiting = LibraryRecording {
            pipeline: vec![PipelineStepInfo {
                step: "speakers".into(),
                state: "waiting".into(),
                finished_at: Some(T.into()),
                reason: Some("unnamed_speakers".into()),
            }],
            ..recording("j", "transcribed", None)
        };
        let ended = outcome_of(&waiting).map(|e| (e.outcome, e.reason));
        let expected = Some((Outcome::AwaitingSpeakers, Some("unnamed_speakers".into())));
        assert_eq!(ended, expected);
        // Solta, a etapa concluída não é mais desfecho da espera.
        let released = LibraryRecording {
            pipeline: vec![PipelineStepInfo {
                step: "speakers".into(),
                state: "done".into(),
                finished_at: Some(T.into()),
                reason: None,
            }],
            ..recording("j", "transcribed", None)
        };
        assert_eq!(outcome_of(&released), None);
    }

    #[test]
    fn marca_dagua_avisa_uma_vez_e_nada_anterior() {
        let start = instant(T).unwrap();
        let mut mark = Watermark::starting(start);
        assert_eq!(mark.since, "2026-10-01T11:59:00.000000Z");
        let old = recording(
            "velho",
            "transcribed",
            Some(("done", None, "2026-10-01T11:00:00Z")),
        );
        let new = recording(
            "novo",
            "transcribed",
            Some(("failed", None, "2026-10-01T12:00:05Z")),
        );
        let got = mark.take(&[old, new.clone()]);
        assert_eq!(
            got.iter()
                .map(|e| e.recording_id.as_str())
                .collect::<Vec<_>>(),
            ["novo"]
        );
        // Reaparecer (título editado) não repete o aviso.
        assert!(mark.take(std::slice::from_ref(&new)).is_empty());
        // Um desfecho que confirma atrasado, dentro da folga, ainda avisa.
        let late = recording(
            "atrasado",
            "transcribed",
            Some(("done", None, "2026-10-01T12:00:02Z")),
        );
        assert_eq!(mark.take(&[late]).len(), 1);
        // O resumo refeito depois é outro desfecho.
        let redone = recording(
            "novo",
            "transcribed",
            Some(("done", None, "2026-10-01T12:30:00Z")),
        );
        assert_eq!(mark.take(&[redone]).len(), 1);
        assert_eq!(mark.since, "2026-10-01T12:29:00Z");
        assert_eq!(mark.mark, "2026-10-01T12:29:00.000000Z");
        assert!(mark.take(&[new]).is_empty(), "abaixo da marca, não avisa");
    }

    #[test]
    fn a_marca_sobrevive_ao_arquivo() {
        let mut mark = Watermark::starting(instant(T).unwrap());
        mark.take(&[recording(
            "a",
            "transcribed",
            Some(("done", None, "2026-10-01T12:00:01Z")),
        )]);
        let text = serde_json::to_string(&mark).unwrap();
        assert_eq!(serde_json::from_str::<Watermark>(&text).unwrap(), mark);
        // O formato antigo (id → instante em ms) não é uma marca: o cliente recomeça dela.
        assert!(serde_json::from_str::<Watermark>(r#"{"r1": 1727780000000}"#).is_err());
    }
}

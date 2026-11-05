//! A recording's processing outcome, read from the `?since=` listing (contract 2.17.0): summary
//! ready, summary failed, ready without summary, transcript failed or, since 2.22.0, a recording
//! waiting for its owner to name the speakers (`speakers` step in `waiting`). The rule matches the
//! web (`web/src/app/processingWatch.ts`), with the same test cases; the watermark ensures each
//! outcome is notified once, and none before it.

use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::api::{cursor_from, LibraryRecording};

/// Watermark and `?since=` margin: covers a transaction committing after another with a later
/// timestamp (the server's `now()` is the transaction start).
pub const MARGIN_SECS: i64 = 60;
/// How long a notified outcome stays recorded: beyond that, it is already below the watermark.
const KEEP_DAYS: i64 = 7;
/// Skipped step reasons caused by the user (or predating the pipeline): no notification.
const SILENT_REASONS: [&str; 3] = ["cancelled", "summary_deleted", "before_pipeline"];

/// The outcomes that warrant a notification.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    SummaryReady,
    SummaryFailed,
    /// Ready without summary: the step was skipped (reason in [`Ended::reason`]).
    NoSummary,
    TranscriptionFailed,
    /// Waiting for speaker names (the account requires naming); reason in [`Ended::reason`].
    AwaitingSpeakers,
}

/// A recording's outcome, with the time it occurred.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ended {
    pub recording_id: String,
    pub title: String,
    pub outcome: Outcome,
    /// The skipped step reason, in the `PipelineStep.reason` vocabulary.
    pub reason: Option<String>,
    /// `finished_at` of the `summary` step, the waiting `speakers` step or the job.
    pub at: String,
}

/// A listing item's outcome, if its processing ended in a way that warrants a notification.
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
            return Some(ended(
                Outcome::AwaitingSpeakers,
                speakers.reason.as_ref(),
                at,
            ));
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

/// What the client remembers between reads: the next `?since=`, the watermark (outcomes at or
/// before it do not notify) and already notified outcomes above it (id → timestamp).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watermark {
    pub since: String,
    pub mark: String,
    #[serde(default)]
    pub notified: BTreeMap<String, String>,
}

impl Watermark {
    /// The first read: nothing before `now` is notified.
    pub fn starting(now: DateTime<Utc>) -> Self {
        Self {
            since: format(now - Duration::seconds(MARGIN_SECS)),
            mark: format(now),
            notified: BTreeMap::new(),
        }
    }

    /// [`Watermark::starting`] from milliseconds since the Unix epoch.
    pub fn starting_ms(now_ms: i64) -> Self {
        Self::starting(DateTime::from_timestamp_millis(now_ms).unwrap_or_else(Utc::now))
    }

    /// New outcomes from reading `items` (with `?since=` = [`Watermark::since`]), now counted as
    /// notified; advances `since` and the watermark.
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
                ..JobInfo::default()
            }),
            ..recording(id, "failed", None)
        }
    }

    const T: &str = "2026-10-01T12:00:00Z";

    #[test]
    fn four_outcomes_and_those_without_notifications() {
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
        // Cancellation, deleting the summary during generation and an ongoing recording do not
        // notify.
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
    fn recording_waiting_for_speakers_notifies() {
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
        // Once released, the completed step is no longer a waiting outcome.
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
    fn watermark_notifies_once_and_nothing_earlier() {
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
        // Reappearing (edited title) does not repeat the notification.
        assert!(mark.take(std::slice::from_ref(&new)).is_empty());
        // An outcome committing late, within the margin, still notifies.
        let late = recording(
            "atrasado",
            "transcribed",
            Some(("done", None, "2026-10-01T12:00:02Z")),
        );
        assert_eq!(mark.take(&[late]).len(), 1);
        // A summary regenerated later is another outcome.
        let redone = recording(
            "novo",
            "transcribed",
            Some(("done", None, "2026-10-01T12:30:00Z")),
        );
        assert_eq!(mark.take(&[redone]).len(), 1);
        assert_eq!(mark.since, "2026-10-01T12:29:00Z");
        assert_eq!(mark.mark, "2026-10-01T12:29:00.000000Z");
        assert!(mark.take(&[new]).is_empty(), "below watermark, no notice");
    }

    #[test]
    fn watermark_survives_file_round_trip() {
        let mut mark = Watermark::starting(instant(T).unwrap());
        mark.take(&[recording(
            "a",
            "transcribed",
            Some(("done", None, "2026-10-01T12:00:01Z")),
        )]);
        let text = serde_json::to_string(&mark).unwrap();
        assert_eq!(serde_json::from_str::<Watermark>(&text).unwrap(), mark);
        // The old format (id → timestamp in ms) is not a watermark: the client restarts from it.
        assert!(serde_json::from_str::<Watermark>(r#"{"r1": 1727780000000}"#).is_err());
    }
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { Schemas } from "../../api/client";
import { api } from "../../api/client";
import { ApiError, errorMessage, unwrap } from "../../api/problem";
import { ConfirmDialog } from "../../app/ConfirmDialog";
import { AUTO_LANGUAGE } from "../../lib/languages";
import { LanguageSelect } from "../../shared/LanguageSelect";
import { recordingKey } from "./queries";

type Recording = Schemas["Recording"];
type RetranscribeBody = Schemas["RetranscribeRequest"];

/** Retranscribe (one revision up), with the requested language or the recording's. */
function useRetranscribe(recording: Recording) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body?: RetranscribeBody) =>
      unwrap(
        api.POST("/api/v1/recordings/{recording_id}/retranscribe", {
          params: { path: { recording_id: recording.id } },
          ...(body && Object.keys(body).length > 0 ? { body } : {}),
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(recordingKey(recording.id), updated);
      void queryClient.invalidateQueries({ queryKey: ["recordings"] });
    },
  });
}

/** The duplicate-request 409 put into words; the rest through `errorMessage`. */
function retranscribeError(error: unknown): string {
  return error instanceof ApiError && error.status === 409
    ? "Já há uma transcrição em andamento."
    : errorMessage(error);
}

/**
 * Retry the transcription that failed (retranscribe, one revision up). Every recording the account
 * sees is its own (the contract's `owner` is obsolete); the transient failure (lost worker, vanished job,
 * lack of VRAM) is stated as such, and a 403/404 from the route shows through `errorMessage`.
 */
export function RetryTranscription({ recording }: { recording: Recording }) {
  const retry = useRetranscribe(recording);

  if (recording.status !== "failed" || recording.audio_deleted_at) return null;
  const cancelled = recording.job?.error?.code === "cancelled";
  const retryable = recording.job?.error?.retryable === true;
  return (
    <div role="group" aria-label="Retentar a transcrição">
      <p className="text-muted">
        {cancelled
          ? "Você cancelou a transcrição: pode transcrever de novo quando quiser."
          : retryable
            ? "A falha foi passageira: tentar de novo costuma resolver."
            : "Você pode tentar de novo com a configuração atual."}
      </p>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={retry.isPending}
        onClick={() => retry.mutate()}
      >
        {retry.isPending
          ? "Enfileirando…"
          : cancelled
            ? "Transcrever de novo"
            : "Tentar de novo"}
      </button>
      {retry.isError && (
        <p className="alert alert-error" role="alert">
          {retranscribeError(retry.error)}
        </p>
      )}
    </div>
  );
}

/**
 * Transcrever de novo em…: the owner picks the language at any time (with no open job), and the
 * confirmation says what changes in the new revision.
 */
export function RetranscribeAction({ recording }: { recording: Recording }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [language, setLanguage] = useState(
    () => recording.language?.split("-", 1)[0] ?? AUTO_LANGUAGE,
  );
  const [minSpeakers, setMinSpeakers] = useState("");
  const [maxSpeakers, setMaxSpeakers] = useState("");
  const retranscribe = useRetranscribe(recording);

  if (
    (recording.status !== "transcribed" && recording.status !== "failed") ||
    recording.audio_deleted_at
  )
    return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setOpen(true)}
      >
        Transcrever de novo em…
      </button>
      {open && (
        <ConfirmDialog
          title="Transcrever de novo?"
          confirmLabel="Transcrever de novo"
          busy={retranscribe.isPending}
          onCancel={() => setOpen(false)}
          onConfirm={() =>
            retranscribe.mutate(
              {
                ...(language ? { language } : {}),
                ...(minSpeakers ? { min_speakers: Number(minSpeakers) } : {}),
                ...(maxSpeakers ? { max_speakers: Number(maxSpeakers) } : {}),
              },
              { onSuccess: () => setOpen(false) },
            )
          }
        >
          <div className="field">
            <label htmlFor={id}>Idioma</label>
            <LanguageSelect
              id={id}
              value={language}
              onChange={setLanguage}
              disabled={retranscribe.isPending}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-min`}>Mínimo de locutores</label>
            <input
              id={`${id}-min`}
              className="input"
              type="number"
              min={1}
              value={minSpeakers}
              onChange={(e) => setMinSpeakers(e.target.value)}
              disabled={retranscribe.isPending}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-max`}>Máximo de locutores</label>
            <input
              id={`${id}-max`}
              className="input"
              type="number"
              min={1}
              value={maxSpeakers}
              onChange={(e) => setMaxSpeakers(e.target.value)}
              disabled={retranscribe.isPending}
            />
            <span className="field-hint">
              Vazios, valem os limites da plataforma; a nota de voz usa um
              locutor.
            </span>
          </div>
          <p>
            A transcrição é refeita numa revisão nova: as correções de texto
            feitas à mão se perdem, as pessoas ligadas aos locutores voltam e os
            campos, o tipo de agenda e o resumo são refeitos.
          </p>
          {retranscribe.isError && (
            <p className="alert alert-error" role="alert">
              {retranscribeError(retranscribe.error)}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

/**
 * In place of the player and the transcribe-again actions when retention deleted the audio: the
 * transcript, the summary and the chat remain, and the notice says what ceased to exist.
 */
export function AudioDeletedNotice() {
  return (
    <p className="alert alert-warning" role="status">
      O áudio desta gravação foi apagado pela política de retenção. A transcrição e o resumo continuam aqui, mas não
      dá para ouvir a gravação nem transcrever de novo.
    </p>
  );
}

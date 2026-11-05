---
title: Your account and who sees your recordings
topic: comecar
pages: [biblioteca, ajuda, conta]
related: [first-recording, voice-suggestions]
terms: [account, privacy, who sees, where data goes, data, external agent, voice samples, administrator, consent, notice, sign-up, password, change password, forgot password, reset password, delete account, limit, quota, storage]
order: 6
updated: 2026-10-01
---
Each eclume account is a space of its own.

## What is only yours

Inside eclume, your recordings, transcripts, summaries, people, fields and agenda types show only to
you. There is no sharing between accounts: another person with an account on this server sees nothing
of yours, and you see nothing of theirs.

## Where your data goes

The audio and the transcript are kept on this server. What turns audio into text is the transcription
that whoever administers the server configured: usually on the server itself, but it can be another
machine. Summaries, fields, chat and agenda type detection are done by an AI agent that whoever
administers chose: it may run on the server, on the local network or outside it, on an external
service. In that last case, the transcript text (not the audio) goes to that provider.

In **My settings › Account › Privacy and data** you see, for this server, where each step is done
and who processes what comes out, plus how many voiceprints and voice samples your account keeps.
With voice identification on at the server, you can turn off **Keep voice samples for this account**:
after you confirm, the samples, voiceprints and voice-based person suggestions are erased right
away, and nothing of the account's voice is computed or kept on the next recordings. Speakers already
linked to people stay linked.

## What whoever administers the server does

Whoever administers the server takes care of the service's configuration and health: transcription,
agents, audio preprocessing, voice identification and the agenda types each new account receives. The
administration panel has its own login and shows no titles, transcripts or summaries: it shows only
usage numbers for each account. Whoever administers can also delete an account, with everything in it.

## Usage limits

Each account has limits, set by whoever administers the server: the total space of the recordings,
the size of a file, how many files upload at the same time, how many minutes of audio are transcribed
in 24 hours and how many agent requests (summaries, adjustments and questions) fit in 24 hours. When
a limit is reached, eclume says which. Going past the audio minutes loses nothing: the recording
waits in the queue until the 24-hour window opens. Files from several people take turns at
transcription, one from each account at a time.

## The notice you accepted

When creating the account, you accepted the notice "I am responsible for asking the people I record
for their consent". eclume does not record each person's consent: agree with them before recording
and respect whoever asks not to be recorded.

## Change the password

In **My settings › Account** (the gear at the top), enter the current password and the new one twice.
The new one needs at least 12 characters. When you change it, the other open sessions of this account
(other browsers) are ended. With **Also end devices and tokens** ticked (the default), the desktop and
phone apps linked to the account and the access tokens stop being valid, and each device asks for
sign-in again: this is what suits when you suspect the password leaked. Unticked, devices and tokens
stay valid and are revoked one by one in [Access tokens](/tokens).

## Forgot the password

eclume does not send email. Ask whoever administers the server for a link to reset the password:
they confirm it is you and hand over the link outside the app (in person, by phone or by message). The
link is valid for 24 hours and once only, and a new link cancels the previous one. When you open it,
you see the account's email and type the new password twice, with at least 12 characters; then sign
in with it. Using the link ends all open sessions of this account, in any browser. The desktop and
phone apps and the access tokens stay valid; if you suspect improper access, revoke them in
[Access tokens](/tokens). Whoever administers never sees or sets your password.

## Delete the account

On the same screen, **Delete my account** erases forever everything of yours on this server:
recordings and audio, transcripts, summaries, people and voiceprints, collections, tags, fields,
agenda types, tokens and linked devices. To confirm, type your password and tick that you understand
everything will be erased. It cannot be undone: if you want to keep something, export the recordings
first. See [Export the transcript and the summary](/ajuda/export).

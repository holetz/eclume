-- Expand: partial index for the scans and the queue, which only look at what is in progress
-- (`queued`/`running`); the table grows with the history of `succeeded`/`failed`/`canceled`.
-- No CONCURRENTLY: the migrator runs each file in a transaction.
CREATE INDEX IF NOT EXISTS transcription_jobs_open_state_idx ON transcription_jobs (state) WHERE state IN ('queued', 'running');

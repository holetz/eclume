-- 016_origem_mobile — the mobile app as an audio source (holetz/eclume#41).
--
-- `source` gains `mobile`: the phone records and uploads through the desktop's same resumable upload, and the
-- `recorded_at_source` rule treats it like the desktop (capture clock). Contract in
-- docs/standards/api/contrato-v1.md.

ALTER TABLE recordings DROP CONSTRAINT recordings_source_check;
ALTER TABLE recordings
    ADD CONSTRAINT recordings_source_check CHECK (source IN ('desktop', 'mobile', 'upload', 'api'));

-- 016_origem_mobile — o app móvel como origem do áudio (holetz/eclume#41).
--
-- `source` ganha `mobile`: o celular grava e sobe pelo mesmo upload retomável do desktop, e a
-- regra de `recorded_at_source` o trata como o desktop (relógio da captura). Contrato em
-- docs/standards/api/contrato-v1.md.

ALTER TABLE recordings DROP CONSTRAINT recordings_source_check;
ALTER TABLE recordings
    ADD CONSTRAINT recordings_source_check CHECK (source IN ('desktop', 'mobile', 'upload', 'api'));

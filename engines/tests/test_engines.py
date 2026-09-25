import sys

import pytest

import eclume_engines
from eclume_engines import EngineOptions, UnknownEngineError, get_engine
from eclume_engines.base import EngineError, is_oom


def test_pacote_importa_com_versao():
    assert eclume_engines.__version__ == "0.1.0"


def test_importar_o_pacote_nao_carrega_dependencia_pesada():
    for pesado in ("torch", "whisperx", "faster_whisper", "ctranslate2"):
        assert pesado not in sys.modules


def test_opcoes_a_partir_do_dict_do_job():
    opts = EngineOptions.from_mapping(
        {
            "language": "pt",
            "engine": "whisperx-local",
            "model": "large-v3-turbo",
            "compute_type": None,
            "min_speakers": "2",
            "max_speakers": 4,
            "diarize": False,
            "embeddings": False,
        }
    )
    assert opts == EngineOptions(
        language="pt",
        model="large-v3-turbo",
        compute_type=None,
        diarize=False,
        embeddings=False,
        min_speakers=2,
        max_speakers=4,
    )


def test_opcoes_vazias_usam_os_padroes():
    assert EngineOptions.from_mapping(None) == EngineOptions()
    assert EngineOptions.from_mapping({}).language == "pt"


def test_fabrica_recusa_engine_desconhecida():
    with pytest.raises(UnknownEngineError, match="desconhecida"):
        get_engine("nao-existe")


def test_engine_error_carrega_o_codigo():
    err = EngineError("asr_failed", "falhou")
    assert err.code == "asr_failed"
    assert str(err) == "falhou"


@pytest.mark.parametrize(
    ("mensagem", "esperado"),
    [
        ("CUDA out of memory. Tried to allocate 20.00 MiB", True),
        ("CUDA failed with error out of memory", True),
        ("RuntimeError: shape mismatch", False),
    ],
)
def test_reconhece_oom(mensagem: str, *, esperado: bool):
    assert is_oom(RuntimeError(mensagem)) is esperado

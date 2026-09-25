import eclume_engines
import eclume_server


def test_pacote_importa_e_enxerga_a_interface_de_engine():
    assert eclume_server.__version__ == "0.1.0"
    assert eclume_engines.__version__ == "0.1.0"

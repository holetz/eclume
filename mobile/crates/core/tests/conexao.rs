//! A ligação com o servidor pelos três caminhos, com transportes roteirizados.

mod comum;

use std::sync::Arc;

use comum::{dirs_temp, json, Roteiro, TransportesFalsos, CA_PEM, CA_SHA256};
use eclume_mobile_core::conexao::{Conexao, EstadoConexao};
use eclume_mobile_core::config::Config;

const URL: &str = "https://eclume.test:8443";

fn servidor_ok(roteiro: &Roteiro) {
    roteiro.responde(
        "GET",
        "/api/v1/server",
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": CA_SHA256,
                "version": "0.5.0", "contract_version": "2.3.0"}),
        ),
    );
}

fn credencial() -> comum::Resposta {
    json(
        201,
        serde_json::json!({
            "token": {"id": "t1", "name": "Pixel 8"},
            "secret": "eclp_segredo",
            "server": {"name": "eclume", "url": URL, "ca_sha256": CA_SHA256}
        }),
    )
}

#[test]
fn endereco_digitado_confere_confia_e_entra() {
    let (dirs, _guard) = dirs_temp("endereco");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, CA_PEM),
    );
    servidor_ok(&roteiro);
    roteiro.responde("POST", "/api/v1/devices/login", credencial());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let mut conexao = Conexao::new(dirs.clone(), Arc::new(TransportesFalsos(roteiro.clone())));
    assert_eq!(conexao.estado(&config), EstadoConexao::SemServidor);

    conexao.conectar_endereco("eclume.test:8443").unwrap();
    let EstadoConexao::ConfirmarCa { url, impressao } = conexao.estado(&config) else {
        panic!("esperava a conferência da CA");
    };
    assert_eq!(url, URL);
    assert!(impressao.starts_with("B36A 3527"), "{impressao}");
    // Nada é gravado antes de "Confiar".
    assert!(!dirs.ca().exists());

    conexao.confiar_ca(&mut config).unwrap();
    assert!(dirs.ca().exists());
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::SemCredencial { .. }
    ));
    assert_eq!(
        Config::carregar(&dirs.config()).unwrap().servidor,
        config.servidor
    );

    conexao.entrar(&config, "ana@eclume.test", "senha").unwrap();
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::Conectado { .. }
    ));
    assert_eq!(conexao.token().unwrap().as_deref(), Some("eclp_segredo"));
    let login = roteiro.pedido("POST", "/api/v1/devices/login").unwrap();
    let corpo: serde_json::Value = serde_json::from_slice(&login.body).unwrap();
    assert_eq!(corpo["device_name"], "Pixel 8");

    // 401 numa chamada autenticada: volta a Entrar, sem apagar o servidor.
    conexao.perdeu_credencial().unwrap();
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::SemCredencial { .. }
    ));
    assert_eq!(conexao.token().unwrap(), None);

    conexao.sair(&mut config).unwrap();
    assert_eq!(conexao.estado(&config), EstadoConexao::SemServidor);
    assert!(!dirs.ca().exists());
}

#[test]
fn descoberto_com_ca_diferente_da_anunciada_e_recusado() {
    let (dirs, _guard) = dirs_temp("descoberto");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, CA_PEM),
    );
    let config = Config::default();
    let mut conexao = Conexao::new(dirs, Arc::new(TransportesFalsos(roteiro)));
    let erro = conexao
        .conectar_descoberto(URL, Some(&"00".repeat(32)))
        .unwrap_err();
    assert!(format!("{erro:#}").contains("não confere"), "{erro:#}");
    assert_eq!(conexao.estado(&config), EstadoConexao::SemServidor);

    // Com a CA anunciada certa, a pessoa ainda confere antes de mandar a senha.
    conexao.conectar_descoberto(URL, Some(CA_SHA256)).unwrap();
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::ConfirmarCa { .. }
    ));
    conexao.cancelar_ca();
    assert_eq!(conexao.estado(&config), EstadoConexao::SemServidor);
}

#[test]
fn qr_pareia_sem_senha_e_sem_conferencia() {
    let (dirs, _guard) = dirs_temp("qr");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, CA_PEM),
    );
    servidor_ok(&roteiro);
    roteiro.responde("POST", "/api/v1/devices/pair", credencial());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let mut conexao = Conexao::new(dirs, Arc::new(TransportesFalsos(roteiro.clone())));
    conexao
        .parear(
            &mut config,
            &format!("{URL}/parear?codigo=K7Q4MX&ca={CA_SHA256}"),
        )
        .unwrap();
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::Conectado { .. }
    ));
    let par = roteiro.pedido("POST", "/api/v1/devices/pair").unwrap();
    let corpo: serde_json::Value = serde_json::from_slice(&par.body).unwrap();
    assert_eq!(corpo["code"], "K7Q4MX");

    assert!(conexao
        .parear(&mut config, "https://outro.site/qualquer")
        .is_err());
}

#[test]
fn token_fica_em_memoria_ate_sair_ou_ser_recusado() {
    let (dirs, _guard) = dirs_temp("token-memoria");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, CA_PEM),
    );
    servidor_ok(&roteiro);
    roteiro.responde("POST", "/api/v1/devices/pair", credencial());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let transportes = Arc::new(TransportesFalsos(roteiro));
    let mut conexao = Conexao::new(dirs.clone(), transportes.clone());
    conexao
        .parear(
            &mut config,
            &format!("{URL}/parear?codigo=K7Q4MX&ca={CA_SHA256}"),
        )
        .unwrap();
    assert!(dirs.token().exists());

    // Aberta de novo, a conexão lê o arquivo uma vez; depois, o estado não volta ao disco.
    let mut reaberta = Conexao::new(dirs.clone(), transportes);
    std::fs::remove_file(dirs.token()).unwrap();
    assert!(matches!(
        reaberta.estado(&config),
        EstadoConexao::Conectado { .. }
    ));
    assert_eq!(reaberta.token().unwrap().as_deref(), Some("eclp_segredo"));

    // Um 401 esquece o token da memória.
    reaberta.perdeu_credencial().unwrap();
    assert!(matches!(
        reaberta.estado(&config),
        EstadoConexao::SemCredencial { .. }
    ));
    assert_eq!(reaberta.token().unwrap(), None);

    // Sair também.
    assert_eq!(conexao.token().unwrap().as_deref(), Some("eclp_segredo"));
    conexao.sair(&mut config).unwrap();
    assert_eq!(conexao.token().unwrap(), None);
    assert_eq!(conexao.estado(&config), EstadoConexao::SemServidor);
}

#[test]
fn ca_trocada_no_servidor_e_recusada_ao_confiar() {
    let (dirs, _guard) = dirs_temp("ca-trocada");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, CA_PEM),
    );
    roteiro.responde(
        "GET",
        "/api/v1/server",
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": "11".repeat(32)}),
        ),
    );
    let mut config = Config::default();
    let mut conexao = Conexao::new(dirs.clone(), Arc::new(TransportesFalsos(roteiro)));
    conexao.conectar_endereco(URL).unwrap();
    let erro = conexao.confiar_ca(&mut config).unwrap_err();
    assert!(format!("{erro:#}").contains("mudou"), "{erro:#}");
    assert_eq!(config.servidor, None);
    // A raiz recusada não fica no lugar da CA fixada (nem a provisória).
    assert!(!dirs.ca().exists());
    assert!(!dirs.ca().with_extension("pem.novo").exists());
}

#[test]
fn qr_sem_ca_espera_a_conferencia_antes_do_codigo() {
    let (dirs, _guard) = dirs_temp("qr-sem-ca");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, CA_PEM),
    );
    servidor_ok(&roteiro);
    roteiro.responde("POST", "/api/v1/devices/pair", credencial());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let mut conexao = Conexao::new(dirs.clone(), Arc::new(TransportesFalsos(roteiro.clone())));
    let pareou = conexao
        .parear(&mut config, &format!("{URL}/parear?codigo=K7Q4MX"))
        .unwrap();
    assert!(!pareou);
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::ConfirmarCa { .. }
    ));
    assert!(roteiro.pedido("POST", "/api/v1/devices/pair").is_none());
    assert!(!dirs.ca().exists());

    assert!(conexao.confiar_ca(&mut config).unwrap());
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::Conectado { .. }
    ));
    let par = roteiro.pedido("POST", "/api/v1/devices/pair").unwrap();
    let corpo: serde_json::Value = serde_json::from_slice(&par.body).unwrap();
    assert_eq!(corpo["code"], "K7Q4MX");
}

#[test]
fn login_recusado_mostra_o_motivo() {
    let (dirs, _guard) = dirs_temp("recusado");
    let roteiro = Roteiro::default();
    roteiro.responde(
        "GET",
        "/downloads/eclume-root.crt",
        comum::texto(200, CA_PEM),
    );
    servidor_ok(&roteiro);
    roteiro.responde(
        "POST",
        "/api/v1/devices/login",
        json(
            401,
            serde_json::json!({"title": "Credenciais inválidas", "status": 401}),
        ),
    );
    let mut config = Config::default();
    let mut conexao = Conexao::new(dirs, Arc::new(TransportesFalsos(roteiro)));
    conexao.conectar_endereco(URL).unwrap();
    conexao.confiar_ca(&mut config).unwrap();
    let erro = conexao
        .entrar(&config, "ana@eclume.test", "errada")
        .unwrap_err();
    assert!(format!("{erro:#}").contains("E-mail ou senha"), "{erro:#}");
    assert!(matches!(
        conexao.estado(&config),
        EstadoConexao::SemCredencial { .. }
    ));
}

//! The link with the server through the three paths, with scripted transports.

mod common;

use std::sync::Arc;

use common::{json, temp_dirs, FakeTransports, Script, CA_PEM, CA_SHA256};
use eclume_mobile_core::config::Config;
use eclume_mobile_core::connection::{Connection, ConnectionState};

const URL: &str = "https://eclume.test:8443";

fn server_ok(script: &Script) {
    script.reply(
        "GET",
        "/api/v1/server",
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": CA_SHA256,
                "version": "0.5.0", "contract_version": "2.3.0"}),
        ),
    );
}

fn credential() -> common::Reply {
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
fn typed_address_checks_trusts_and_signs_in() {
    let (dirs, _guard) = temp_dirs("endereco");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, CA_PEM),
    );
    server_ok(&script);
    script.reply("POST", "/api/v1/devices/login", credential());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let mut connection = Connection::new(dirs.clone(), Arc::new(FakeTransports(script.clone())));
    assert_eq!(connection.state(&config), ConnectionState::NoServer);

    connection.connect_address("eclume.test:8443").unwrap();
    let ConnectionState::ConfirmCa { url, fingerprint } = connection.state(&config) else {
        panic!("expected the CA check");
    };
    assert_eq!(url, URL);
    assert!(fingerprint.starts_with("B36A 3527"), "{fingerprint}");
    // Nothing is written before "Confiar".
    assert!(!dirs.ca().exists());

    connection.trust_ca(&mut config).unwrap();
    assert!(dirs.ca().exists());
    assert!(matches!(
        connection.state(&config),
        ConnectionState::NoCredential { .. }
    ));
    assert_eq!(Config::load(&dirs.config()).unwrap().server, config.server);

    connection
        .sign_in(&config, "ana@eclume.test", "senha")
        .unwrap();
    assert!(matches!(
        connection.state(&config),
        ConnectionState::Connected { .. }
    ));
    assert_eq!(connection.token().unwrap().as_deref(), Some("eclp_segredo"));
    let login = script.request("POST", "/api/v1/devices/login").unwrap();
    let body: serde_json::Value = serde_json::from_slice(&login.body).unwrap();
    assert_eq!(body["device_name"], "Pixel 8");

    // A 401 on an authenticated call: back to sign-in, without deleting the server.
    connection.credential_lost().unwrap();
    assert!(matches!(
        connection.state(&config),
        ConnectionState::NoCredential { .. }
    ));
    assert_eq!(connection.token().unwrap(), None);

    connection.sign_out(&mut config).unwrap();
    assert_eq!(connection.state(&config), ConnectionState::NoServer);
    assert!(!dirs.ca().exists());
}

#[test]
fn discovered_with_a_ca_other_than_announced_is_refused() {
    let (dirs, _guard) = temp_dirs("descoberto");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, CA_PEM),
    );
    let config = Config::default();
    let mut connection = Connection::new(dirs, Arc::new(FakeTransports(script)));
    let err = connection
        .connect_discovered(URL, Some(&"00".repeat(32)))
        .unwrap_err();
    assert!(format!("{err:#}").contains("não confere"), "{err:#}");
    assert_eq!(connection.state(&config), ConnectionState::NoServer);

    // With the right announced CA, the person still checks before sending the password.
    connection.connect_discovered(URL, Some(CA_SHA256)).unwrap();
    assert!(matches!(
        connection.state(&config),
        ConnectionState::ConfirmCa { .. }
    ));
    connection.cancel_ca();
    assert_eq!(connection.state(&config), ConnectionState::NoServer);
}

#[test]
fn qr_pairs_without_password_or_check() {
    let (dirs, _guard) = temp_dirs("qr");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, CA_PEM),
    );
    server_ok(&script);
    script.reply("POST", "/api/v1/devices/pair", credential());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let mut connection = Connection::new(dirs, Arc::new(FakeTransports(script.clone())));
    connection
        .pair(
            &mut config,
            &format!("{URL}/parear?codigo=K7Q4MX&ca={CA_SHA256}"),
        )
        .unwrap();
    assert!(matches!(
        connection.state(&config),
        ConnectionState::Connected { .. }
    ));
    let pair = script.request("POST", "/api/v1/devices/pair").unwrap();
    let body: serde_json::Value = serde_json::from_slice(&pair.body).unwrap();
    assert_eq!(body["code"], "K7Q4MX");

    assert!(connection
        .pair(&mut config, "https://outro.site/qualquer")
        .is_err());
}

#[test]
fn token_stays_in_memory_until_sign_out_or_refusal() {
    let (dirs, _guard) = temp_dirs("token-memoria");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, CA_PEM),
    );
    server_ok(&script);
    script.reply("POST", "/api/v1/devices/pair", credential());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let transports = Arc::new(FakeTransports(script));
    let mut connection = Connection::new(dirs.clone(), transports.clone());
    connection
        .pair(
            &mut config,
            &format!("{URL}/parear?codigo=K7Q4MX&ca={CA_SHA256}"),
        )
        .unwrap();
    assert!(dirs.token().exists());

    // Opened again, the connection reads the file once; afterwards, the state does not go back to
    // disk.
    let mut reopened = Connection::new(dirs.clone(), transports);
    std::fs::remove_file(dirs.token()).unwrap();
    assert!(matches!(
        reopened.state(&config),
        ConnectionState::Connected { .. }
    ));
    assert_eq!(reopened.token().unwrap().as_deref(), Some("eclp_segredo"));

    // A 401 forgets the token from memory.
    reopened.credential_lost().unwrap();
    assert!(matches!(
        reopened.state(&config),
        ConnectionState::NoCredential { .. }
    ));
    assert_eq!(reopened.token().unwrap(), None);

    // So does signing out.
    assert_eq!(connection.token().unwrap().as_deref(), Some("eclp_segredo"));
    connection.sign_out(&mut config).unwrap();
    assert_eq!(connection.token().unwrap(), None);
    assert_eq!(connection.state(&config), ConnectionState::NoServer);
}

#[test]
fn root_served_with_two_certificates_writes_only_the_first() {
    let other = include_str!("../../../../server/tests/fixtures/ca-test.pem");
    let (dirs, _guard) = temp_dirs("ca-a-mais");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, &format!("{CA_PEM}{other}")),
    );
    server_ok(&script);
    let mut config = Config::default();
    let mut connection = Connection::new(dirs.clone(), Arc::new(FakeTransports(script)));
    connection.connect_address(URL).unwrap();
    connection.trust_ca(&mut config).unwrap();
    let ca = std::fs::read_to_string(dirs.ca()).unwrap();
    assert_eq!(ca.matches("BEGIN CERTIFICATE").count(), 1, "{ca}");
    assert_eq!(ca, CA_PEM);
}

#[test]
fn ca_swapped_on_the_server_is_refused_on_trust() {
    let (dirs, _guard) = temp_dirs("ca-trocada");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, CA_PEM),
    );
    script.reply(
        "GET",
        "/api/v1/server",
        json(
            200,
            serde_json::json!({"name": "eclume", "url": URL, "ca_sha256": "11".repeat(32)}),
        ),
    );
    let mut config = Config::default();
    let mut connection = Connection::new(dirs.clone(), Arc::new(FakeTransports(script)));
    connection.connect_address(URL).unwrap();
    let err = connection.trust_ca(&mut config).unwrap_err();
    assert!(format!("{err:#}").contains("mudou"), "{err:#}");
    assert_eq!(config.server, None);
    // The refused root does not take the pinned CA's place (nor does the provisional one).
    assert!(!dirs.ca().exists());
    assert!(!dirs.ca().with_extension("pem.novo").exists());
}

#[test]
fn qr_without_ca_waits_for_the_check_before_the_code() {
    let (dirs, _guard) = temp_dirs("qr-sem-ca");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, CA_PEM),
    );
    server_ok(&script);
    script.reply("POST", "/api/v1/devices/pair", credential());
    let mut config = Config {
        device_name: "Pixel 8".into(),
        ..Config::default()
    };
    let mut connection = Connection::new(dirs.clone(), Arc::new(FakeTransports(script.clone())));
    let paired = connection
        .pair(&mut config, &format!("{URL}/parear?codigo=K7Q4MX"))
        .unwrap();
    assert!(!paired);
    assert!(matches!(
        connection.state(&config),
        ConnectionState::ConfirmCa { .. }
    ));
    assert!(script.request("POST", "/api/v1/devices/pair").is_none());
    assert!(!dirs.ca().exists());

    assert!(connection.trust_ca(&mut config).unwrap());
    assert!(matches!(
        connection.state(&config),
        ConnectionState::Connected { .. }
    ));
    let pair = script.request("POST", "/api/v1/devices/pair").unwrap();
    let body: serde_json::Value = serde_json::from_slice(&pair.body).unwrap();
    assert_eq!(body["code"], "K7Q4MX");
}

#[test]
fn refused_login_shows_the_reason() {
    let (dirs, _guard) = temp_dirs("recusado");
    let script = Script::default();
    script.reply(
        "GET",
        "/downloads/eclume-root.crt",
        common::text(200, CA_PEM),
    );
    server_ok(&script);
    script.reply(
        "POST",
        "/api/v1/devices/login",
        json(
            401,
            serde_json::json!({"title": "Credenciais inválidas", "status": 401}),
        ),
    );
    let mut config = Config::default();
    let mut connection = Connection::new(dirs, Arc::new(FakeTransports(script)));
    connection.connect_address(URL).unwrap();
    connection.trust_ca(&mut config).unwrap();
    let err = connection
        .sign_in(&config, "ana@eclume.test", "errada")
        .unwrap_err();
    assert!(format!("{err:#}").contains("E-mail ou senha"), "{err:#}");
    assert!(matches!(
        connection.state(&config),
        ConnectionState::NoCredential { .. }
    ));
}

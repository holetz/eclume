package io.github.holetz.eclume.movel.gravador

/**
 * A ponte Kotlin → Rust (`src-tauri/src/jni.rs`): o caminho que não depende do WebView estar vivo.
 * A notificação chega ao núcleo por [acao], e o WorkManager sobe as gravações por [syncPendentes].
 * Cada função devolve o JSON do núcleo; um erro vem como `{"erro": "..."}`.
 */
object EclumeCore {
    init {
        System.loadLibrary("eclume_mobile_lib")
    }

    /** `pausar`, `continuar`, `marcar` ou `parar`; devolve o `EstadoApp` depois da ação. */
    @JvmStatic
    external fun acao(nome: String): String

    /** O `EstadoApp` atual. */
    @JvmStatic
    external fun estado(): String

    /**
     * Abre o núcleo com a pasta de dados do app (se preciso), sonda e sobe o que estiver pendente;
     * o JSON diz `sincronizadas`, `falhas` e `interrompido`.
     */
    @JvmStatic
    external fun syncPendentes(base: String): String

    /** Antes do sync do worker: `na_rede`, `pendentes` e `bytes`. */
    @JvmStatic
    external fun sondarPendentes(base: String): String

    /** O callback de rede do sistema: sem o Wi-Fi não medido, o sync em curso para. */
    @JvmStatic
    external fun rede(wifiNaoMedido: Boolean): String

    /** O worker foi parado: o upload para na próxima requisição. */
    @JvmStatic
    external fun interromperSync(): String
}

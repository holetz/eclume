package io.github.holetz.eclume.movel.gravador

import android.Manifest
import android.app.Activity
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class DescobrirArgs {
    var segundos: Int = 10
}

@InvokeArg
class InstaladorArgs {
    lateinit var caminho: String
}

/**
 * O plugin `eclume-gravador`: o que só o sistema faz, pedido pelo Rust do app (`run_mobile_plugin`) ou
 * pela UI (`plugin:eclume-gravador|…`). As permissões `microfone` e `notificacoes` são pedidas pela UI
 * antes de gravar (`request_permissions`).
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microfone"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notificacoes"),
    ],
)
class GravadorPlugin(private val activity: Activity) : Plugin(activity) {
    override fun load(webView: WebView) {
        Conectividade.acompanhar(activity)
        SyncWorker.agendar(activity)
    }

    @Command
    fun iniciarServico(invoke: Invoke) {
        ServicoDeGravacao.iniciar(activity)
        invoke.resolve()
    }

    @Command
    fun atualizarServico(invoke: Invoke) {
        ServicoDeGravacao.atualizar(activity)
        invoke.resolve()
    }

    @Command
    fun pararServico(invoke: Invoke) {
        ServicoDeGravacao.encerrar(activity)
        invoke.resolve()
    }

    /** Procura o servidor por mDNS; devolve os anúncios crus, que o núcleo interpreta. */
    @Command
    fun descobrir(invoke: Invoke) {
        val args = invoke.parseArgs(DescobrirArgs::class.java)
        val servicos = JSArray()
        for (anuncio in Descoberta(activity).procurar(args.segundos)) {
            val txt = JSObject()
            anuncio.txt.forEach { (chave, valor) -> txt.put(chave, valor) }
            servicos.put(JSObject().apply {
                put("nome", anuncio.nome)
                put("txt", txt)
            })
        }
        invoke.resolve(JSObject().apply { put("servicos", servicos) })
    }

    /** Bateria, espaço livre, Wi-Fi não medido, modelo e os recortes de borda a borda (dp). */
    @Command
    fun estadoDoDispositivo(invoke: Invoke) {
        val estado = Dispositivo.ler(activity)
        invoke.resolve(JSObject().apply {
            put("bateria", estado.bateria)
            put("carregando", estado.carregando)
            put("espacoLivre", estado.espacoLivre)
            put("wifiNaoMedido", estado.wifiNaoMedido)
            put("modelo", estado.modelo)
            put("insetTopo", estado.insetTopo.toDouble())
            put("insetBase", estado.insetBase.toDouble())
        })
    }

    /** Abre o instalador do sistema para o APK baixado (`aberto: false` quando antes foi pedir a
     * permissão de instalar de fontes desconhecidas). */
    @Command
    fun abrirInstalador(invoke: Invoke) {
        val args = invoke.parseArgs(InstaladorArgs::class.java)
        val aberto = Atualizador.abrir(activity, args.caminho)
        invoke.resolve(JSObject().apply { put("aberto", aberto) })
    }
}

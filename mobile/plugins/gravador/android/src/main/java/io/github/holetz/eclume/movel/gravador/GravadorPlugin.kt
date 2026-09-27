package io.github.holetz.eclume.movel.gravador

import android.Manifest
import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * O plugin `gravador`: o que só o sistema faz, pedido pelo Rust do app (`run_mobile_plugin`) ou
 * pela UI (`plugin:gravador|…`). As permissões `microfone` e `notificacoes` são pedidas pela UI
 * antes de gravar (`request_permissions`).
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microfone"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notificacoes"),
    ],
)
class GravadorPlugin(private val activity: Activity) : Plugin(activity) {
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
}

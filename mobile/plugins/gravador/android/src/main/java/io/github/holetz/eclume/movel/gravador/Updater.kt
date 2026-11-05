package io.github.holetz.eclume.movel.gravador

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/**
 * Abre o instalador do sistema para o APK que o núcleo baixou pela CA fixada e conferiu pelo
 * SHA-256 do `movel.json`. A mesma keystore garante a instalação por cima; o sistema pede a
 * confirmação da pessoa.
 */
object Atualizador {
    const val TIPO_APK = "application/vnd.android.package-archive"

    /** A autoridade do `FileProvider` do app (`${applicationId}.fileprovider`). */
    fun autoridade(pacote: String): String = "$pacote.fileprovider"

    /**
     * Abre o instalador; sem a permissão de instalar de fontes desconhecidas, abre antes a tela do
     * sistema que a concede. Devolve se o instalador abriu.
     */
    fun abrir(activity: Activity, caminho: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
            )
            return false
        }
        val uri = FileProvider.getUriForFile(activity, autoridade(activity.packageName), File(caminho))
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, TIPO_APK)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        return true
    }
}

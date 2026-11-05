package io.github.holetz.eclume.movel.gravador

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File

/**
 * Opens the system installer for the APK the core downloaded through the pinned CA and checked
 * against the SHA-256 in `movel.json`. The same keystore guarantees the install over the old one;
 * the system asks the person to confirm.
 */
object Updater {
    const val APK_TYPE = "application/vnd.android.package-archive"

    /** The authority of the app's `FileProvider` (`${applicationId}.fileprovider`). */
    fun authority(packageName: String): String = "$packageName.fileprovider"

    /**
     * Opens the installer; without the permission to install from unknown sources, first opens the
     * system screen that grants it. Returns whether the installer opened.
     */
    fun open(activity: Activity, path: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")),
            )
            return false
        }
        val uri = FileProvider.getUriForFile(activity, authority(activity.packageName), File(path))
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, APK_TYPE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        activity.startActivity(intent)
        return true
    }
}

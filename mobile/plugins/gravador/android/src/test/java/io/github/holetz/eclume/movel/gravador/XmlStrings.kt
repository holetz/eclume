package io.github.holetz.eclume.movel.gravador

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * The recorder's real `strings.xml` read on the JVM (no Android resources here): `values` is
 * English, `values-pt-rBR` the translation. Gradle runs the unit tests from the module folder.
 */
object XmlStrings {
    const val EN = "values"
    const val PT_BR = "values-pt-rBR"

    /** The app's resources (the shortcut labels), seen from this module's folder. */
    const val APP_RES = "../../../src-tauri/gen/android/app/src/main/res"

    /** The `<string name>` → text map of one resource folder, with aapt's quotes and escapes undone. */
    fun read(folder: String, res: String = "src/main/res"): Map<String, String> {
        val file = File("$res/$folder/strings.xml")
        val document = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val nodes = document.getElementsByTagName("string")
        return (0 until nodes.length).associate { index ->
            val node = nodes.item(index) as Element
            val text = node.textContent.trim()
            val unquoted = if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text.substring(1, text.length - 1) else text
            node.getAttribute("name") to unquoted.replace("\\'", "'").replace("\\\"", "\"")
        }
    }

    /** A [Strings] over one folder; an unknown name fails the test. */
    fun strings(folder: String): Strings {
        val table = read(folder)
        return Strings { name -> table[name] ?: throw AssertionError("no string $name in $folder") }
    }
}

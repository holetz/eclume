package io.github.holetz.eclume.movel.gravador

/**
 * O atalho "Gravar agora" do ícone (`res/xml/shortcuts.xml` do app): abre a MainActivity com a ação
 * [GRAVAR_AGORA]. Cada toque vale uma vez: a UI o consome por `consumirAtalho`, e um intent que volta
 * pelos recentes (`FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`) não conta.
 */
object Atalho {
    const val GRAVAR_AGORA = "io.github.holetz.eclume.movel.GRAVAR_AGORA"

    /** O `Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`. */
    private const val VEIO_DOS_RECENTES = 0x00100000

    /** Um toque novo no atalho: a ação dele, sem vir dos recentes. */
    fun ehGravarAgora(acao: String?, flags: Int): Boolean =
        acao == GRAVAR_AGORA && (flags and VEIO_DOS_RECENTES) == 0
}

import { Navigate, Route, Routes } from 'react-router'
import { PageHead } from '../../app/PageHead'
import { AgentsPage } from './AgentsPage'
import { HealthPage } from './HealthPage'
import { NotFound } from './NotFound'
import { RequireAdmin } from './RequireAdmin'
import { SecretsPage } from './SecretsPage'
import { ADMIN_KICKER } from './sections'
import { TranscriptionPage } from './TranscriptionPage'
import { UsersPage } from './UsersPage'
import { VoicePage } from './VoicePage'

/** Seção cuja tela depende do contrato da holetz/eclume#33 (pré-processamento, tipos padrão). */
function Pending({ title }: { title: string }) {
  return (
    <>
      <PageHead kicker={ADMIN_KICKER} title={title} />
      <p className="text-muted">Esta tela chega com o processamento automático.</p>
    </>
  )
}

/** Rotas de /admin/*, dentro da guarda da sessão de admin e da moldura do painel. */
export function AdminRoutes() {
  return (
    <Routes>
      <Route element={<RequireAdmin />}>
        <Route index element={<Navigate to="usuarios" replace />} />
        <Route path="usuarios" element={<UsersPage />} />
        <Route path="audio" element={<Pending title="Pré-processamento de áudio" />} />
        <Route path="transcricao" element={<TranscriptionPage />} />
        <Route path="locutores" element={<VoicePage />} />
        <Route path="agentes" element={<AgentsPage />} />
        <Route path="tipos-de-agenda" element={<Pending title="Tipos de agenda padrão" />} />
        <Route path="saude" element={<HealthPage />} />
        {/* Fora da barra até a 2.5 levar os segredos para Locutores e Agentes. */}
        <Route path="segredos" element={<SecretsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

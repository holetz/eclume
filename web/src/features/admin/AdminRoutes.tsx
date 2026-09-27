import { Navigate, Route, Routes } from 'react-router'
import { AdminPageHead } from './AdminPageHead'
import { AgentsPage } from './AgentsPage'
import { AudioPage } from './AudioPage'
import { HealthPage } from './HealthPage'
import { NotFound } from './NotFound'
import { RequireAdmin } from './RequireAdmin'
import { SpeakersPage } from './SpeakersPage'
import { TranscriptionPage } from './TranscriptionPage'
import { UsersPage } from './UsersPage'

/** Seção cuja tela ainda não chegou (tipos de agenda padrão, na 2.6). */
function Pending({ title }: { title: string }) {
  return (
    <>
      <AdminPageHead title={title} />
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
        <Route path="audio" element={<AudioPage />} />
        <Route path="transcricao" element={<TranscriptionPage />} />
        <Route path="locutores" element={<SpeakersPage />} />
        <Route path="agentes" element={<AgentsPage />} />
        <Route path="tipos-de-agenda" element={<Pending title="Tipos de agenda padrão" />} />
        <Route path="saude" element={<HealthPage />} />
        <Route path="voz" element={<Navigate to="/admin/locutores" replace />} />
        {/* O token do Hugging Face trava a transcrição; a chave da Anthropic está em Agentes. */}
        <Route path="segredos" element={<Navigate to="/admin/locutores" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

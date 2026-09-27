import { Navigate, Route, Routes } from 'react-router'
import { AgentsPage } from './AgentsPage'
import { AudioPage } from './AudioPage'
import { DefaultAgendaTypesPage } from './DefaultAgendaTypesPage'
import { HealthPage } from './HealthPage'
import { NotFound } from './NotFound'
import { RequireAdmin } from './RequireAdmin'
import { SpeakersPage } from './SpeakersPage'
import { TranscriptionPage } from './TranscriptionPage'
import { UsersPage } from './UsersPage'

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
        <Route path="tipos-de-agenda" element={<DefaultAgendaTypesPage />} />
        <Route path="saude" element={<HealthPage />} />
        <Route path="templates" element={<Navigate to="/admin/tipos-de-agenda" replace />} />
        <Route path="voz" element={<Navigate to="/admin/locutores" replace />} />
        {/* O token do Hugging Face trava a transcrição; a chave da Anthropic está em Agentes. */}
        <Route path="segredos" element={<Navigate to="/admin/locutores" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

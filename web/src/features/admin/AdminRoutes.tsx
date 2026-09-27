import { Navigate, Route, Routes } from 'react-router'
import { AgentsPage } from './AgentsPage'
import { HealthPage } from './HealthPage'
import { RequireAdmin } from './RequireAdmin'
import { SecretsPage } from './SecretsPage'
import { SettingsPage } from './SettingsPage'
import { UsersPage } from './UsersPage'
import { VoicePage } from './VoicePage'

/** Rotas de /admin/*, dentro da moldura com a guarda da sessão de admin. */
export function AdminRoutes() {
  return (
    <Routes>
      <Route element={<RequireAdmin />}>
        <Route index element={<Navigate to="transcricao" replace />} />
        <Route path="transcricao" element={<SettingsPage />} />
        <Route path="voz" element={<VoicePage />} />
        <Route path="agentes" element={<AgentsPage />} />
        <Route path="usuarios" element={<UsersPage />} />
        <Route path="segredos" element={<SecretsPage />} />
        <Route path="saude" element={<HealthPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
    </Routes>
  )
}

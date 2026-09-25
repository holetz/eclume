import { Navigate, Route, Routes } from 'react-router'
import { AdminLayout } from './AdminLayout'
import { AgentsPage } from './AgentsPage'
import { SettingsPage } from './SettingsPage'
import { TemplatesPage } from './TemplatesPage'

/** Rotas de /admin/*, dentro da moldura com a guarda de papel. */
export function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="transcricao" replace />} />
        <Route path="transcricao" element={<SettingsPage />} />
        <Route path="agentes" element={<AgentsPage />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
    </Routes>
  )
}

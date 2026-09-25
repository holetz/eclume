import { Navigate, Route, Routes } from 'react-router'
import { AdminLayout } from './AdminLayout'

/** Rotas de /admin/*, dentro da moldura com a guarda de papel. */
export function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<Navigate to="transcricao" replace />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>
    </Routes>
  )
}

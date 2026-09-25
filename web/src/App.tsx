import { BrowserRouter, Route, Routes } from 'react-router'
import { AppShell } from './app/AppShell'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          element={<AppShell user={{ name: 'Visitante', email: '', role: 'member' }} onLogout={() => {}} />}
        >
          <Route index element={<h1>Biblioteca</h1>} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App

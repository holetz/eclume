import { Marca } from './Marca.tsx'

/** A casca do app: uma tela do DS (`.m-body`) ocupando o aparelho inteiro. */
export default function App() {
  return (
    <main className="m-app">
      <div className="m-body">
        <div className="m-top">
          <Marca />
        </div>
      </div>
    </main>
  )
}

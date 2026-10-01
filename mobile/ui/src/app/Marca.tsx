/** A marca do DS: as cinco barras do medidor e o nome; `grande` é a da tela de servidor (24 px). */
export function Marca({ grande = false }: { grande?: boolean }) {
  return (
    <span className={grande ? 'brand marca-grande' : 'brand'}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="0.5" y="8" width="3" height="8" />
        <rect x="5.5" y="3" width="3" height="18" />
        <rect x="10.5" y="0" width="3" height="24" />
        <rect x="15.5" y="5.5" width="3" height="13" />
        <rect x="20.5" y="9" width="3" height="6" />
      </svg>
      eclume
    </span>
  )
}

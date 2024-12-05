import React from 'react'
// @ts-expect-error no type
import virtualTest from 'virtual:test'

export function App() {
  const [count, setCount] = React.useState(0)
  return (
    <div>
      <h1>Rolldown SSR</h1>
      <Hydrated />
      <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>
      <pre>[virtual] {virtualTest}</pre>
    </div>
  )
}

function Hydrated() {
  const hydrated = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    () => true,
    () => false,
  )
  return <p>hydrated: {String(hydrated)}</p>
}

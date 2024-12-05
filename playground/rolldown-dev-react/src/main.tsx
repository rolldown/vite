import React from 'react'
import ReactDOMClient from 'react-dom/client'
import { App } from './app'

ReactDOMClient.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

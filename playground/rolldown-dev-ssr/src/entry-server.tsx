import ReactDOMServer from 'react-dom/server'
import type { Connect } from 'vite'
import { App } from './app'
import { throwError } from './error'

const handler: Connect.SimpleHandleFunction = (req, res) => {
  const url = new URL(req.url ?? '/', 'https://vite.dev')
  console.log(`[SSR] ${req.method} ${url.pathname}`)
  if (url.pathname === '/crash-ssr') {
    throwError()
  }
  const ssrHtml = ReactDOMServer.renderToString(<App />)
  res.setHeader('content-type', 'text/html')
  // TODO: transformIndexHtml?
  res.end(`\
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	</head>
	<body>
		<div id="root">${ssrHtml}</div>
		<script src="/entry-client.js"></script>
	</body>
</html>
`)
}

export default handler

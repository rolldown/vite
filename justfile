build-vite:
  pnpm --filter vite run build-bundle

test-serve:
  pnpm run test-serve

test-build:
  pnpm run test-build

test: test-serve test-build

fmt:
  pnpm --filter vite run format

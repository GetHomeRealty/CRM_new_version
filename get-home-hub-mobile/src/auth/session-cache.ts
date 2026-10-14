import { QueryClient } from '@tanstack/react-query';

// Never share a client between authenticated sessions: late mutation callbacks
// must only be able to update the old session's detached cache.
export function createSessionCache() {
  return new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
  });
}

export function disposeSessionCache(client: QueryClient) {
  void client.cancelQueries();
  client.clear();
}

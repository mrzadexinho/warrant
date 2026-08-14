// Not a test file: `vitest.config.ts` collects only `tests/**/*.test.ts`, so this is a helper
// both channel tests import without their suites registering twice.
//
// **Select a route by PATH, never by index.** `channel.routes[0]` is a hand-maintained
// assumption nothing else checks, in a channel that carries two routes. Reordering the array, or
// losing a route, would silently re-point every assertion in a file at a different handler. This
// throws, and it names what it actually found.
import type { HttpRouteDefinition } from 'eve/channels';

export function routeByPath(
  channel: { routes: readonly unknown[] },
  path: string,
): HttpRouteDefinition<undefined> {
  const routes = channel.routes as readonly HttpRouteDefinition<undefined>[];
  const match = routes.filter((r) => r.path === path);
  if (match.length !== 1) {
    throw new Error(
      `expected exactly one route at ${path}, found ${match.length} of ${routes.length}: ` +
        `[${routes.map((r) => `${r.method} ${r.path}`).join(', ')}]`,
    );
  }
  return match[0]!;
}

import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApiDeps } from "./deps";
import { agentRoutes } from "./routes/agents";
import { authRoutes } from "./routes/auth";
import { publicRoutes } from "./routes/public";
import { strategyRoutes } from "./routes/strategy";

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.env.production ? { level: "info" } : { level: "warn" },
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });
  await app.register(cookie, { secret: deps.env.sessionSecret });

  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    req.log.error({ err }, "request failed");
    const code = err.statusCode;
    const status = code && code >= 400 && code < 500 ? code : 500;
    reply.code(status).send({
      error: status === 500 ? "server_error" : "bad_request",
      message: status === 500 ? "Something went wrong. Try again." : (err.message ?? "Bad request."),
    });
  });

  await app.register(
    async (api) => {
      authRoutes(api, deps);
      strategyRoutes(api, deps);
      agentRoutes(api, deps);
      publicRoutes(api, deps);
    },
    { prefix: "/api" },
  );
  return app;
}

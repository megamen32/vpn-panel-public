import type { FastifyInstance } from "fastify";
import { bezWindowsInstallerScript } from "./windows-installer.js";

export type WindowsRouteDependencies = {
  baseUrl: string;
};

/** Register the public bootstrap endpoint for the rootless Windows bez client. */
export function registerWindowsRoutes(app: FastifyInstance, dependencies: WindowsRouteDependencies): void {
  app.get("/install/bez-windows", async (_request, reply) => reply
    .type("text/plain; charset=utf-8")
    .header("cache-control", "no-store")
    .send(bezWindowsInstallerScript(dependencies.baseUrl)));
}

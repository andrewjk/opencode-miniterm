import { OpenCode } from "@opencode/client";
import type { OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";

export type { OpenCodeClient };

export interface Connection {
	client: OpenCodeClient;
	url: string;
}

// Connect to the shared OpenCode background service. V2 runs the service on a
// random port and registers it on disk, so we discover/start it through the
// client's Service helper instead of hardcoding a host and port.
export async function connect(): Promise<Connection> {
	const endpoint = await Service.ensure();
	const headers = Service.headers(endpoint);
	const client = OpenCode.make({ baseUrl: endpoint.url, headers });
	return { client, url: endpoint.url };
}

// V2 scopes most requests to a location (a project directory) instead of the
// V1 per-client directory header. Spread this into endpoints that accept it.
export function locationFor(cwd: string): { location: { directory: string } } {
	return { location: { directory: cwd } };
}

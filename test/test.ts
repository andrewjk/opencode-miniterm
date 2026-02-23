import { spawn } from "child_process";

const AUTH_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";

function getAuthHeaders() {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (AUTH_PASSWORD) {
		const credentials = Buffer.from(`${AUTH_USERNAME}:${AUTH_PASSWORD}`).toString("base64");
		headers["Authorization"] = `Basic ${credentials}`;
	}
	return headers;
}

async function startServer() {
	const server = spawn("opencode", ["serve"], {
		stdio: "pipe",
		shell: true,
		cwd: process.cwd(),
	});

	server.stdout.on("data", (data) => console.log("[stdout]", data.toString()));
	server.stderr.on("data", (data) => console.log("[stderr]", data.toString()));

	console.log("Waiting for server to start...");
	await new Promise((resolve) => setTimeout(resolve, 3000));

	return server;
}

async function main() {
	const server = await startServer();

	try {
		console.log("Creating session...");
		const auth = getAuthHeaders();
		console.log("Auth headers:", {
			...auth,
			Authorization: auth.Authorization?.substring(0, 20) + "...",
		});

		const sessionRes = await fetch("http://127.0.0.1:4096/session", {
			method: "POST",
			headers: auth,
			body: JSON.stringify({}),
		});

		console.log("Session response status:", sessionRes.status);
		const sessionText = await sessionRes.text();
		console.log("Session response:", sessionText);

		if (!sessionRes.ok) {
			throw new Error("Failed to create session");
		}

		const session = JSON.parse(sessionText);
		console.log("Session ID:", session.id);

		console.log("Getting provider config...");
		const providerRes = await fetch("http://127.0.0.1:4096/config/providers", {
			headers: auth,
		});
		const providerText = await providerRes.text();
		console.log("Provider config response status:", providerRes.status);
		console.log("Provider config:", providerText);

		console.log("Sending message with model object, 30 second timeout...");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30000);

		try {
			const requestBody = {
				model: {
					modelID: "big-pickle",
					providerID: "opencode",
				},
				parts: [{ type: "text", text: "hi" }],
			};
			console.log("Request body:", JSON.stringify(requestBody));

			const msgRes = await fetch(`http://127.0.0.1:4096/session/${session.id}/message`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify(requestBody),
				signal: controller.signal,
			});

			clearTimeout(timeout);

			console.log("Message response status:", msgRes.status);
			const msgText = await msgRes.text();
			console.log("Message response:", msgText);
		} catch (error: any) {
			clearTimeout(timeout);
			if (error.name === "AbortError") {
				console.error("Message send timed out after 30 seconds");
			} else {
				console.error("Message send error:", error.message);
			}
		}
	} catch (error: any) {
		console.error("Error:", error.message, error.stack);
	} finally {
		server.kill();
		process.exit(0);
	}
}

main();

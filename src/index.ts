#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { connect, StringCodec, NatsConnection } from "nats";

// Configuration
const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const sc = StringCodec();

// Type definitions
type ToolRequestParams = {
    name: string;
    arguments?: unknown;
    resource?: {
        type?: string;
        id?: string;
        attributes?: Record<string, unknown>;
    };
};

// Schemas
const DeploySchema = z.object({
    user_id: z.string(),
    template_id: z.string(),
    creds: z.any(),
});

const DeleteSchema = z.object({
    server_id: z.string(),
});

const TemplateSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
});

const TemplatesResponseSchema = z.array(TemplateSchema);

// Hardcoded example templates
const templates = [
    { id: "tpl-mongo", name: "MongoDB Server", description: "Basic MongoDB stack" },
    { id: "tpl-gpt", name: "Basic GPT Server", description: "A basic inference stack" },
    { id: "tpl-scraper", name: "Scraper + Storage", description: "Web scraper with data sink" },
];

// Server
const server = new Server(
    {
        name: "tarxan-mcp",
        version: "0.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "deploy",
            description: "Trigger a deploy action via NATS (by ID or name)",
            inputSchema: {
                type: "object",
                properties: {
                    user_id: { type: "string", description: "User ID" },
                    template_id: { type: "string", description: "Template ID (optional if name is given)" },
                    name: { type: "string", description: "Template name (optional if ID is given)" },
                    creds: { type: "object", description: "Credential object" },
                },
                required: ["user_id", "creds"],
            },
        },
        {
            name: "delete",
            description: "Trigger a delete action via NATS",
            inputSchema: {
                type: "object",
                properties: {
                    server_id: { type: "string", description: "Server ID" },
                },
                required: ["server_id"],
            },
        },
        {
            name: "list_templates",
            description: "List available deployment templates",
            inputSchema: {
                type: "object",
                properties: {},
            },
        },
    ],
}));

// Main handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args, resource } = request.params as ToolRequestParams;

    if (!nats) throw new Error("NATS connection not established");

    try {
        if (name === "deploy") {
            const data = args ?? resource?.attributes;
            if (!data) throw new Error("Missing deployment input (arguments or resource)");

            // Try standard schema first
            const parsed = DeploySchema.safeParse(data);

            let payload: z.infer<typeof DeploySchema>;

            if (parsed.success) {
                payload = parsed.data;
            } else {
                // Try to fallback to name-based resolution
                const { name, creds, user_id } = data as any;
                if (!name || !user_id || !creds) {
                    throw new Error(
                        `Invalid arguments: ${parsed.error.errors
                            .map((e) => `${e.path.join(".")}: ${e.message}`)
                            .join(", ")}`
                    );
                }

                const found = templates.find((t) =>
                    t.name.toLowerCase().includes(name.toLowerCase())
                );
                if (!found) throw new Error(`No template found matching name: ${name}`);

                payload = {
                    user_id,
                    template_id: found.id,
                    creds,
                };
            }

            await nats.publish("deploy", sc.encode(JSON.stringify(payload)));

            return {
                content: [
                    {
                        type: "text",
                        text: `Deploy event published for user ${payload.user_id} using template ${payload.template_id}`,
                    },
                ],
            };
        }

        if (name === "delete") {
            const data = args ?? resource?.attributes;
            if (!data) throw new Error("Missing deletion input (arguments or resource)");

            const payload = DeleteSchema.parse(data);
            await nats.publish("delete", sc.encode(JSON.stringify(payload)));

            return {
                content: [
                    {
                        type: "text",
                        text: `Delete event published for server ${payload.server_id}`,
                    },
                ],
            };
        }

        if (name === "list_templates") {
            const validated = TemplatesResponseSchema.parse(templates);
            return {
                content: [
                    {
                        type: "text",
                        text: validated
                            .map(
                                (t) =>
                                    `• ${t.name} (${t.id})${
                                        t.description ? ` – ${t.description}` : ""
                                    }`
                            )
                            .join("\n"),
                    },
                ],
            };
        }

        throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
        if (err instanceof z.ZodError) {
            throw new Error(
                `Invalid arguments: ${err.errors
                    .map((e) => `${e.path.join(".")}: ${e.message}`)
                    .join(", ")}`
            );
        }
        throw err;
    }
});

let nats: NatsConnection;

async function run() {
    console.log(NATS_URL);

    try {
        nats = await connect({ servers: NATS_URL });
        console.error(`[NATS Connected] Connected to ${NATS_URL}`);

        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("[MCP Server] Ready on stdio");
    } catch (err) {
        console.error("[Fatal] MCP server failed to start:", err);
        process.exit(1);
    }
}

process.on("SIGINT", async () => {
    await nats?.drain().catch(() => {});
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await nats?.drain().catch(() => {});
    process.exit(0);
});

run();

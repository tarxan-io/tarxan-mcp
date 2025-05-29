#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { connect, StringCodec, NatsConnection } from "nats";
import mongoose, { Schema, model } from "mongoose";

// Configuration
const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/tarxan";
const sc = StringCodec();

// Mongoose Schema
const TemplateSchema = new Schema({
    name: { type: String, required: true },
    path: { type: String, required: true },
    fields: { type: [String], required: true },
    type: { type: String, required: true },
    sub_type: { type: String, required: false },
    require_subdomain: { type: Boolean, required: true },
    require_custom_subdomain: { type: Boolean, required: true },
    published_at: { type: Date, required: false },
    created_at: { type: Date, required: true, default: Date.now },
    updated_at: { type: Date, required: false },
}, {
    versionKey: false,
    collection: "templates" 
});
  
const TemplateModel = model("Template", TemplateSchema);

// Zod Schemas
const DeploySchema = z.object({
    user_id: z.string(),
    template_id: z.string(),
    creds: z.any(),
});

const DeleteSchema = z.object({
    server_id: z.string(),
});

const ToolRequestSchema = z.object({
    name: z.string(),
    arguments: z.optional(z.any()),
    resource: z.optional(z.object({
        type: z.string().optional(),
        id: z.string().optional(),
        attributes: z.record(z.any()).optional(),
    })),
});

// MCP Server
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

let nats: NatsConnection;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args, resource } = ToolRequestSchema.parse(request.params);
    const data = args ?? resource?.attributes;
    if (!data) throw new Error("Missing input (arguments or resource)");
    if (!nats) throw new Error("NATS connection not established");

    if (name === "deploy") {
        let payload: z.infer<typeof DeploySchema>;
        const parsed = DeploySchema.safeParse(data);

        if (parsed.success) {
            payload = parsed.data;
        } else {
            const { name, creds, user_id } = data as any;
            if (!name || !user_id || !creds) {
                throw new Error(
                    `Invalid arguments: ${parsed.error.errors
                        .map((e) => `${e.path.join(".")}: ${e.message}`)
                        .join(", ")}`
                );
            }

            const found = await TemplateModel.findOne({
                name: { $regex: new RegExp(name, "i") },
            });

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
        const templates = await TemplateModel.find().lean();

        console.log("=========================");
        console.log(JSON.stringify(templates, null, 2));
        console.log("=========================");
        
        return {
            content: [
                {
                    type: "text",
                    text: templates
                        .map((t) => {
                            const id = t._id?.toString();
                            const name = t.name || "(unnamed)";
                            const fields = Array.isArray(t.fields) ? t.fields.join(", ") : "";
                            const type = t.type || "(no type)";
                            const subType = t.sub_type ? ` / ${t.sub_type}` : "";
    
                            return `• ${name} (${id})\n  Type: ${type}${subType}\n  Fields: ${fields}`;
                        })
                        .join("\n\n") || "No templates found.",
                },
            ],
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

async function run() {
    try {
        await mongoose.connect(MONGO_URL);
        console.error(`[MongoDB Connected] ${MONGO_URL}`);

        nats = await connect({ servers: NATS_URL });
        console.error(`[NATS Connected] ${NATS_URL}`);

        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("[MCP Server] Ready on stdio");
    } catch (err) {
        console.error("[Fatal] MCP server failed to start:", err);
        process.exit(1);
    }
}

process.on("SIGINT", async () => {
    await Promise.all([
        nats?.drain().catch(() => {}),
        mongoose.connection.close().catch(() => {}),
    ]);
    process.exit(0);
});

process.on("SIGTERM", async () => {
    await Promise.all([
        nats?.drain().catch(() => {}),
        mongoose.connection.close().catch(() => {}),
    ]);
    process.exit(0);
});

run();

#!/usr/bin/env node

import {ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import {
    AddConversationSubscriptionResponse,
    ClientRequest, InitializeResponse, NewConversationResponse, SendUserMessageResponse, TaskCompleteEvent
} from "../app-server";
import {startCodexConnection} from "../CodexJsonRpcConnection";


async function main() {
    // await startRawCommunication();
    await startJSONRPCCommunication();
}

async function startJSONRPCCommunication() {
    const connection = startCodexConnection();

    const initRequest: Omit<ClientRequest, "id"> = {
        method: "initialize",
        params: {
            clientInfo: {
                name: "CodexConsoleClient",
                version: "0.1.0",
                title: "Sample"
            }
        }
    }

    const initResponse: InitializeResponse = await connection.sendRequest(initRequest.method, initRequest.params)
    console.log(initResponse);

    const newConversationRequest: Omit<ClientRequest, "id"> = {
        method: "newConversation",
        params: {
            model: null,
            modelProvider: null,
            profile: null,
            cwd: null,
            approvalPolicy: null,
            sandbox: null,
            config: null,
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
        }
    }
    const newConversationResponse: NewConversationResponse = await connection.sendRequest(newConversationRequest.method, newConversationRequest.params)
    console.log(newConversationResponse);

    const addListenerRequest: Omit<ClientRequest, "id"> = {
        method: "addConversationListener",
        params: {
            conversationId: newConversationResponse.conversationId
        }
    }
    const subscriptionResponse: AddConversationSubscriptionResponse = await connection.sendRequest(addListenerRequest.method, addListenerRequest.params)
    console.log(subscriptionResponse);

    connection.onNotification("codex/event/task_complete", (event: TaskCompleteEvent) => {
        console.log("[EVENT] Task complete")
        connection.end()
    });

    connection.onNotification("codex/event/conversation_ended", (event: { conversationId: string }) => {})
    connection.onUnhandledNotification((data) => console.log("[UNHANDLED NOTIFICATION]", data))

    const sendUserMessage: Omit<ClientRequest, "id"> = {
        method: "sendUserMessage",
        params: {
            conversationId: newConversationResponse.conversationId,
            items: [
                {
                    type: "text",
                    data: {
                        text: "Hi, who are you??"
                    }
                }
            ]
        }
    }
    const sendUserMessageResponse: SendUserMessageResponse = await connection.sendRequest(sendUserMessage.method, sendUserMessage.params)
    console.log(sendUserMessageResponse);
}

async function startRawCommunication() {
    const codex: ChildProcessWithoutNullStreams = spawn("codex", ["app-server"]);
    codex.stderr.on("data", (data) => {
        console.error("[STDERR]", data.toString());
    });
    codex.stdout.on("data", (data: Buffer) => {
        console.log("[STDOUT]", data.toString());
    });
    codex.stdin.write(`{"method":"initialize","id":"0","params":{"clientInfo":{"name":"CodexConsoleClient","version":"0.1.0","title":"Sample"}}}` + "\n");

    await delay(100);
    codex.stdin.write("{{\n");

    await delay(100);
    codex.stdin.end();
}

function delay(milliseconds: number): Promise<void> {
   return new Promise((r) => setTimeout(r, milliseconds))
}

main().catch(console.error);
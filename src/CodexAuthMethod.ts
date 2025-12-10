
import type {AuthenticateRequest, AuthMethod} from "@agentclientprotocol/sdk";

const ApiKeyAuthMethod: AuthMethod = {
    id: "api-key",
    name: "API Key",
    description: "Use an API key to authenticate"
}

interface ApiKeyAuthRequest extends AuthenticateRequest {
    methodId: "api-key";
    _meta: {
        apiKey: string;
    };
}

const ChatGptAuthMethod: AuthMethod = {
    id: "chat-gpt",
    name: "Chat GPT",
    description: "Use ChatGPT to authenticate"
}

export interface ChatGPTAuthRequest extends AuthenticateRequest {
    methodId: "chat-gpt";
}

export const CodexAuthMethods: AuthMethod[] = [ApiKeyAuthMethod, ChatGptAuthMethod];

export type CodexAuthRequest = ApiKeyAuthRequest | ChatGPTAuthRequest;

export function isCodexAuthRequest(request: AuthenticateRequest): request is CodexAuthRequest {
    return request.methodId === "api-key" || request.methodId === "chat-gpt";
}
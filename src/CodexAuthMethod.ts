
import type {AuthenticateRequest, AuthMethod} from "@agentclientprotocol/sdk";

const ApiKeyAuthMethod: AuthMethod = {
    id: "api-key",
    name: "API Key",
    description: "Use an API key to authenticate",
    _meta: {
        "api-key": {
            provider: "openai"
        }
    }
}

interface ApiKeyAuthRequest extends AuthenticateRequest {
    methodId: "api-key";
    _meta: {
        "api-key": {
            apiKey: string;
        }
    };
}

const ChatGptAuthMethod: AuthMethod = {
    id: "chat-gpt",
    name: "ChatGPT",
    description: "Use ChatGPT to authenticate"
}

export interface ChatGPTAuthRequest extends AuthenticateRequest {
    methodId: "chat-gpt";
}

const JetBrainsAiAuthMethod: AuthMethod = {
    id: "jetbrains-ai",
    name: "JetBrains AI",
    description: "Use JetBrains AI to authenticate",
    _meta: {
        "jb-proxy": {
            provider: "openai",
            restartRequired: "true"
        }
    }
}

export interface JetBrainsAiAuthRequest extends AuthenticateRequest {
    methodId: "jetbrains-ai";
    _meta: {
        "jb-proxy": {
            baseUrl: string;
            headers: Record<string, string>;
        }
    };
}

export const CodexAuthMethods: AuthMethod[] = [ApiKeyAuthMethod, ChatGptAuthMethod, JetBrainsAiAuthMethod];

export type CodexAuthRequest = ApiKeyAuthRequest | ChatGPTAuthRequest | JetBrainsAiAuthRequest;

export function isCodexAuthRequest(request: AuthenticateRequest): request is CodexAuthRequest {
    return request.methodId === "api-key" || request.methodId === "chat-gpt" || request.methodId === "jetbrains-ai";
}
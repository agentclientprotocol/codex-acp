
import type {AuthenticateRequest, AuthMethod, ClientCapabilities} from "@agentclientprotocol/sdk";

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

const GatewayAuthMethod: AuthMethod = {
    id: "gateway",
    name: "Custom model gateway",
    description: "Use a custom gateway to authenticate and access models",
    _meta: {
        "gateway": {
            protocol: "openai",
            restartRequired: "false"
        }
    }
}

export interface GatewayAuthRequest extends AuthenticateRequest {
    methodId: "gateway";
    _meta: {
        "gateway": {
            baseUrl: string;
            headers: Record<string, string>;
            providerName?: string;
        }
    };
}

export function getCodexAuthMethods(clientCapabilities?: ClientCapabilities | null): AuthMethod[] {
    const authMethods: AuthMethod[] = [ApiKeyAuthMethod, ChatGptAuthMethod];
    const supportsGatewayAuth = clientCapabilities?.auth?._meta?.["gateway"] === true;
    if (supportsGatewayAuth) {
        authMethods.push(GatewayAuthMethod);
    }
    return authMethods;
}

export type CodexAuthRequest = ApiKeyAuthRequest | ChatGPTAuthRequest | GatewayAuthRequest;

export function isCodexAuthRequest(request: AuthenticateRequest): request is CodexAuthRequest {
    return request.methodId === "api-key" || request.methodId === "chat-gpt" || request.methodId === "gateway";
}

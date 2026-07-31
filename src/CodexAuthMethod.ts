
import type {AuthenticateRequest, AuthMethod, ClientCapabilities} from "@agentclientprotocol/sdk";
import {clientSupportsUrlElicitation} from "./ElicitationCapabilities";

export const CODEX_API_KEY_ENV_VAR = "CODEX_API_KEY";
export const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";

export interface ApiKeyAuthRequest extends AuthenticateRequest {
    methodId: "api-key";
    _meta?: {
        "api-key"?: {
            apiKey: string;
        }
    } | null;
}

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

const ChatGptAuthMethod: AuthMethod = {
    id: "chat-gpt",
    name: "ChatGPT",
    description: "Use ChatGPT to authenticate"
}

export interface ChatGPTAuthRequest extends AuthenticateRequest {
    methodId: "chat-gpt";
}

const ChatGptDeviceCodeAuthMethod: AuthMethod = {
    id: "chat-gpt-device-code",
    name: "ChatGPT (device code)",
    description: "Sign in to ChatGPT by opening a verification page and entering a one-time code"
}

export interface ChatGPTDeviceCodeAuthRequest extends AuthenticateRequest {
    methodId: "chat-gpt-device-code";
}

export const GatewayAuthMethod = {
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

export function getCodexAuthMethods(clientCapabilities?: ClientCapabilities | null, env: NodeJS.ProcessEnv = process.env): AuthMethod[] {
    const authMethods: AuthMethod[] = [ApiKeyAuthMethod];
    if (!env["NO_BROWSER"]) {
        authMethods.push(ChatGptAuthMethod);
    }
    if (clientSupportsUrlElicitation(clientCapabilities)) {
        authMethods.push(ChatGptDeviceCodeAuthMethod);
    }
    const supportsGatewayAuth = clientCapabilities?.auth?._meta?.["gateway"] === true;
    if (supportsGatewayAuth) {
        authMethods.push(GatewayAuthMethod);
    }
    return authMethods;
}

export type CodexAuthRequest = ApiKeyAuthRequest | ChatGPTAuthRequest | ChatGPTDeviceCodeAuthRequest | GatewayAuthRequest;

export function isCodexAuthRequest(request: AuthenticateRequest): request is CodexAuthRequest {
    return request.methodId === "api-key" || request.methodId === "chat-gpt" || request.methodId === "chat-gpt-device-code" || request.methodId === "gateway";
}

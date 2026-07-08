import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {UserInputHandler} from "./CodexAppServerClient";
import type {
    ToolRequestUserInputOption,
    ToolRequestUserInputParams,
    ToolRequestUserInputQuestion,
    ToolRequestUserInputResponse,
} from "./app-server/v2";
import type {AcpClientConnection} from "./ACPSessionConnection";
import {logger} from "./Logger";

type UserInputOption = {
    option: acp.PermissionOption;
    answer: string;
};

export class CodexUserInputHandler implements UserInputHandler {
    private readonly connection: AcpClientConnection;
    private readonly sessionState: SessionState;
    private readonly cancellationSignal: AbortSignal | undefined;

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        cancellationSignal?: AbortSignal,
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
        this.cancellationSignal = cancellationSignal;
    }

    async handleUserInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
        const question = this.singleOptionQuestion(params);
        const options = this.buildOptions(question);
        const response = await this.connection.request(
            acp.methods.client.session.requestPermission,
            this.buildPermissionRequest(params, question, options),
            this.requestOptions(),
        );
        return this.convertResponse(question, options, response);
    }

    private requestOptions(): acp.SendRequestOptions | undefined {
        return this.cancellationSignal ? {cancellationSignal: this.cancellationSignal} : undefined;
    }

    private singleOptionQuestion(params: ToolRequestUserInputParams): ToolRequestUserInputQuestion {
        if (params.questions.length !== 1) {
            throw new Error(`Unsupported request_user_input shape: expected exactly one question, got ${params.questions.length}`);
        }
        const question = params.questions[0];
        if (!question) {
            throw new Error("Unsupported request_user_input shape: expected a question");
        }
        if (question.options === null || question.options.length === 0) {
            throw new Error(`Unsupported request_user_input shape for question ${question.id}: options are required`);
        }
        if (question.isSecret) {
            throw new Error(`Unsupported request_user_input shape for question ${question.id}: secret answers are not supported`);
        }
        return question;
    }

    private buildPermissionRequest(
        params: ToolRequestUserInputParams,
        question: ToolRequestUserInputQuestion,
        options: UserInputOption[],
    ): acp.RequestPermissionRequest {
        return {
            sessionId: this.sessionState.sessionId,
            toolCall: {
                toolCallId: params.itemId,
                kind: "other",
                status: "pending",
                title: this.title(question),
                rawInput: params,
                content: [{ type: "content", content: { type: "text", text: this.content(question) } }],
            },
            options: options.map(({option}) => option),
            _meta: {
                codex: {
                    request_user_input: {
                        threadId: params.threadId,
                        turnId: params.turnId,
                        itemId: params.itemId,
                        autoResolutionMs: params.autoResolutionMs,
                    },
                },
            },
        };
    }

    private convertResponse(
        question: ToolRequestUserInputQuestion,
        options: UserInputOption[],
        response: acp.RequestPermissionResponse,
    ): ToolRequestUserInputResponse {
        if (response.outcome.outcome === "cancelled") {
            return { answers: {} };
        }
        const optionId = "optionId" in response.outcome ? response.outcome.optionId : null;
        const selected = options.find(({option}) => option.optionId === optionId);
        if (!selected) {
            logger.error("Unknown request_user_input option selected", {
                optionId,
                questionId: question.id,
            });
            return { answers: {} };
        }
        return {
            answers: {
                [question.id]: {
                    answers: [selected.answer],
                },
            },
        };
    }

    private buildOptions(question: ToolRequestUserInputQuestion): UserInputOption[] {
        return question.options!.map((questionOption, index) => {
            const optionId = `${question.id}:${index}`;
            return {
                option: {
                    optionId,
                    name: questionOption.label,
                    kind: this.optionKind(questionOption),
                    _meta: {
                        codex: {
                            questionId: question.id,
                            optionIndex: index,
                            label: questionOption.label,
                            description: questionOption.description,
                        },
                    },
                },
                answer: questionOption.label,
            };
        });
    }

    private title(question: ToolRequestUserInputQuestion): string {
        const header = question.header.trim();
        return header.length > 0 ? header : "Request input";
    }

    private content(question: ToolRequestUserInputQuestion): string {
        const lines = [question.question];
        for (const option of question.options ?? []) {
            const description = option.description.trim();
            lines.push(description.length > 0 ? `${option.label}: ${description}` : option.label);
        }
        return lines.join("\n");
    }

    private optionKind(option: ToolRequestUserInputOption): acp.PermissionOptionKind {
        const label = option.label.toLowerCase();
        if (
            label.includes("remember") ||
            label.includes("always") ||
            label.includes("don't ask") ||
            label.includes("dont ask") ||
            label.includes("for this session")
        ) {
            return "allow_always";
        }
        if (
            label.includes("cancel") ||
            label.includes("reject") ||
            label.includes("deny") ||
            label.includes("decline") ||
            label === "no" ||
            label.startsWith("no,") ||
            label.startsWith("no ")
        ) {
            return "reject_once";
        }
        return "allow_once";
    }
}

import type {SessionSteerRequest, SessionSteeringResponse} from "./AcpExtensions";

interface QueuedSteering {
    params: SessionSteerRequest;
    resolve: (response: SessionSteeringResponse) => void;
    reject: (error: unknown) => void;
}

/**
 * Serialises steering requests for a single session. Callers add a request via
 * enqueue(); a single consumer loop runs them one at a time, in arrival order,
 * so two concurrent steers can never race to start rival turns.
 */
export class SteeringQueue {
    private readonly pending: QueuedSteering[] = [];
    private processing = false;

    constructor(
        private readonly handle: (params: SessionSteerRequest) => Promise<SessionSteeringResponse>,
    ) {}

    enqueue(params: SessionSteerRequest): Promise<SessionSteeringResponse> {
        return new Promise<SessionSteeringResponse>((resolve, reject) => {
            this.pending.push({params, resolve, reject});
            this.startConsumer();
        });
    }

    /** No request is queued and the consumer is not running. */
    get isIdle(): boolean {
        return !this.processing && this.pending.length === 0;
    }

    private startConsumer(): void {
        if (this.processing) {
            return; // consumer already draining the queue
        }
        this.processing = true;
        void this.consume();
    }

    private async consume(): Promise<void> {
        try {
            while (this.pending.length > 0) {
                const next = this.pending.shift()!;
                try {
                    next.resolve(await this.handle(next.params));
                } catch (error) {
                    next.reject(error); // one failed steer must not stall the rest
                }
            }
        } finally {
            this.processing = false;
        }
    }
}

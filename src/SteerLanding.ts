import type * as acp from "@agentclientprotocol/sdk/unstable";

export type SteerLandingResult = {kind: "inserted"} | {kind: "ended"; cancelled: boolean};

/** Tracks insertion independently of the turn/steer response. */
export class SteerLanding {
    readonly result: Promise<SteerLandingResult>;
    private resolve: (result: SteerLandingResult) => void = () => {};

    constructor(readonly sessionId: string, readonly turnId: string, readonly prompt: acp.ContentBlock[]) {
        this.result = new Promise(resolve => { this.resolve = resolve; });
    }

    inserted(): void { this.resolve({kind: "inserted"}); }
    ended(cancelled: boolean): void { this.resolve({kind: "ended", cancelled}); }
}

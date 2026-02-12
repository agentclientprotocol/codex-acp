import type {RateLimitSnapshot} from "./app-server/v2";

export type RateLimitEntry = {
    limitId: string;
    limitName: string;
    snapshot: RateLimitSnapshot;
};

export type RateLimitsMap = Map<string, RateLimitEntry>;
